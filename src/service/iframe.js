console.log( "=== simpread iframe load ===" )

import Notify          from 'notify';
import { storage }     from 'storage';
import { verifyHtml }  from 'util';
import * as puplugin   from 'puplugin';

/**
 * Extract article content from an <iframe> inside the current page.
 *
 * Background: the whole extraction pipeline is pinned to the top document —
 * puread's S() uses $("html").find(), Include() uses $("body").find(), xPath2Dom()
 * uses document.evaluate( x, document ) and the Readability wrapper clones the top
 * `document`. jQuery .find() and cloneNode() both stop at the <iframe> boundary, so
 * none of them can ever see frame content.
 *
 * This module works around that without touching the ( minified, vendored ) engine:
 * it resolves the content itself and hands puread a finished HTML string through
 * Newsite(), which ReadMode() emits verbatim:
 *
 *     e.include = ( "" == t.include && "" != t.html ) ? t.html : S( i, "html" )
 *
 * Two kinds of frame, one pipeline. A same origin frame is read directly. A cross origin
 * one is reached through the agent in src/framescript.js over postMessage, addressed by
 * the token stamped on its <iframe> element. Either way what travels is a *serialized*
 * payload ( { html, title, excerpt, url } ), never a DOM node — which is both what can
 * cross an origin boundary and what Newsite() wants.
 *
 * Three entry points, in increasing order of how much the user had to do:
 *
 *   enter()  automatic — score every frame, take the winner ( contentscripts.js )
 *   enter({ site })  a site rule named the frame and, optionally, the include
 *   pick()   the user points at the content themselves ( highlight.js )
 *
 * Limitations ( see docs ):
 *   - automatic detection scores an install time snapshot, refreshed on entry ( warm );
 *     a frame that mounts later still needs pick()
 *   - frames sandboxed without allow-scripts never get an agent and stay invisible
 *   - nested frames are walked to MAX_DEPTH only
 *   - in frame mode `include` supports plain CSS selectors and [[`xpath`]] only
 *   - `exclude` of the [[`xpath`]] form does not work ( Exclude() resolves it against
 *     the top document — pre existing engine behaviour )
 */

const STATE     = "iframe",        // storage.pr.state value for iframe sourced content
      FRAME_ATTR= "data-simpread-frame-id",
      NS        = "simpread-frame",// postMessage namespace, @see src/framescript.js

      MAX_DEPTH = 2,               // how deep to walk nested frames
      MAX_FRAMES= 30,              // total frames visited, guards against frame bombs
      MAX_SCORED= 8,               // how many phase 1 survivors get scored
      MIN_SIDE  = 250,             // px; kills 300x250 / 728x90 / 160x600 ad slots
      MIN_TEXT  = 400,             // chars; aligns with Readability DEFAULT_CHAR_THRESHOLD
      MIN_SCORE = 3000,            // ~400 chars of pure prose in a decently sized frame
      FETCH_WAIT= 8000,            // ms to wait for a frame's content before giving up
      PROBE_AGAIN= 1500,           // ms; second probe round, catches late mounted frames
      PROBE_WAIT= 300,             // ms; how long a re-probe waits for agents to answer

      // Same class the top document's picker uses ( @see src/service/highlight.js ). The
      // rule itself has to be duplicated because a frame document does not inherit the
      // top page's stylesheets, and highlight.js can not export it here without turning
      // the highlight -> iframe import into a cycle.
      PICK_CLASS= "simpread-highlight-selector",
      PICK_CSS  = `.${ "simpread-highlight-selector" }{background-color:#fafafa!important;` +
                  `outline:3px dashed #1976d2!important;opacity:.8!important;` +
                  `cursor:pointer!important;transition:opacity .5s ease!important;}`;

let frame_seed = 0;

/**
 * Metrics reported by cross origin frame agents, keyed by the token stamped on the
 * frame element. Populated asynchronously by probing, which is why probing has to run
 * ahead of time: has() is called from synchronous branch conditions and can only read
 * what has already arrived.
 */
const reported = new Map();

/**
 * Deferreds waiting on a `content` reply, keyed by token
 */
const pending  = new Map();

/**
 * Cross origin frames currently running a manual picker, keyed by token
 * @see pick
 */
const picking  = new Map();

/**
 * Element.matches with legacy fallbacks
 *
 * @param  {element} target
 * @param  {string}  css selector
 * @return {boolean}
 */
function matches( el, selector ) {
    const fn = el.matches || el.webkitMatchesSelector || el.msMatchesSelector;
    if ( !fn ) return false;
    try {
        return fn.call( el, selector );
    } catch ( error ) {
        return false;
    }
}

/**
 * Same origin accessible document of a frame element, or undefined
 *
 * Chrome returns null for cross origin frames, Firefox can throw.
 *
 * @param  {element}  <iframe> or <frame>
 * @return {document} undefined when not reachable
 */
function frameDocument( el ) {
    let doc;
    try {
        doc = el.contentDocument;
    } catch ( error ) {
        return undefined;
    }
    return doc && doc.body ? doc : undefined;
}

/**
 * Stamp a frame element with a stable, unguessable handle
 *
 * The token doubles as the anti-spoof secret: a page script that cannot read the
 * attribute cannot forge metrics for a frame it does not control. crypto.randomUUID is
 * not available in every Chrome this build targets, hence the manual composition.
 *
 * @param  {element} frame element
 * @return {string}  token
 */
