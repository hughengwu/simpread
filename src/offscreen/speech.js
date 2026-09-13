/**
 * edge-tts, spoken from the offscreen document.
 *
 * Microsoft's gateway only upgrades the socket for a User-Agent that carries `Edg/135`
 * or newer; anything else gets a bare 403. The extension rewrites the header with a
 * declarativeNetRequest session rule — @see service/edgetts.js — but Chromium does not
 * apply DNR ( or webRequest ) to a WebSocket handshake that comes from a service worker
 * ( crbug 1285664 ). An offscreen document is an ordinary extension page, the rule does
 * apply to it, and so this is where the socket has to live.
 *
 * Plain script, copied into the package as is, like sw.js: a webpack entry would depend
 * on common.js, which drags in storage and friends, and chrome.runtime is the only
 * extension API an offscreen document gets.
 *
 * Protocol, as spoken by Edge's own Read Aloud extension:
 *
 *   1. open wss://…/edge/v1 with TrustedClientToken, Sec-MS-GEC and Sec-MS-GEC-Version
 *   2. send a `speech.config` text frame naming the output format
 *   3. send an `ssml` text frame carrying the utterance
 *   4. read binary frames — 2 byte big endian header length, that many header bytes,
 *      then raw MP3 — until a `turn.end` text frame arrives
 *
 * @see https://github.com/rany2/edge-tts for the reference implementation
 */

