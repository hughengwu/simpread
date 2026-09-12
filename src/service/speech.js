console.log( "=== simpread speech load ===" )

import { storage }  from 'storage';
import { browser }  from 'browser';
import * as msg     from 'message';

/**
 * Reading the article out loud, in the page.
 *
 * The voice itself comes from the worker — @see service/edgetts.js — because only the
 * worker can open the socket. This half is everything that has to happen where the
 * article is: splitting it into utterances, keeping one playing after another, showing
 * which one is being spoken, and pausing.
 *
 * Playback goes through Web Audio rather than an <audio> element on purpose. The element
 * would be a child of the host page's document and so subject to its media-src, and a
 * fair number of sites ship a policy that forbids blob: outright; decodeAudioData is not
 * a fetch, so no CSP applies to it. It also means no object URLs to revoke.
 *
 * Two engines, one loop:
 *
 *   edge  — Microsoft's Read Aloud voices, the good ones, but a network that will not
 *           pass the websocket takes them away entirely ( @see fail() )
 *   local — chrome.tts, i.e. whatever voices the OS has. Always available, so it is what
 *           `edge` falls back to rather than failing the whole feature.
 *
 * The worker drives chrome.tts, so `local` costs one message out per utterance and one
 * back when it ends. That is the price of keeping highlight, pause and stop behaving the
 * same way whichever engine is speaking.
 */

const CLASS   = "simpread-speech-current",
      // an utterance longer than this takes too long to synthesize before the first
      // sound, and highlights too coarse a chunk of the page
      MAX_LEN = 220,
      BLOCK   = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, figcaption, td";

const STATE = {
    idle    : "idle",
    loading : "loading",
    playing : "playing",
    paused  : "paused",
};

let state    = STATE.idle,
    segments = [],
    index    = 0,
    // bumped on every stop so that an in-flight synthesis, or a source that ends late,
    // cannot drive a session that is already over
    session  = 0,
    engine   = "",
    context,
    source,
    listening = false;

const cache = {};

/* ------------------------------------------------------------------- settings -- */

/**
 * @return {object} { voice, rate, engine }; the fallbacks match edgetts.DEFAULT, and are
 *                  only reached before the settings panel has ever been opened
 */
function settings() {
    const saved = ( storage.secret || {} ).edgetts || {};
    return {
        voice : saved.voice  || "zh-CN-XiaoxiaoNeural",
        rate  : saved.rate   || "+0%",
        engine: saved.engine || "edge",
    };
}

// SSML says rate as a percent offset, chrome.tts as a multiplier
function multiplier( rate ) {
    const percent = parseInt( rate, 10 );
    return isNaN( percent ) ? 1 : Math.min( Math.max( 1 + percent / 100, 0.1 ), 10 );
}

/* ------------------------------------------------------------------- segments -- */

/**
 * Split the rendered article into utterances.
 *
 * Only leaf blocks are taken: an <li> inside a <blockquote> would otherwise be spoken
 * twice, once as itself and once as part of its ancestor. Anything with no block
 * descendant is a leaf, and content with no blocks at all ( plain text in the root, which
 * is what txtread produces ) falls back to the root itself.
 */
function collect() {
    const $content = $( "sr-rd-content" ),
          list     = [],
          title    = $( "sr-rd-title" ).text().trim();

    title != "" && list.push({ el: $( "sr-rd-title" )[0], text: title });

    let $blocks = $content.find( BLOCK ).filter(( idx, el ) => $( el ).find( BLOCK ).length == 0 );
    $blocks.length == 0 && ( $blocks = $content );

    $blocks.each(( idx, el ) => {
        const text = ( el.innerText || el.textContent || "" ).replace( /\s+/g, " " ).trim();
        text != "" && split( text ).forEach( piece => list.push({ el, text: piece }) );
    });

    return list;
}

/**
 * Break a long block at sentence ends, and only mid sentence when one runs past the limit
 * on its own.
 *
 * Written as a scan rather than a split on /(?<=[。！？])/ because babylon 6 cannot parse
 * a lookbehind — the build fails outright rather than at run time.
 */