function tokenFor( el ) {
    let token = el.getAttribute( FRAME_ATTR );
    if ( !token ) {
        token = `sr-frame-${ ++frame_seed }-${ Math.random().toString( 36 ).slice( 2, 10 ) }`;
        el.setAttribute( FRAME_ATTR, token );
    }
    return token;
}

/**
 * Ask every cross origin frame for its metrics
 *
 * Same origin frames are read directly and are deliberately not probed. Runs on
 * install and again shortly after, then on every manual invocation, so the registry is
 * warm by the time a synchronous has() consults it.
 *
 * @return {number} how many probes went out, so a caller knows whether waiting for
 *                  replies can possibly change anything
 */
function probeAll( root = document, depth = 0 ) {
    if ( depth >= MAX_DEPTH ) return 0;

    const frames = root.querySelectorAll( "iframe, frame" );
    let sent = 0;

    for ( let i = 0; i < frames.length; i++ ) {
        const el  = frames[i],
              doc = frameDocument( el );
        if ( doc ) {
            // reachable directly; recurse for any cross origin grandchildren
            sent += probeAll( doc, depth + 1 );
            continue;
        }
        try {
            if ( el.contentWindow ) {
                el.contentWindow.postMessage( { ns: NS, type: "probe", token: tokenFor( el ) }, "*" );
                sent++;
            }
        } catch ( error ) {}
    }

    return sent;
}

/**
 * Re-probe and give the agents a moment to answer
 *
 * The registry is a snapshot: install() probes at document_end and once more 1.5s later.
 * A frame that was still loading then reports an empty document, scores 0 and stays that
 * way forever — the frame looks present to has() but is never selectable, which surfaces
 * as "the fallback triggers and then says it found nothing". Refreshing before anything
 * is scored is what makes a slow frame usable.
 *
 * @return {promise} resolve()
 */
function warm() {
    const dtd = $.Deferred();
    probeAll() > 0 ? setTimeout( () => dtd.resolve(), PROBE_WAIT ) : dtd.resolve();
    return dtd;
}

/**
 * window message handler for frame agent replies
 */
function onMessage( event ) {
    const data = event.data;
    if ( !data || data.ns != NS || !data.token ) return;

    if ( data.type == "metrics" ) {
        reported.set( data.token, data );
        return;
    }

    // manual picking, @see pick
    if ( data.type == "pickenter" || data.type == "picked" || data.type == "pickcancel" ) {
        const entry = picking.get( data.token );
        if ( !entry ) return;
        if ( data.type == "pickenter" ) {
            entry.onEnter && entry.onEnter();
            return;
        }
        picking.delete( data.token );
        data.type == "pickcancel" ?
            entry.onCancel && entry.onCancel() :
            entry.onPick( remotePayload( data, entry.item ));
        return;
    }

    const dtd = pending.get( data.token );
    if ( !dtd ) return;
    pending.delete( data.token );

    data.type == "content" && data.html ?
        dtd.resolve( data ) :
        dtd.reject( data.why || "frame returned no content" );
}

/**
 * Start listening and warm the registry. Called once from contentscripts.js.
 */
function install() {
    window.addEventListener( "message", onMessage, false );
    probeAll();
    setTimeout( () => probeAll(), PROBE_AGAIN );
}

/**
 * Current url of a frame, preferring the live location ( a JS navigated frame's
 * `src` attribute goes stale )
 *
 * @param  {element} frame element
 * @param  {document} same origin document or undefined
 * @return {string}
 */
function frameURL( el, doc ) {
    if ( doc && doc.URL ) return doc.URL;
    try {
        if ( el.contentWindow && el.contentWindow.location ) return el.contentWindow.location.href;
    } catch ( error ) {}
    return el.src || "";
}

/**
 * Is the page laid out right now?
 *
 * Read mode hides the original page with `body { display: none }`, which collapses
 * every frame in it to a 0x0 rect. The manual controlbar entry runs in exactly that
 * state, so geometry has to be treated as unavailable rather than as "tiny" — otherwise
 * the size filter rejects every frame on the page and the entry can never do anything.
 *
 * @return {boolean}
 */
function measurable() {
    const body = document.body;
    if ( !body ) return false;
    const style = window.getComputedStyle( body );
    return style.display != "none" && style.visibility != "hidden";
}

/**
 * Phase 1: cheap structural filter over all frames of a document
 *
 * Rejects our own UI, invisible/tiny frames and everything cross origin. That last
 * check is why no ad/social blocklist is needed — DoubleClick, AdSense, Disqus,
 * YouTube and Twitter embeds are cross origin by construction.
 *
 * @param  {document} root document to scan
 * @param  {number}   current nesting depth
 * @param  {array}    accumulator
 * @param  {boolean}  whether rects mean anything, @see measurable
 * @return {array}    candidate descriptors
 */
