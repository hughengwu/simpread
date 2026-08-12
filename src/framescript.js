/**
 * SimpRead frame agent
 *
 * Runs in every sub frame ( all_frames: true ) so the top frame can reach content it
 * cannot touch directly: a cross origin frame's contentDocument is null, and jQuery
 * .find() / cloneNode() both stop at the frame boundary.
 *
 * This file is deliberately plain, dependency free ES5-ish JavaScript and is copied
 * verbatim by CopyWebpackPlugin rather than bundled. It must NOT become a webpack
 * entry: CommonsChunkPlugin( { names: [ 'vendors', 'common' ], minChunks: Infinity } )
 * factors the module runtime into common.js, so any bundled entry drags 235KB behind
 * it. The three real content scripts total ~1.25MB, which is exactly what must never
 * be loaded into every ad slot on the page.
 *
 * Protocol, namespace "simpread-frame", every message carries the token the top frame
 * issued for this frame element:
 *
 *   down  probe    { token }
 *   up    metrics  { token, url, title, textLen, linkLen, paras, semantic }
 *   down  fetch    { token, include }        include optional, from a site rule
 *   up    content  { token, url, title, html, truncated }
 *   up    error    { token, why }
 *   down  pick     { token }                 arm the manual picker in this frame
 *   down  pickoff  { token }                 disarm it, some other frame won
 *   up    pickenter{ token }                 pointer moved into this frame, throttled
 *   up    picked   { token, url, title, html }
 *   up    pickcancel { token }               Esc pressed in here, where the top frame
 *                                            can not see it
 *
 * The top frame addresses a frame by posting to the element's contentWindow, so it can
 * probe a grandchild directly as long as some ancestor chain is same origin enough for
 * it to hold the element. The reply, though, only ever goes to window.parent — hence
 * the forwarding branch below, which relays anything in our namespace one hop upward.
 *
 * targetOrigin is "*" throughout: the frame's origin is unknown by construction. Going
 * down that discloses only a random token; coming up it discloses only content the
 * frame already owns. The token is what stops page scripts forging metrics for a frame
 * they do not control.
 */