function split( text ) {
    if ( text.length <= MAX_LEN ) return [ text ];

    const ENDERS = "。！？!?；;…\n",
          pieces = [];
    let buffer = "", sentence = "";

    const flush = () => { buffer.trim() != "" && pieces.push( buffer ); buffer = ""; },
          take  = () => {
            if ( sentence == "" ) return;
            while ( sentence.length > MAX_LEN ) {
                flush();
                let cut = MAX_LEN;
                // never cut a surrogate pair in half
                const lead = sentence.charCodeAt( cut - 1 );
                lead >= 0xD800 && lead <= 0xDBFF && cut--;
                pieces.push( sentence.slice( 0, cut ) );
                sentence = sentence.slice( cut );
            }
            buffer.length + sentence.length > MAX_LEN && flush();
            buffer  += sentence;
            sentence = "";
          };

    for ( let i = 0; i < text.length; i++ ) {
        sentence += text[i];
        ENDERS.indexOf( text[i] ) != -1 && take();
    }
    take();
    flush();

    return pieces.filter( piece => piece.trim() != "" );
}

/* ------------------------------------------------------------------ highlight -- */

function mark( idx ) {
    unmark();
    const item = segments[ idx ];
    if ( !item || !item.el ) return;
    $( item.el ).addClass( CLASS );
    const box = item.el.getBoundingClientRect();
    ( box.top < 60 || box.bottom > window.innerHeight - 60 ) &&
        item.el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function unmark() {
    $( "." + CLASS ).removeClass( CLASS );
}

/* ---------------------------------------------------------------- edge engine -- */

/**
 * Ask the worker for one utterance. Results are memoized so the prefetch below and the
 * play that follows it share a single round trip.
 */
function synth( idx ) {
    if ( cache[ idx ] ) return cache[ idx ];
    const item = segments[ idx ];
    if ( !item ) return Promise.reject({ failed: "empty", message: "没有可朗读的内容。" });

    const { voice, rate } = settings();
    cache[ idx ] = new Promise(( resolve, reject ) => {
        browser.runtime.sendMessage(
            msg.Add( msg.MESSAGE_ACTION.speak_synth, { text: item.text, voice, rate }),
            result => {
                if ( browser.runtime.lastError ) {
                    return reject({ failed: "dropped", message: browser.runtime.lastError.message });
                }
                result && result.done ? resolve( result.done )
                                      : reject( ( result && result.fail ) || { failed: "dropped" } );
            });
    });
    // a rejection must not be remembered: the retry, possibly on the other engine, would
    // inherit it
    cache[ idx ].catch( () => { delete cache[ idx ]; });
    return cache[ idx ];
}

function decode( base64 ) {
    const binary = atob( base64 ),
          bytes  = new Uint8Array( binary.length );
    for ( let i = 0; i < binary.length; i++ ) bytes[i] = binary.charCodeAt( i );
    return context.decodeAudioData( bytes.buffer );
}

function playEdge( idx, token ) {
    state != STATE.paused && ( state = STATE.loading );
    return synth( idx )
        .then( result => decode( result.audio ) )
        .then( buffer => {
            if ( token != session ) return;
            source = context.createBufferSource();
            source.buffer = buffer;
            source.connect( context.destination );
            source.onended = () => { token == session && next( token ); };
            state = context.state == "suspended" ? STATE.paused : STATE.playing;
            source.start();
            idx + 1 < segments.length && synth( idx + 1 ).catch( () => {} );   // prefetch
        });
}

/* --------------------------------------------------------------- local engine -- */

/**
 * chrome.tts lives in the worker, so an utterance is a message out and its end a message
 * back. One listener for the module, installed the first time it is needed.
 */
function listen() {
    if ( listening ) return;
    listening = true;
    browser.runtime.onMessage.addListener( request => {
        if ( !request || request.type != msg.MESSAGE_ACTION.speak_end ) return;
        const { seq, type, reason } = request.value;
        if ( seq != session || engine != "local" ) return;
        // only a clean end advances: interrupted/cancelled means something stopped us,
        // and whoever did that decides what happens next
        type == "end"   && next( seq );
        type == "error" && fail({ failed: "dropped", message: reason == "novoice"
            ? "系统没有可用的语音引擎，请在系统设置中安装语音包，或改用微软在线语音。"
            : `系统语音引擎朗读失败。${ reason ? "（" + reason + "）" : "" }` });
    });
}

function playLocal( idx, token ) {
    listen();
    state = STATE.playing;
    browser.runtime.sendMessage( msg.Add( msg.MESSAGE_ACTION.speak, {
        content: segments[ idx ].text,
        rate   : multiplier( settings().rate ),
        seq    : token,
    }));
    return Promise.resolve();
}

/* -------------------------------------------------------------------- driving -- */

function play( idx, token ) {
    if ( token != session ) return;
    index = idx;
    mark( idx );
    ( engine == "local" ? playLocal( idx, token ) : playEdge( idx, token ) )
        .catch( error => { token == session && fail( error ); });
}

function next( token ) {
    if ( token != session ) return;
    source = undefined;
    index + 1 >= segments.length ? finish() : play( index + 1, token );
}

function finish() {
    stop();
    notify( "朗读完毕。" );
}

/**
 * A failed utterance.
 *
 * `blocked` is not retried on the same engine — the socket never opened, so every later
 * utterance fails identically. It switches to chrome.tts for the rest of the article and
 * carries on from where it stopped, which is the only outcome that leaves the reader with
 * something rather than a dead button.
 */
function fail( error ) {
    if ( error && error.failed == "blocked" && engine == "edge" ) {
        engine = "local";
        notify( `${ error.message || "无法连接微软语音服务。" }已改用系统语音继续朗读。` );
        return play( index, session );
    }
    stop();
    notify( ( error && error.message ) || "朗读失败。" );
}

function notify( content ) {
    new Notify().Render( content );
}

/* ---------------------------------------------------------------------- entry -- */

/**
 * Play, pause or resume — the one button the control bar needs.
 *
 * The AudioContext is constructed here, inside the click, because autoplay policy judges
 * a context by the gesture that created it and the first audio only arrives a round trip
 * later.
 */
function toggle() {
    if ( state == STATE.playing || state == STATE.loading ) return pause();
    if ( state == STATE.paused ) return resume();

    // The AudioContext has to be born inside the click. Autoplay policy judges a context
    // by the gesture that created it, and the first audio is a settings read plus a round
    // trip to Microsoft away — far too late to still count as user initiated.
    if ( !context || context.state == "closed" ) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        Ctx && ( context = new Ctx() );
    }
    context && context.state == "suspended" && context.resume();

    // voice and engine live on secret, which loads lazily
    storage.Safe( () => start() );
}