function collect( root, depth = 0, acc = [], sized = measurable() ) {
    if ( depth >= MAX_DEPTH || acc.length >= MAX_FRAMES ) return acc;

    const frames = root.querySelectorAll( "iframe, frame" );

    for ( let i = 0; i < frames.length; i++ ) {
        if ( acc.length >= MAX_FRAMES ) break;

        const el = frames[i];

        // our own UI: the read root and the CORB loader from output.js
        if ( el.id == "sr-corb" || $( el ).closest( ".simpread-read-root" ).length > 0 ) continue;

        const rect = el.getBoundingClientRect();
        if ( sized && ( rect.width < MIN_SIDE || rect.height < MIN_SIDE )) continue;

        // still meaningful with the page hidden: getComputedStyle reports the element's
        // own value, not the ancestor that is doing the hiding
        const style = root.defaultView ? root.defaultView.getComputedStyle( el ) : undefined;
        if ( style && ( style.display == "none" || style.visibility == "hidden" )) continue;

        const doc   = frameDocument( el ),
              token = tokenFor( el ),
              // cross origin: usable only once its agent has answered a probe
              stats = doc ? undefined : reported.get( token );

        if ( !doc && !stats ) continue;

        acc.push({
            id        : token,
            el,                              // always present: the element is ours
            doc,                             // present only when sameOrigin === true
            stats,                           // present only when sameOrigin === false
            url       : doc ? frameURL( el, doc ) : stats.url,
            area      : sized ? rect.width * rect.height : -1,   // -1: unknown
            sameOrigin: !!doc,
            textLen   : 0,
            score     : 0,
        });

        doc && collect( doc, depth + 1, acc, sized );
    }

    return acc;
}

/**
 * Phase 2: content scoring
 *
 * score = textLen * (1 - linkDensity) * (1 + min(paras,20)/20) * semantic * areaW
 *
 * - (1 - linkDensity) demotes same origin nav / sidebar / related-article frames,
 *   which are the realistic false positives once cross origin frames are gone
 * - paras separates prose from tabular / UI frames, capped so a huge nav frame
 *   cannot win on count alone
 * - areaW is clamped to [0.5, 1] so size only nudges: a narrow but text dense
 *   frame can still win
 *
 * @param  {object} candidate descriptor, mutated in place
 * @return {number} score
 */
function rank( item ) {
    // A cross origin frame computed these itself, in framescript.js, to the same
    // definitions; a same origin one is measured here. One formula either way, so a
    // frame does not win or lose merely by which side of an origin boundary it sits on.
    const signals = item.sameOrigin ? measure( item.doc ) : item.stats;

    item.textLen = signals.textLen;
    if ( item.textLen < MIN_TEXT ) return item.score = 0;

    const linkDensity = Math.min( signals.linkLen / item.textLen, 0.95 ),
          viewport    = Math.max( window.innerWidth * window.innerHeight, 1 ),
          // area -1 means the page was not laid out when it was collected; no size
          // signal is better than a fake penalty, so weight it neutrally
          areaW       = item.area < 0 ? 1 : Math.min( 1, item.area / ( 0.15 * viewport )) * 0.5 + 0.5;

    return item.score = item.textLen * ( 1 - linkDensity ) *
                        ( 1 + Math.min( signals.paras, 20 ) / 20 ) * signals.semantic * areaW;
}

/**
 * Content signals for a reachable document
 *
 * Kept identical to metrics() in src/framescript.js — if one side drifts, cross origin
 * and same origin frames stop being comparable.
 *
 * @param  {document} same origin document
 * @return {object}   { textLen, linkLen, paras, semantic }
 */
function measure( doc ) {
    const text  = ( doc.body.innerText || doc.body.textContent || "" ).trim(),
          links = doc.body.querySelectorAll( "a" ),
          block = doc.body.querySelectorAll( "p, li" );

    let linkLen = 0, paras = 0;
    for ( let i = 0; i < links.length; i++ ) linkLen += ( links[i].textContent || "" ).length;
    for ( let i = 0; i < block.length; i++ ) {
        ( block[i].textContent || "" ).trim().length >= 40 && paras++;
    }

    return {
        textLen : text.length,
        linkLen,
        paras,
        semantic: doc.querySelector( "article, main, [itemprop='articleBody'], [role='main']" ) ? 1.35 : 1,
    };
}

/**
 * All scored candidates, best first
 *
 * @return {array} candidate descriptors
 */
function candidates() {
    const found = collect( document );
    found.slice( 0, MAX_SCORED ).forEach( item => rank( item ));
    return found.sort( ( a, b ) => b.score - a.score );
}

/**
 * Is there at least one viable frame?
 *
 * Deliberately looser and cheaper than detect() — phase 1 only — because it only
 * decides whether the fallback is *offered*.
 *
 * @return {boolean}
 */
function has() {
    return collect( document ).length > 0;
}

/**
 * Match a candidate against a site rule's `frame` field
 *
 * Two forms, discriminated by shape:
 *   - [[/regexp/]]  tested against the frame url ( same convention puread uses for
 *                   site url matching )
 *   - anything else treated as a CSS selector for the <iframe> element itself
 *
 * @param  {object}  candidate descriptor
 * @param  {string}  rule value
 * @return {boolean}
 */
function isFrame( item, rule ) {
    const value = ( rule || "" ).trim();
    if ( value == "" ) return false;

    if ( value.startsWith( "[[/" ) && value.endsWith( "/]]" )) {
        try {
            return new RegExp( value.replace( /^\[\[\/|\/\]\]$/g, "" )).test( item.url );
        } catch ( error ) {
            console.warn( "simpread iframe: bad frame regexp", value, error );
            return false;
        }
    }

    return item.el ? matches( item.el, value ) : false;
}

