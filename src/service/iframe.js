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
 * Limitations ( see docs ):
 *   - cross origin frames are NOT supported ( contentDocument is null, frame skipped )
 *   - detection is a single synchronous snapshot; lazily mounted frames are missed
 *   - sandboxed frames without allow-same-origin get an opaque origin and are skipped
 *   - nested frames are walked to MAX_DEPTH only
 *   - in frame mode `include` supports plain CSS selectors and [[`xpath`]] only
 *   - `exclude` of the [[`xpath`]] form does not work ( Exclude() resolves it against
 *     the top document — pre existing engine behaviour )
 *
 * Cross origin readiness: every entry point returns a $.Deferred and extract() resolves
 * a *serialized* payload ( { html, title, excerpt, url } ), never a DOM node — exactly
 * what can later cross an origin boundary via postMessage and exactly what Newsite()
 * wants. Candidate descriptors carry a stable `id` ( stamped on the top document's
 * <iframe> element ) so a future all_frames content script can be addressed by it.
 */

const STATE     = "iframe",        // storage.pr.state value for iframe sourced content
      FRAME_ATTR= "data-simpread-frame-id",

      MAX_DEPTH = 2,               // how deep to walk nested frames
      MAX_FRAMES= 30,              // total frames visited, guards against frame bombs
      MAX_SCORED= 8,               // how many phase 1 survivors get scored
      MIN_SIDE  = 250,             // px; kills 300x250 / 728x90 / 160x600 ad slots
      MIN_TEXT  = 400,             // chars; aligns with Readability DEFAULT_CHAR_THRESHOLD
      MIN_SCORE = 3000;            // ~400 chars of pure prose in a decently sized frame

let frame_seed = 0;

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
 * Phase 1: cheap structural filter over all frames of a document
 *
 * Rejects our own UI, invisible/tiny frames and everything cross origin. That last
 * check is why no ad/social blocklist is needed — DoubleClick, AdSense, Disqus,
 * YouTube and Twitter embeds are cross origin by construction.
 *
 * @param  {document} root document to scan
 * @param  {number}   current nesting depth
 * @param  {array}    accumulator
 * @return {array}    candidate descriptors
 */
function collect( root, depth = 0, acc = [] ) {
    if ( depth >= MAX_DEPTH || acc.length >= MAX_FRAMES ) return acc;

    const frames = root.querySelectorAll( "iframe, frame" );

    for ( let i = 0; i < frames.length; i++ ) {
        if ( acc.length >= MAX_FRAMES ) break;

        const el = frames[i];

        // our own UI: the read root and the CORB loader from output.js
        if ( el.id == "sr-corb" || $( el ).closest( ".simpread-read-root" ).length > 0 ) continue;

        const rect = el.getBoundingClientRect();
        if ( rect.width < MIN_SIDE || rect.height < MIN_SIDE ) continue;

        const style = root.defaultView ? root.defaultView.getComputedStyle( el ) : undefined;
        if ( style && ( style.display == "none" || style.visibility == "hidden" )) continue;

        const doc = frameDocument( el );
        if ( !doc ) continue;

        !el.getAttribute( FRAME_ATTR ) && el.setAttribute( FRAME_ATTR, `sr-frame-${++frame_seed}` );

        acc.push({
            id        : el.getAttribute( FRAME_ATTR ),
            el,                              // present only when sameOrigin === true
            doc,                             // present only when sameOrigin === true
            url       : frameURL( el, doc ),
            area      : rect.width * rect.height,
            sameOrigin: true,
            textLen   : 0,
            score     : 0,
        });

        collect( doc, depth + 1, acc );
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
    const doc  = item.doc,
          text = ( doc.body.innerText || doc.body.textContent || "" ).trim();

    item.textLen = text.length;
    if ( item.textLen < MIN_TEXT ) return item.score = 0;

    const links = doc.body.querySelectorAll( "a" );
    let linkLen = 0;
    for ( let i = 0; i < links.length; i++ ) linkLen += ( links[i].textContent || "" ).length;

    const linkDensity = Math.min( linkLen / item.textLen, 0.95 ),
          blocks      = doc.body.querySelectorAll( "p, li" );

    let paras = 0;
    for ( let i = 0; i < blocks.length; i++ ) {
        ( blocks[i].textContent || "" ).trim().length >= 40 && paras++;
    }

    const semantic = doc.querySelector( "article, main, [itemprop='articleBody'], [role='main']" ) ? 1.35 : 1,
          viewport = Math.max( window.innerWidth * window.innerHeight, 1 ),
          areaW    = Math.min( 1, item.area / ( 0.15 * viewport )) * 0.5 + 0.5;

    return item.score = item.textLen * ( 1 - linkDensity ) * ( 1 + Math.min( paras, 20 ) / 20 ) * semantic * areaW;
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

    let head = doc.head || doc.getElementsByTagName( "head" )[0];
    if ( !head ) {
        head = doc.createElement( "head" );
        doc.documentElement.insertBefore( head, doc.documentElement.firstChild );
    }

    const tag = doc.createElement( "base" );
    tag.setAttribute( "href", base );
    head.insertBefore( tag, head.firstChild );

    return doc;
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
    const dtd      = $.Deferred(),
          frameDoc = item && item.doc;

    if ( !frameDoc ) {
        dtd.reject( "no accessible frame document" );
        return dtd;
    }

    if ( site && site.include && site.include.trim() != "" ) {
        const html = resolveInclude( frameDoc, site.include.trim() );
        if ( html ) {
            dtd.resolve({ html, title: frameDoc.title, excerpt: "", url: item.url });
            return dtd;
        }
    }

    const doc = cloneForParse( frameDoc );
    if ( !doc ) {
        dtd.reject( "frame document can not be cloned" );
        return dtd;
    }

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
        url    : item.url,
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

    pr.Newsite( "read", payload.html, payload.excerpt || "" );
    pr.state = STATE;      // Newsite rebuilds current.site; re-assert in case that changes

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

    let target;

    if ( rule ) {
        // a rule that stopped matching should say so, not silently auto detect
        const matched = candidates().filter( item => isFrame( item, rule ));
        if ( matched.length == 0 ) {
            dtd.reject( `no frame matched rule: ${rule}` );
            return dtd;
        }
        matched.forEach( item => !item.score && rank( item ));
        target = matched.sort( ( a, b ) => b.score - a.score )[0];
    }

    const run = item => {
        extract( item, rule ? site : undefined )
            .done( payload => {
                apply( payload, rule ? { site } : {} ) ?
                    dtd.resolve( payload ) :
                    dtd.reject( "empty payload" );
            })
            .fail( why => dtd.reject( why ));
    };

    target ? run( target ) : detect().done( run ).fail( why => dtd.reject( why ));

    return dtd;
}

export {
    has            as Has,
    candidates     as Candidates,
    detect         as Detect,
    extract        as Extract,
    apply          as Apply,
    enter          as Enter,
    STATE          as STATE,
}