function start() {
    segments = collect();
    if ( segments.length == 0 ) return notify( "没有找到可朗读的正文。" );

    session = session + 1;
    index   = 0;
    engine  = context ? settings().engine : "local";
    Object.keys( cache ).forEach( key => { delete cache[ key ]; });

    notify( engine == "local" ? "开始朗读（系统语音）。" : "正在合成语音，请稍候…" );
    play( 0, session );
}

function pause() {
    if ( state != STATE.playing && state != STATE.loading ) return;
    state = STATE.paused;
    engine == "local" ? browser.runtime.sendMessage( msg.Add( msg.MESSAGE_ACTION.speak_pause ))
                      : context && context.suspend();
}

function resume() {
    if ( state != STATE.paused ) return;
    state = STATE.playing;
    engine == "local" ? browser.runtime.sendMessage( msg.Add( msg.MESSAGE_ACTION.speak_resume ))
                      : context && context.resume();
}

/**
 * Stop and forget everything. Safe to call when nothing is playing — read mode's unmount
 * does exactly that on every exit.
 */
function stop() {
    const running = state != STATE.idle;
    session  = session + 1;
    state    = STATE.idle;
    segments = [];
    index    = 0;
    Object.keys( cache ).forEach( key => { delete cache[ key ]; });
    unmark();

    if ( source ) {
        source.onended = null;
        try { source.stop(); } catch ( ignore ) {}
        source = undefined;
    }
    // leave the context open for the next run, but never suspended: a suspended context
    // resumed later would start playing whatever was queued when it was paused
    context && context.state == "suspended" && context.resume();
    running && browser.runtime.sendMessage( msg.Add( msg.MESSAGE_ACTION.speak_stop ));
}

export {
    toggle as Toggle,
    stop   as Stop,
}