/**
 * Clone a frame document for Readability
 *
 * Readability's parse() mutates its input ( _removeScripts / _prepDocument ), so it
 * must never see the live document.
 *
 * The <base href> is load bearing: _fixRelativeUris() resolves against doc.baseURI and
 * silently leaves urls relative when `new URL()` throws. A normal http(s) frame keeps
 * its URL through cloneNode, but an about:blank / srcdoc frame does not — the about
 * base url is not part of the cloned state, so the clone's baseURI is "about:blank"
 * and every relative src/href would end up resolved against the *top* page once the
 * html is injected there. Reading baseURI off the live document gives us the value the
 * browser already resolved ( including any <base> in the frame ); prepending makes it
 * win over the cloned one.
 *
 * @param  {document} live frame document
 * @return {document} clone, or undefined when unusable
 */
function cloneForParse( frameDoc ) {
    const base = frameDoc.baseURI || frameDoc.URL || location.href,
          doc  = frameDoc.cloneNode( true );

    // the Readability constructor throws on a document without a documentElement
    if ( !doc || !doc.documentElement ) return undefined;

    rebase( doc, base );
    return doc;
}

/**
 * Prepend a <base href> so relative urls resolve against the frame, not the top page
 *
 * Prepending is what makes it win over any <base> that came with the document, while
 * the value itself already reflects that one — it was read from the live document's
 * baseURI, which the browser had already resolved.
 *
 * @param {document} document to modify
 * @param {string}   absolute base url
 */
function rebase( doc, base ) {
    let head = doc.head || doc.getElementsByTagName( "head" )[0];
    if ( !head ) {
        head = doc.createElement( "head" );
        doc.documentElement.insertBefore( head, doc.documentElement.firstChild );
    }

    const tag = doc.createElement( "base" );
    tag.setAttribute( "href", base );
    head.insertBefore( tag, head.firstChild );
}

/**
 * Strip anything executable from a document parsed out of a cross origin frame
 *
 * read.jsx renders the article with dangerouslySetInnerHTML. innerHTML does not run
 * <script>, but it does fire <img onerror>, and javascript: hrefs still work on click.
 * A cross origin frame is less trusted than the page hosting it, so without this an ad
 * frame could escape its own origin into the top page's.
 *
 * Applies to the cross origin path only: same origin frames and the top document keep
 * the trust level they already had, so existing behaviour is unchanged.
 *
 * Safe to do here because the document came from DOMParser and is inert — nothing in
 * it has run or will run before it is serialized back out.
 *
 * @param {document} parsed document, mutated in place
 */
function sanitize( doc ) {
    const drop = doc.querySelectorAll( "script, iframe, frame, frameset, object, embed, applet, form, link, meta, base, noscript" );
    for ( let i = 0; i < drop.length; i++ ) drop[i].parentNode && drop[i].parentNode.removeChild( drop[i] );

    const all = doc.querySelectorAll( "*" );
    for ( let i = 0; i < all.length; i++ ) {
        const el = all[i], attrs = el.attributes;
        // backwards: removing shifts the live NamedNodeMap
        for ( let j = attrs.length - 1; j >= 0; j-- ) {
            const name  = attrs[j].name,
                  lower = name.toLowerCase(),
                  value = ( attrs[j].value || "" ).replace( /[\s -]/g, "" ).toLowerCase();

            if ( lower.startsWith( "on" ) || lower == "srcdoc" ) {
                el.removeAttribute( name );
                continue;
            }
            if ( [ "href", "src", "xlink:href", "action", "formaction", "data" ].includes( lower ) &&
                 ( value.startsWith( "javascript:" ) || value.startsWith( "data:text/html" ) ||
                   value.startsWith( "vbscript:" ) )) {
                el.removeAttribute( name );
            }
        }
    }
}

/**
 * Convert puread's html tag notation to a css selector
 *
 * Mirrors c() in puread ( "<div class='post'>" -> "div.post", "<article>" -> "article" ),
 * which we can not call because it is private to the vendored bundle. util.js already
 * duplicates verifyHtml/specTest from the same place for the same reason.
 *
 * Unlike c(), a value that is not tag notation is returned as-is so plain css selectors
 * work too.
 *
 * @param  {string} include value
 * @return {string} css selector
 */