( function () {
    "use strict";

    // the top frame runs the real content script; only sub frames need an agent
    if ( window.top === window ) return;

    var NS       = "simpread-frame",
        MAX_HTML = 2 * 1024 * 1024,   // cap what a single frame may ship upward
        PARA_MIN = 40,                // chars; mirrors iframe.js rank()
        SEMANTIC = "article, main, [itemprop='articleBody'], [role='main']",

        // mirrors PICK_CSS in src/service/iframe.js; this document does not inherit the
        // top page's stylesheets, so the rule has to come with the picker
        PICK_CLASS = "simpread-highlight-selector",
        PICK_CSS   = ".simpread-highlight-selector{background-color:#fafafa!important;" +
                     "outline:3px dashed #1976d2!important;opacity:.8!important;" +
                     "cursor:pointer!important;transition:opacity .5s ease!important;}",

        // teardown for the currently armed picker, null when not picking
        pickStop = null;

    /**
     * Content signals for this document
     *
     * Same shape and thresholds as rank() in src/service/iframe.js — the top frame
     * applies one scoring formula to same origin and cross origin frames alike, so
     * these have to be computed the same way on both sides.
     *
     * @return {object} metrics
     */
    function metrics() {
        var body    = document.body,
            text    = body ? ( body.innerText || body.textContent || "" ).trim() : "",
            links   = body ? body.querySelectorAll( "a" ) : [],
            block   = body ? body.querySelectorAll( "p, li" ) : [],
            linkLen = 0,
            paras   = 0,
            i;

        for ( i = 0; i < links.length; i++ ) linkLen += ( links[i].textContent || "" ).length;
        for ( i = 0; i < block.length; i++ ) {
            if (( block[i].textContent || "" ).trim().length >= PARA_MIN ) paras++;
        }

        return {
            url     : location.href,   // authoritative: a JS navigated frame's src attribute goes stale
            title   : document.title || "",
            textLen : text.length,
            linkLen : linkLen,
            paras   : paras,
            semantic: document.querySelector( SEMANTIC ) ? 1.35 : 1,
        };
    }

    /**
     * Resolve a site rule's `include` locally
     *
     * Only the two forms that survive an origin boundary. [[{jquery}]] / [['text']] /
     * [[/regexp/]] store code bound to a document and there is no context to inject, so
     * they are reported unsupported and the top frame falls through to Readability.
     *
     * @param  {string} include value
     * @return {string} html, undefined on a miss, or false when the form is unsupported
     */
    function resolve( include ) {
        var value = ( include || "" ).trim(), xpath, node, found, html, i;

        if ( value === "" ) return undefined;

        if ( value.indexOf( "[[" ) === 0 ) {
            if ( !( value.indexOf( "[[`" ) === 0 && value.slice( -3 ) === "`]]" )) return false;
            xpath = value.replace( /^\[\[`|`\]\]$/g, "" );
            try {
                node = document.evaluate( xpath, document, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null ).singleNodeValue;
            } catch ( error ) {
                return undefined;
            }
            return node ? node.innerHTML.trim() : undefined;
        }

        try {
            found = document.querySelectorAll( value );
        } catch ( error ) {
            return undefined;
        }
        if ( found.length === 0 ) return undefined;
        if ( found.length === 1 ) return found[0].innerHTML.trim();

        // mirrors M() in puread: multiple matches are concatenated
        html = [];
        for ( i = 0; i < found.length; i++ ) html.push( found[i].innerHTML );
        return html.join( "<br>" ).trim();
    }

    function reply( message ) {
        try {
            window.parent.postMessage( message, "*" );
        } catch ( error ) {}
    }

    function mark( el, on ) {
        if ( !el || !el.classList ) return;
        on ? el.classList.add( PICK_CLASS ) : el.classList.remove( PICK_CLASS );
    }

    /**
     * Arm the manual picker in this frame
     *
     * The top document can not do this itself: mouse events over a frame are delivered
     * to the frame's own document and never surface upstairs, so without an agent side
     * picker frame content simply can not be selected. @see pick() in iframe.js
     *
     * Capturing listeners so the page's own handlers can not swallow the click, and the
     * click is cancelled — while picking, a click means "this element", not "follow this
     * link".
     */
    function pickOn( token ) {
        pickOff();

        var style   = document.createElement( "style" ),
            prev    = null,
            entered = 0;

        style.textContent = PICK_CSS;
        ( document.head || document.documentElement ).appendChild( style );

        function move( event ) {
            var now = Date.now();
            // throttled: the top picker only needs to know the pointer has left it
            if ( now - entered > 400 ) {
                entered = now;
                reply({ ns: NS, type: "pickenter", token: token });
            }
            mark( prev, false );
            prev = event.target;
            mark( prev, true );
        }

        function click( event ) {
            event.preventDefault();
            event.stopPropagation();

            var el   = event.target,
                html = el && el.innerHTML ? el.innerHTML : "";

            mark( el, false );
            pickOff();
            reply({
                ns   : NS,
                type : "picked",
                token: token,
                url  : location.href,
                title: document.title || "",
                html : html.length > MAX_HTML ? html.slice( 0, MAX_HTML ) : html,
            });
        }

        // Esc while the focus sits in here never reaches the top frame's own keydown
        // handler, so the cancel has to be reported explicitly
        function escape( event ) {
            if ( event.keyCode !== 27 ) return;
            event.preventDefault();
            pickOff();
            reply({ ns: NS, type: "pickcancel", token: token });
        }

        document.addEventListener( "mousemove", move, true );
        document.addEventListener( "click", click, true );
        document.addEventListener( "keydown", escape, true );

        pickStop = function () {
            document.removeEventListener( "mousemove", move, true );
            document.removeEventListener( "click", click, true );
            document.removeEventListener( "keydown", escape, true );
            mark( prev, false );
            prev = null;
            if ( style.parentNode ) style.parentNode.removeChild( style );
            pickStop = null;
        };
    }

    function pickOff() {
        if ( pickStop ) pickStop();
    }

    window.addEventListener( "message", function ( event ) {
        var data = event.data, out, html;

        if ( !data || data.ns !== NS || !data.token ) return;

        // a descendant answered; pass it one hop up toward the top frame
        if ( data.type === "metrics"   || data.type === "content" || data.type === "error" ||
             data.type === "pickenter" || data.type === "picked"  || data.type === "pickcancel" ) {
            reply( data );
            return;
        }

        if ( data.type === "pick" ) {
            pickOn( data.token );
            return;
        }

        if ( data.type === "pickoff" ) {
            pickOff();
            return;
        }

        if ( data.type === "probe" ) {
            out       = metrics();
            out.ns    = NS;
            out.type  = "metrics";
            out.token = data.token;
            reply( out );
            return;
        }

        if ( data.type === "fetch" ) {
            var resolved = false;
            if ( data.include ) {
                html = resolve( data.include );
                if ( html === false ) {
                    reply({ ns: NS, type: "error", token: data.token, why: "unsupported include form" });
                    return;
                }
                resolved = !!html;
            }
            // no include, or the rule missed: ship the whole document and let the top
            // frame run Readability over it
            if ( !html ) html = document.documentElement ? document.documentElement.outerHTML : "";

            reply({
                ns       : NS,
                type     : "content",
                token    : data.token,
                url      : location.href,
                title    : document.title || "",
                // true only when the rule actually matched, so the top frame knows the
                // html is already an article body and must not be re-guessed
                resolved : resolved,
                html     : html.length > MAX_HTML ? html.slice( 0, MAX_HTML ) : html,
                truncated: html.length > MAX_HTML,
            });
        }
    }, false );
}() );