( function () {
    "use strict";

    // must match msg.MESSAGE_ACTION.speak_offscreen; this file cannot import message.js
    const MESSAGE   = "speak_offscreen";

    const TOKEN     = "6A5AA1D4EAFF4E9FB37E23D68491D6F4",
          // tracks edge-tts; the gateway does not check it today, but it is what Edge sends
          CHROMIUM  = "143.0.3650.75",
          ENDPOINT  = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
          FORMAT    = "audio-24khz-48kbitrate-mono-mp3",
          WIN_EPOCH = 11644473600,
          TIMEOUT   = 20000;

    /**
     * `blocked` is the one callers act on: the socket never opened. The WebSocket API
     * does not expose the HTTP status, so a close before open is the whole signal, and it
     * means every later utterance will fail the same way — "switch engines", not "retry".
     */
    const FAILED = {
        blocked : "blocked",
        dropped : "dropped",
        timeout : "timeout",
        empty   : "empty",
    };

    /* ---------------------------------------------------------------------- DRM -- */

    function hex( buffer ) {
        return Array.from( new Uint8Array( buffer ))
                    .map( byte => byte.toString( 16 ).padStart( 2, "0" ))
                    .join( "" ).toUpperCase();
    }

    /**
     * Sec-MS-GEC: SHA-256 of the current Windows FILETIME tick, floored to a five minute
     * window, with the client token appended.
     *
     * The tick is seconds since 1601 in 100ns units, i.e. seconds * 1e7. That product is
     * around 1.3e17 and Number stops being exact at 9e15, so it is formed by appending
     * the seven zeros to the decimal string instead of multiplying.
     */
    function gec() {
        let secs = Math.floor( Date.now() / 1000 ) + WIN_EPOCH;
        secs -= secs % 300;
        const source = String( secs ) + "0000000" + TOKEN;
        return crypto.subtle.digest( "SHA-256", new TextEncoder().encode( source ) ).then( hex );
    }

    function uuid() {
        return crypto.randomUUID().replace( /-/g, "" );
    }

    /* ------------------------------------------------------------------- frames -- */

    // Edge's own client sends a JS Date string with GMT+0000 spelled out
    function stamp() {
        return new Date().toUTCString().replace( "GMT", "GMT+0000 (Coordinated Universal Time)" );
    }

    function config() {
        return `X-Timestamp:${ stamp() }\r\n` +
               `Content-Type:application/json; charset=utf-8\r\n` +
               `Path:speech.config\r\n\r\n` +
               `{"context":{"synthesis":{"audio":{"metadataoptions":{` +
               `"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
               `"outputFormat":"${ FORMAT }"}}}}\r\n`;
    }

    /**
     * Text is page content, so it has to be escaped: a stray < or & makes the SSML
     * unparseable and the turn comes back empty. Control characters are rejected too.
     */
    function escape( text ) {
        return String( text )
            .replace( /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " " )
            .replace( /&/g, "&amp;" )
            .replace( /</g, "&lt;" )
            .replace( />/g, "&gt;" );
    }

    function ssml( text, options, id ) {
        const body = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
                     `<voice name='${ options.voice }'>` +
                     `<prosody pitch='${ options.pitch }' rate='${ options.rate }' volume='${ options.volume }'>` +
                     escape( text ) +
                     `</prosody></voice></speak>`;
        // the trailing Z on a string that already names its zone is Edge's own bug, and
        // the service expects it
        return `X-RequestId:${ id }\r\n` +
               `Content-Type:application/ssml+xml\r\n` +
               `X-Timestamp:${ stamp() }Z\r\n` +
               `Path:ssml\r\n\r\n${ body }`;
    }

    function pathOf( frame ) {
        const head  = String( frame ).split( "\r\n\r\n" )[0],
              match = head.match( /Path:(\S+)/ );
        return match ? match[1] : "";
    }

    /* -------------------------------------------------------------------- audio -- */

    // runtime messages are JSON, so the MP3 travels as base64
    function encode( chunks, size ) {
        const bytes = new Uint8Array( size );
        let at = 0;
        chunks.forEach( chunk => { bytes.set( chunk, at ); at += chunk.length; });

        // apply() on the whole buffer overruns the argument limit somewhere north of
        // 100KB, and a minute of speech is well past that
        let binary = "";
        for ( let i = 0; i < bytes.length; i += 0x8000 ) {
            binary += String.fromCharCode.apply( null, bytes.subarray( i, i + 0x8000 ));
        }
        return btoa( binary );
    }

    /* --------------------------------------------------------------- synthesize -- */

    /**
     * Speak one piece of text, one socket per utterance: the caller prefetches the next
     * paragraph while this one plays, which hides the connection cost.
     *
     * @param  {object}  { text, voice, rate, volume, pitch }
     * @return {promise} { audio: base64 mp3, bytes } — rejects with { failed, message }
     */
    function synthesize( value ) {
        const options = Object.assign({ voice: "zh-CN-XiaoxiaoNeural", rate: "+0%", volume: "+0%", pitch: "+0Hz" }, value ),
              text    = String( options.text == undefined ? "" : options.text ).trim();

        if ( text == "" ) return Promise.reject({ failed: FAILED.empty, message: "没有可朗读的内容。" });

        return gec().then( sec => new Promise(( resolve, reject ) => {
            const id  = uuid(),
                  url = `${ ENDPOINT }?TrustedClientToken=${ TOKEN }&Sec-MS-GEC=${ sec }` +
                        `&Sec-MS-GEC-Version=1-${ CHROMIUM }&ConnectionId=${ id }`;

            let socket, opened = false, settled = false, size = 0;
            const chunks = [];

            const done = ( error, result ) => {
                if ( settled ) return;
                settled = true;
                clearTimeout( timer );
                try { socket && socket.readyState <= 1 && socket.close(); } catch ( ignore ) {}
                error ? reject( error ) : resolve( result );
            };

            const timer = setTimeout( () => done({
                failed : opened ? FAILED.timeout : FAILED.blocked,
                message: opened ? "微软语音服务响应超时。" : "无法连接微软语音服务（连接超时）。",
            }), TIMEOUT );

            try {
                socket = new WebSocket( url );
            } catch ( error ) {
                return done({ failed: FAILED.blocked, message: `无法连接微软语音服务：${ error.message }` });
            }
            socket.binaryType = "arraybuffer";

            socket.onopen = () => {
                opened = true;
                socket.send( config() );
                socket.send( ssml( text, options, id ) );
            };

            socket.onmessage = event => {
                if ( typeof event.data == "string" ) {
                    pathOf( event.data ) == "turn.end" &&
                        done( size > 0 ? null : { failed: FAILED.empty, message: "微软语音服务没有返回音频。" },
                              size > 0 ? { audio: encode( chunks, size ), bytes: size } : undefined );
                } else {
                    const head = new DataView( event.data ).getUint16( 0 ),
                          body = new Uint8Array( event.data, 2 + head );
                    chunks.push( body );
                    size += body.length;
                }
            };

            // onerror carries no detail by design, so the open flag is what separates
            // "refused the handshake" from "died midway"
            const closed = () => done( opened
                ? { failed: FAILED.dropped, message: "与微软语音服务的连接中断。" }
                : { failed: FAILED.blocked, message: "无法连接微软语音服务（握手被拒绝）。" });
            socket.onerror = closed;
            socket.onclose = closed;
        }));
    }

    /**
     * The worker connects on a named port rather than broadcasting a runtime message.
     * A broadcast reaches every extension page that is open — options, or the corb
     * iframe an export injects — and corb.html's async listener answers *every* message
     * with null on Chromes that honour promise returns, which would beat this reply to
     * the worker. Nothing else in the extension listens on onConnect.
     */
    chrome.runtime.onConnect.addListener( port => {
        if ( port.name != MESSAGE || !port.sender || port.sender.id != chrome.runtime.id ) return;
        // the worker may give up ( timeout, stop ) and disconnect first
        const reply = message => { try { port.postMessage( message ); } catch ( ignore ) {} };
        port.onMessage.addListener( value => {
            synthesize( value )
                .then ( result => reply({ done: result }) )
                .catch( error  => reply({ fail: {
                    failed : ( error && error.failed ) || FAILED.dropped,
                    message: ( error && error.message ) || String( error ),
                }}));
        });
    });
}() );