function tag2Selector( value ) {
    const [ code, matched ] = verifyHtml( value );
    if ( code != 1 ) return value;

    const [ tag, attr, name ] = matched[0].trim()
                                    .replace( /['"<>]/g, "" )
                                    .replace( / /gi, "=" )
                                    .split( "=" );
    if ( !attr ) return tag;
    if ( attr.toLowerCase() == "class" ) return `${tag}.${name}`;
    if ( attr.toLowerCase() == "id"    ) return `${tag}#${name}`;
    return tag;
}

/**
 * Resolve a site rule's `include` against a frame document
 *
 * Only two forms are supportable here. The [[{jquery}]] / [['text']] / [[/regexp/]]
 * include forms store code bound to the top document and there is no way to inject an
 * alternate context into them, so they are rejected loudly rather than silently.
 *
 * @param  {document} frame document
 * @param  {string}   include value
 * @return {string}   html, or undefined on miss
 */
function resolveInclude( frameDoc, include ) {
    if ( verifyHtml( include )[0] == 2 ) {
        if ( !( include.startsWith( "[[`" ) && include.endsWith( "`]]" ))) {
            console.warn( "simpread iframe: unsupported include form in frame mode", include );
            new Notify().Render( 2, "iframe 模式下的正文选取仅支持 CSS 选择器与 [[`xpath`]]，已改用自动识别。" );
            return undefined;
        }
        const xpath = include.replace( /^\[\[`|`\]\]$/g, "" );
        try {
            const node = frameDoc.evaluate( xpath, frameDoc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null ).singleNodeValue;
            return node ? node.innerHTML.trim() : undefined;
        } catch ( error ) {
            console.warn( "simpread iframe: bad include xpath", xpath, error );
            return undefined;
        }
    }

    const selector = tag2Selector( include );

    let $target;
    try {
        $target = $( frameDoc ).find( selector );
    } catch ( error ) {
        console.warn( "simpread iframe: bad include selector", include, selector, error );
        return undefined;
    }
    if ( $target.length == 0 ) return undefined;

    // mirrors M() in puread: multiple matches are concatenated
    return $target.length == 1 ?
           $target.html().trim() :
           $target.map( ( idx, item ) => $( item ).html() ).get().join( "<br>" ).trim();
}

/**
 * Extract a payload from a candidate
 *
 * Rule driven first ( when the site declares an include ), falling through to
 * Readability on a miss.
 *
 * @param  {object}   candidate descriptor
 * @param  {object}   site rule, optional
 * @return {promise}  resolve( { html, title, excerpt, url } )
 */
function extract( item, site ) {
    if ( !item ) {
        const dtd = $.Deferred();
        dtd.reject( "no candidate" );
        return dtd;
    }
    return item.sameOrigin ? extractLocal( item, site ) : extractRemote( item, site );
}

/**
 * Extract from a frame we can read directly
 */
function extractLocal( item, site ) {
    const dtd      = $.Deferred(),
          frameDoc = item.doc;

    if ( !frameDoc ) {
        dtd.reject( "no accessible frame document" );
        return dtd;
    }

    if ( site && site.include && site.include.trim() != "" ) {
        const html = resolveInclude( frameDoc, site.include.trim() );
        if ( html ) {
            dtd.resolve({
                html   : absolutize( html, frameDoc.baseURI || frameDoc.URL || item.url ),
                title  : frameDoc.title,
                excerpt: "",
                url    : item.url,
            });
            return dtd;
        }
    }

    const doc = cloneForParse( frameDoc );
    if ( !doc ) {
        dtd.reject( "frame document can not be cloned" );
        return dtd;
    }
    return readability( doc, item.url, dtd );
}

/**
 * Rewrite relative urls in an html fragment to absolute
 *
 * Readability resolves urls itself ( _fixRelativeUris, against baseURI ), but a rule
 * driven `include` bypasses Readability entirely: the html comes straight out of
 * innerHTML, which serializes the *source* attributes. A <base> element cannot help
 * once the markup has left its document, so every relative src/href would end up
 * resolved against the top page after injection — the wrong origin entirely for a
 * cross origin frame, and the wrong directory for a same origin one.
 *
 * @param  {string} html fragment
 * @param  {string} absolute base url
 * @return {string} html with absolute urls
 */
function absolutize( html, base ) {
    let doc;
    try {
        doc = new DOMParser().parseFromString( html, "text/html" );
    } catch ( error ) {
        return html;
    }
    if ( !doc || !doc.body ) return html;

    const attrs = [ "src", "href", "poster", "data-src", "data-original" ],
          nodes = doc.body.querySelectorAll( "[" + attrs.join( "],[" ) + "],[srcset]" );

    for ( let i = 0; i < nodes.length; i++ ) {
        const el = nodes[i];

        attrs.forEach( name => {
            const value = el.getAttribute( name );
            if ( !value || value.startsWith( "#" ) || /^[a-z][a-z0-9+.-]*:/i.test( value )) return;
            try {
                el.setAttribute( name, new URL( value, base ).href );
            } catch ( error ) {}
        });

        // srcset is a comma separated list of "url descriptor" pairs
        const srcset = el.getAttribute( "srcset" );
        srcset && el.setAttribute( "srcset", srcset.split( "," ).map( part => {
            const bits = part.trim().split( /\s+/ );
            if ( !bits[0] || /^[a-z][a-z0-9+.-]*:/i.test( bits[0] )) return part.trim();
            try {
                bits[0] = new URL( bits[0], base ).href;
            } catch ( error ) {}
            return bits.join( " " );
        }).join( ", " ));
    }

    return doc.body.innerHTML;
}

/**
 * Normalize a site rule's `include` into something the frame agent can apply
 *
 * The agent only does querySelectorAll and document.evaluate, so the puread tag
 * notation stored in website_list.json ( "<div class='post'>" ) has to be converted to
 * a real selector on this side — the same conversion resolveInclude() does for same
 * origin frames. The [[`xpath`]] form travels as-is; the other three special forms are
 * code bound to a document and are dropped here so the agent falls through to shipping
 * its whole document for Readability.
 *
 * @param  {string} raw include value
 * @return {string} selector or [[`xpath`]], "" when unusable
 */
function remoteInclude( include ) {
    if ( include == "" ) return "";

    if ( verifyHtml( include )[0] == 2 ) {
        if ( include.startsWith( "[[`" ) && include.endsWith( "`]]" )) return include;
        console.warn( "simpread iframe: unsupported include form in frame mode", include );
        new Notify().Render( 2, "iframe 模式下的正文选取仅支持 CSS 选择器与 [[`xpath`]]，已改用自动识别。" );
        return "";
    }

    return tag2Selector( include );
}

/**
 * Extract from a cross origin frame, over postMessage
 *
 * The frame agent resolves a site rule's `include` on its own side ( it is the only
 * side that can ) and otherwise ships its whole document; either way what comes back
 * is an html string, which is exactly the serialized shape this module was built
 * around. A frame that never answers — sandboxed without allow-scripts, or simply
 * gone — must not leave the UI waiting, hence the timeout.
 */
function extractRemote( item, site ) {
    const dtd     = $.Deferred(),
          token   = item.id,
          include = remoteInclude( site && site.include ? site.include.trim() : "" );

    let win;
    try {
        win = item.el && item.el.contentWindow;
    } catch ( error ) {}
    if ( !win ) {
        dtd.reject( "frame window is gone" );
        return dtd;
    }

    const wire = $.Deferred(),
          timer = setTimeout( () => {
              pending.delete( token );
              wire.reject( "frame did not answer in time" );
          }, FETCH_WAIT );

    pending.set( token, wire );
    try {
        win.postMessage({ ns: NS, type: "fetch", token, include }, "*" );
    } catch ( error ) {
        clearTimeout( timer );
        pending.delete( token );
        dtd.reject( "frame is not reachable" );
        return dtd;
    }

    wire.done( reply => {
        clearTimeout( timer );

        const url = reply.url || item.url;
        let doc;
        try {
            doc = new DOMParser().parseFromString( reply.html, "text/html" );
        } catch ( error ) {
            dtd.reject( "frame content could not be parsed" );
            return;
        }
        if ( !doc || !doc.documentElement ) {
            dtd.reject( "frame content could not be parsed" );
            return;
        }

        // order matters: strip executable content before anything reads the tree, and
        // add our own <base> after, so sanitize() removing cloned <base> tags cannot
        // take ours with it
        sanitize( doc );
        rebase( doc, url );

        // an include resolved by the agent is already the article body; wrapping it in
        // Readability would only re-guess a decision the rule already made
        if ( include && reply.resolved ) {
            dtd.resolve({
                html   : absolutize( doc.body.innerHTML, url ),
                title  : reply.title || "",
                excerpt: "",
                url,
            });
            return;
        }
        readability( doc, url, dtd );
    }).fail( why => {
        clearTimeout( timer );
        dtd.reject( why );
    });

    return dtd;
}

/**
 * Run Readability over a prepared document and settle the deferred
 *
 * @param  {document} inert document, already rebased
 * @param  {string}   source url
 * @param  {object}   deferred to settle
 * @return {object}   the same deferred
 */
function readability( doc, url, dtd ) {
    let article;
    try {
        article = new ( puplugin.Plugin( "rdability" ).Readability )( doc ).parse();
    } catch ( error ) {
        console.warn( "simpread iframe: readability failed", error );
        dtd.reject( "readability failed" );
        return dtd;
    }

    // parse() returns null ( it does not throw ) when it can not find an article
    if ( !article || !article.content || article.content.trim() == "" ) {
        dtd.reject( "readability found no content" );
        return dtd;
    }

    dtd.resolve({
        html   : article.content,
        title  : article.title,
        excerpt: article.excerpt,
        url,
    });
    return dtd;
}

/**
 * Pick the best candidate
 *
 * @return {promise} resolve( candidate descriptor )
 */
function detect() {
    const dtd  = $.Deferred(),
          best = candidates()[0];
    best && best.score >= MIN_SCORE ? dtd.resolve( best ) : dtd.reject( "no viable iframe found" );
    return dtd;
}

/**
 * Frames a user could plausibly point at during manual selection
 *
 * Deliberately not collect(): that one answers "which frame is worth reading", so it
 * scores, drops anything below MIN_SIDE and requires a cross origin frame to have already
 * answered a probe. Here the user does the judging, so the only frames worth removing are
 * our own UI and ones that are not rendered at all. A cross origin frame with no agent
 * simply never reports a pick, which is the correct outcome rather than an omission.
 *
 * @param  {document} root document to scan
 * @param  {number}   current nesting depth
 * @param  {array}    accumulator
 * @return {array}    { id, el, doc, url, sameOrigin }
 */
function pickables( root = document, depth = 0, acc = [] ) {
    if ( depth >= MAX_DEPTH || acc.length >= MAX_FRAMES ) return acc;

    const frames = root.querySelectorAll( "iframe, frame" );

    for ( let i = 0; i < frames.length; i++ ) {
        if ( acc.length >= MAX_FRAMES ) break;

        const el = frames[i];
        if ( el.id == "sr-corb" || $( el ).closest( ".simpread-read-root" ).length > 0 ) continue;

        // no size test: the controlbar entry runs while read mode still has the page
        // hidden, which collapses every frame to 0x0. @see measurable
        const style = root.defaultView ? root.defaultView.getComputedStyle( el ) : undefined;
        if ( style && ( style.display == "none" || style.visibility == "hidden" )) continue;

        const doc = frameDocument( el );
        acc.push({ id: tokenFor( el ), el, doc, url: frameURL( el, doc ), sameOrigin: !!doc });

        doc && pickables( doc, depth + 1, acc );
    }

    return acc;
}

/**
 * Arm the manual picker inside every frame on the page
 *
 * The top document's picker ( highlight.js ) can never see into a frame: mouse events
 * inside one are delivered to the frame's own document and stop there, so hovering frame
 * content produces no highlight, no `cursor: pointer` and no clickable target. The only
 * way to select frame content is to run a picker on the far side of the boundary.
 *
 * What comes back is a finished payload rather than an element, because an element from
 * another document is useless to the rest of the pipeline: puread's TempMode() and the
 * +/- controlbar both resolve against the top document, and innerHTML carried across a
 * boundary loses its base url. absolutize() and — cross origin — sanitize() are applied
 * here, so the payload is the same shape extract() produces and apply() accepts.
 *
 * @param  {function} onPick( payload ), fires at most once
 * @param  {function} onEnter, the pointer moved into some frame; used by the top picker
 *                    to drop its own now-stale highlight
 * @param  {function} onCancel, Esc was pressed inside a frame — that keydown goes to the
 *                    frame's document and never reaches the top one, so it is relayed
 * @return {function} teardown, safe to call after a pick
 */
function pick( onPick, onEnter, onCancel ) {
    const stops = [];
    let done = false;

    const stop   = () => stops.forEach( fn => {
              try { fn(); } catch ( error ) {}
          }),
          hit    = payload => {
              if ( done ) return;
              done = true;
              stop();
              onPick( payload );
          },
          cancel = () => {
              if ( done ) return;
              done = true;
              stop();
              onCancel && onCancel();
          };

    pickables().forEach( item => {
        stops.push( item.sameOrigin ? pickLocal( item, hit, onEnter, cancel ) :
                                      pickRemote( item, hit, onEnter, cancel ));
    });

    return stop;
}

/**
 * Run the picker in a frame we can reach directly
 *
 * Listeners are capturing so the frame's own handlers can not swallow the click, and the
 * click is cancelled: while picking, a click means "this element", never "follow this
 * link".
 *
 * @param  {object}   pickable descriptor
 * @param  {function} onPick( payload )
 * @param  {function} onEnter
 * @param  {function} onCancel
 * @return {function} teardown
 */
function pickLocal( item, onPick, onEnter, onCancel ) {
    const doc   = item.doc,
          style = doc.createElement( "style" );

    let prev, entered = 0;

    style.setAttribute( "data-simpread-pick", "1" );
    style.textContent = PICK_CSS;
    ( doc.head || doc.documentElement ).appendChild( style );

    const mark = el => el && el.classList && el.classList.add( PICK_CLASS ),
          wipe = el => el && el.classList && el.classList.remove( PICK_CLASS ),

          move = event => {
              const now = Date.now();
              // throttled: the top picker only needs to hear that the pointer left it
              if ( now - entered > 400 ) {
                  entered = now;
                  onEnter && onEnter();
              }
              wipe( prev );
              prev = event.target;
              mark( prev );
          },

          click = event => {
              event.preventDefault();
              event.stopPropagation();
              wipe( event.target );
              teardown();
              onPick( localPayload( item, event.target ));
          },

          escape = event => {
              if ( event.keyCode != 27 ) return;
              event.preventDefault();
              onCancel && onCancel();
          },

          teardown = () => {
              doc.removeEventListener( "mousemove", move, true );
              doc.removeEventListener( "click", click, true );
              doc.removeEventListener( "keydown", escape, true );
              wipe( prev );
              prev = undefined;
              style.parentNode && style.parentNode.removeChild( style );
          };

    doc.addEventListener( "mousemove", move, true );
    doc.addEventListener( "click", click, true );
    doc.addEventListener( "keydown", escape, true );

    return teardown;
}

/**
 * Run the picker in a frame only its agent can reach, over postMessage
 *
 * @param  {object}   pickable descriptor
 * @param  {function} onPick( payload )
 * @param  {function} onEnter
 * @param  {function} onCancel
 * @return {function} teardown
 */
function pickRemote( item, onPick, onEnter, onCancel ) {
    let win;
    try {
        win = item.el && item.el.contentWindow;
    } catch ( error ) {}
    if ( !win ) return () => {};

    picking.set( item.id, { item, onPick, onEnter, onCancel });
    try {
        win.postMessage({ ns: NS, type: "pick", token: item.id }, "*" );
    } catch ( error ) {}

    return () => {
        picking.delete( item.id );
        try {
            win.postMessage({ ns: NS, type: "pickoff", token: item.id }, "*" );
        } catch ( error ) {}
    };
}

/**
 * Payload for an element picked in a same origin frame
 *
 * innerHTML rather than outerHTML to match what a rule's `include` yields — the picked
 * element is the container, its contents are the article.
 *
 * @param  {object}  pickable descriptor
 * @param  {element} picked element
 * @return {object}  payload
 */
function localPayload( item, el ) {
    const doc = item.doc;
    return {
        html   : absolutize( el && el.innerHTML ? el.innerHTML : "",
                             doc.baseURI || doc.URL || item.url ),
        title  : doc.title || "",
        excerpt: "",
        url    : item.url,
    };
}

/**
 * Payload for an element picked in a cross origin frame
 *
 * Same trust rules as extractRemote(): the markup comes from a less trusted origin than
 * the page it is about to be injected into, so it is stripped before anything reads it.
 *
 * @param  {object} `picked` message
 * @param  {object} pickable descriptor
 * @return {object} payload
 */
function remotePayload( data, item ) {
    const url = data.url || item.url;

    let doc;
    try {
        doc = new DOMParser().parseFromString( data.html || "", "text/html" );
    } catch ( error ) {}
    if ( !doc || !doc.body ) return { html: "", title: data.title || "", excerpt: "", url };

    sanitize( doc );

    return {
        html   : absolutize( doc.body.innerHTML, url ),
        title  : data.title || "",
        excerpt: "",
        url,
    };
}

/**
 * Plain text summary of an html fragment
 *
 * Newsite() hardcodes desc as a [[{…}]] spec, and ReadMode only skips resolving it
 * when excerpt is non empty ( `t.excerpt ? t.excerpt : S( desc )` ). Resolving it means
 * `new Function`, which MV3 can not allow — extension_pages CSP may not carry
 * 'unsafe-eval' — so an empty excerpt takes the whole render down with an EvalError.
 * Readability's own excerpt is frequently empty, so one is derived here rather than
 * trusting the payload.
 *
 * DOMParser rather than jQuery: the fragment is never attached and no script runs.
 *
 * @param  {string} html
 * @return {string} at most 200 chars ( puread truncates to ~100 itself )
 */
function excerptFrom( html ) {
    let text = "";
    try {
        text = new DOMParser().parseFromString( html, "text/html" ).body.textContent || "";
    } catch ( error ) {
        return "";
    }
    text = text.replace( /\s+/g, " " ).trim();
    return text.length > 200 ? text.slice( 0, 200 ) : text;
}

/**
 * Hand a payload to puread
 *
 * @param  {object}  payload from extract()
 * @param  {object}  options, { site } for the rule driven path
 * @return {boolean} true when applied
 */
function apply( payload, options = {} ) {
    // an empty html would produce puread's <sr-rd-content-error> sentinel, which
    // read.jsx reacts to by re-running Readability against the *top* document —
    // silently clobbering our result. Reject before touching storage.pr.
    if ( !payload || !payload.html || payload.html.trim() == "" ) return false;

    const pr      = storage.pr,
          site    = options.site,
          exclude = site && site.exclude ? [ ...site.exclude ] : undefined;

    pr.state = STATE;
    pr.dom   = undefined;  // load bearing: several call sites gate on pr.dom being truthy

    const excerpt = String( payload.excerpt || "" ).replace( /\s+/g, " " ).trim() ||
                    excerptFrom( payload.html );

    pr.Newsite( "read", payload.html, excerpt );
    pr.state = STATE;      // Newsite rebuilds current.site; re-assert in case that changes

    // @see excerptFrom: Newsite's hardcoded desc is a [[{…}]] spec and resolving it
    // needs eval. Dropping it is safe — S("") just yields "" — and it makes the render
    // survive even when the html turned out to be text free.
    pr.current.site.desc = "";

    // Newsite rebuilds current.site from scratch, dropping the rule's exclusions
    exclude && ( pr.current.site.exclude = exclude );

    // The title can not be injected through site.title. ReadMode() only bypasses S()
    // for "" and "<title>", and the one S() form that carries a literal — [[{…}]] —
    // is evaluated with `new Function`, which MV3 forbids: extension_pages CSP can not
    // declare 'unsafe-eval' at all, so it throws EvalError and kills Render(). Park the
    // real title on the site object instead; read.jsx applies it after ReadMode().
    pr.current.site.title      = "<title>";
    pr.current.site.frame_title= String( payload.title || "" ).replace( /\s+/g, " " ).trim();
    pr.current.site.frame_url  = payload.url;

    return true;
}

/**
 * Detect -> extract -> apply. Callers invoke read.Render() themselves on done.
 *
 * This module must never import `read` — read.jsx calls into here and it has top level
 * side effects, so the cycle is a real footgun.
 *
 * @param  {object}  options, { site } to use a site rule's frame/include/exclude
 * @return {promise} resolve( payload )
 */
function enter( options = {} ) {
    const dtd  = $.Deferred(),
          site = options.site,
          rule = site && site.frame ? site.frame : "";

    const run = item => {
        extract( item, rule ? site : undefined )
            .done( payload => {
                apply( payload, rule ? { site } : {} ) ?
                    dtd.resolve( payload ) :
                    dtd.reject( "empty payload" );
            })
            .fail( why => dtd.reject( why ));
    };

    // nothing may be scored off the install time snapshot, @see warm
    warm().done( () => {
        let target;

        if ( rule ) {
            // a rule that stopped matching should say so, not silently auto detect
            const matched = candidates().filter( item => isFrame( item, rule ));
            if ( matched.length == 0 ) {
                dtd.reject( `no frame matched rule: ${rule}` );
                return;
            }
            matched.forEach( item => !item.score && rank( item ));
            target = matched.sort( ( a, b ) => b.score - a.score )[0];
        }

        target ? run( target ) : detect().done( run ).fail( why => dtd.reject( why ));
    });

    return dtd;
}

export {
    install        as Install,
    probeAll       as Probe,
    has            as Has,
    candidates     as Candidates,
    detect         as Detect,
    pick           as Pick,
    extract        as Extract,
    apply          as Apply,
    enter          as Enter,
    STATE          as STATE,
}
