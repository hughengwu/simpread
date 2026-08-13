console.log( "=== simpread obsidian load ===" )

import Turndown from 'markdown';
import mdgfm    from 'mdgfm';

/**
 * Save read mode to Obsidian.
 *
 * The note this produces is deliberately shaped like the one Obsidian Web Clipper 0.10.8
 * writes with its stock "Default" template, so that a vault can hold clips from both
 * without two competing conventions. Everything below that names the clipper was read out
 * of its shipped `popup.js`; the minified identifiers are noted so the next person can
 * find them again.
 *
 *   note   = frontmatter + markdown          ( clipper: h = (yield D(c)) + o )
 *   file   = <folder>/<sanitized title>      ( clipper: b() , path "Clippings" )
 *   uri    = obsidian://new?file=…&vault=…&clipboard
 *
 * The body travels through the clipboard rather than the URL. That is what the clipper
 * does by default (`legacyMode` off): a long article blows past the length a custom
 * protocol URL can carry, and Obsidian >= 1.7.2 reads `&clipboard` instead. `&content=`
 * stays as the fallback for when the clipboard write is refused.
 *
 * Not reproduced from the clipper: its MathML/LaTeX conversion, footnote collection, and
 * colspan tables — those are a large body of code serving cases SimpRead's own reader has
 * already flattened by the time we see the content. Headings, lists, tables, code, links,
 * images and the frontmatter are the same.
 */

const FOLDER   = "Clippings",
      TAGS     = "clippings",
      // "text" is the default; only the exceptions are listed. @see clipper D()
      PROPERTY = { author: "multitext", tags: "multitext", published: "date", created: "date" };

/**
 * Read <meta [attr=name]> content.
 *
 * Matches the clipper's ye(): the attribute is compared case-insensitively, which is why
 * this cannot be a plain attribute selector.
 *
 * @param  {string} attribute name, "name" or "property"
 * @param  {string} attribute value
 * @return {string} content, or ""
 */
function meta( attr, name ) {
    const found = Array.from( document.querySelectorAll( `meta[${attr}]` ) )
        .find( el => ( el.getAttribute( attr ) || "" ).toLowerCase() == name.toLowerCase() );
    return found ? ( found.getAttribute( "content" ) || "" ).trim() : "";
}

/**
 * All schema.org JSON-LD blocks on the page, flattened over @graph.
 *
 * @return {array} parsed objects
 */
function schemas() {
    const all = [];
    document.querySelectorAll( 'script[type="application/ld+json"]' ).forEach( el => {
        try {
            const data = JSON.parse( el.textContent );
            ( Array.isArray( data ) ? data : [ data ] ).forEach( item => {
                item && item[ "@graph" ] ? all.push( ...[].concat( item[ "@graph" ] )) : all.push( item );
            });
        } catch ( error ) { /* a malformed block is simply not a source */ }
    });
    return all.filter( Boolean );
}

/**
 * Resolve a dotted path against the schema.org data, the way the clipper's xe() does:
 * descend through arrays, collect the strings found, join them with ", ". An object
 * reached with no path left contributes its `name`. When the direct path misses, retry
 * with a deep search — publishers nest the same fields at wildly different depths.
 *
 * @param  {string} e.g. "author.name"
 * @return {string} value, or ""
 */
function schema( path ) {
    const walk = ( node, keys, direct ) => {
        if ( typeof node == "string" ) return keys.length == 0 ? [ node ] : [];
        if ( !node || typeof node != "object" ) return [];
        if ( Array.isArray( node )) return node.flatMap( item => walk( item, keys, direct ));
        const [ head, ...rest ] = keys;
        if ( !head ) return node.name ? [ node.name ] : [];
        if ( node.hasOwnProperty( head )) return walk( node[ head ], rest, true );
        if ( !direct ) {
            const deep = [];
            for ( const key in node ) {
                typeof node[ key ] == "object" && deep.push( ...walk( node[ key ], keys, false ));
            }
            if ( deep.length > 0 ) return deep;
        }
        return [];
    };
    for ( const data of schemas() ) {
        const keys = path.split( "." );
        let found  = walk( data, keys, true );
        found.length == 0 && ( found = walk( data, keys, false ));
        const value = found.filter( Boolean ).map( String ).join( ", " );
        if ( value ) return value;
    }
    return "";
}

/**
 * First <time> element's datetime, else its text. @see clipper's inline helper for published
 *
 * @return {string}
 */
function timeTag() {
    const el = document.querySelector( "time" );
    if ( !el ) return "";
    return ( el.getAttribute( "datetime" ) || el.textContent || "" ).trim();
}

/**
 * Pick the first non-empty candidate.
 */
function first( ...values ) {
    return values.find( value => value && value.trim() != "" ) || "";
}

/**
 * Page metadata, using the clipper's source precedence verbatim.
 *
 * The read-mode title/description are consulted first — on a page whose article lives in
 * an iframe, or that needed a manual selection, the top document's own <meta> describes
 * something other than what the reader is actually showing.
 *
 * @param  {string} read mode title
 * @param  {string} read mode desc
 * @return {object} { title, author, published, description, url, created }
 */
function metadata( title = "", desc = "" ) {
    return {
        url         : location.href.replace( /(\?|&)simpread_mode=read/, "" ),
        created     : stamp( new Date() ),
        title       : first( title,
                             meta( "property", "og:title" ),
                             meta( "name", "twitter:title" ),
                             schema( "headline" ),
                             meta( "name", "title" ),
                             meta( "name", "sailthru.title" ),
                             ( document.querySelector( "title" ) || {} ).textContent ),
        author      : first( meta( "name", "sailthru.author" ),
                             schema( "author.name" ),
                             meta( "property", "author" ),
                             meta( "name", "byl" ),
                             meta( "name", "author" ),
                             meta( "name", "copyright" ),
                             schema( "copyrightHolder.name" ),
                             meta( "property", "og:site_name" ),
                             schema( "publisher.name" ),
                             schema( "sourceOrganization.name" ),
                             schema( "isPartOf.name" ),
                             meta( "name", "twitter:creator" ),
                             meta( "name", "application-name" )),
        description : first( desc,
                             meta( "name", "description" ),
                             meta( "property", "description" ),
                             meta( "property", "og:description" ),
                             schema( "description" ),
                             meta( "name", "twitter:description" ),
                             meta( "name", "sailthru.description" )),
        published   : first( schema( "datePublished" ),
                             meta( "property", "article:published_time" ),
                             timeTag(),
                             meta( "name", "sailthru.date" )).split( "," )[0].trim(),
    };
}

/**
 * ISO 8601 with a numeric offset — dayjs's "YYYY-MM-DDTHH:mm:ssZ", which is what the
 * clipper stamps into `created`. Date.toISOString() would give UTC with a "Z" suffix and
 * read as a different moment in the vault.
 *
 * @param  {Date}
 * @return {string} e.g. 2026-08-13T14:05:33+08:00
 */
function stamp( date ) {
    const pad    = value => String( value ).padStart( 2, "0" ),
          offset = -date.getTimezoneOffset(),
          sign   = offset >= 0 ? "+" : "-",
          abs    = Math.abs( offset );
    return `${ date.getFullYear() }-${ pad( date.getMonth() + 1 ) }-${ pad( date.getDate() ) }` +
           `T${ pad( date.getHours() ) }:${ pad( date.getMinutes() ) }:${ pad( date.getSeconds() ) }` +
           `${ sign }${ pad( Math.floor( abs / 60 )) }:${ pad( abs % 60 ) }`;
}

/**
 * Escape for a double-quoted YAML scalar. @see clipper v()
 */
function escape( value ) {
    return String( value ).replace( /"/g, '\\"' );
}

/**
 * Sanitize a note name. @see clipper b()
 *
 * Windows is the platform SimpRead is most often run on and the strictest of the three,
 * so its reserved characters and device names are handled first.
 *
 * @param  {string} title
 * @return {string} safe file name, never empty
 */
function filename( title ) {
    const platform = ( navigator.userAgentData || {} ).platform || navigator.platform || "";
    let name = String( title ).replace( /[#|\^\[\]]/g, "" );
    if ( /win/i.test( platform )) {
        name = name.replace( /[<>:"\/\\?*\x00-\x1F]/g, "" )
                   .replace( /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, "_$1$2" )
                   .replace( /[\s.]+$/, "" );
    } else if ( /mac/i.test( platform )) {
        name = name.replace( /[\/:\x00-\x1F]/g, "" ).replace( /^\./, "_" );
    } else {
        name = name.replace( /[<>:"\/\\|?*\x00-\x1F]/g, "" ).replace( /^\./, "_" );
    }
    name = name.replace( /^\.+/, "" ).trim().slice( 0, 245 );
    return name.length == 0 ? "Untitled" : name;
}

/**
 * Serialize the frontmatter. @see clipper D()
 *
 * Property order is the Default template's, and so is each type's shape: multitext always
 * becomes a block list, date is written bare, everything else is quoted. A property with
 * no value keeps its key and an empty value rather than disappearing — same as the
 * clipper, and it leaves the field ready to fill in by hand.
 *
 * @param  {object} @see metadata()
 * @param  {string} tags, comma separated
 * @return {string} "---\n…---\n"
 */
function frontmatter( info, tags = TAGS ) {
    const author = info.author
                 ? info.author.split( ", " ).filter( Boolean ).map( name => `[[${name}]]` ).join( ", " )
                 : "";
    const fields = [
        [ "title",       info.title       ],
        [ "source",      info.url         ],
        [ "author",      author           ],
        [ "published",   info.published   ],
        [ "created",     info.created     ],
        [ "description", info.description ],
        [ "tags",        tags             ],
    ];
    let yaml = "---\n";
    for ( const [ name, value ] of fields ) {
        const type = PROPERTY[ name ] || "text";
        yaml += `${name}:`;
        if ( type == "multitext" ) {
            // the clipper's split refuses to break inside a [[wikilink]]
            const items = String( value ).split( /,(?![^\[]*\]\])/ ).map( item => item.trim() ).filter( Boolean );
            items.length > 0 ? ( yaml += "\n" + items.map( item => `  - "${ escape( item ) }"\n` ).join( "" ))
                             : ( yaml += "\n" );
        } else if ( type == "date" ) {
            yaml += String( value ).trim() != "" ? ` ${value}\n` : "\n";
        } else {
            yaml += String( value ).trim() != "" ? ` "${ escape( value ) }"\n` : "\n";
        }
    }
    return yaml + "---\n";
}

/**
 * Read mode HTML to Markdown, with the clipper's turndown configuration.
 *
 * Relative URLs are resolved first. SimpRead's iframe path already plants a <base> before
 * parsing a frame, but a manual selection off the top document has had no such treatment.
 *
 * @param  {string} html
 * @param  {string} page url, used as the base
 * @return {string} markdown
 */
function markdown( html, url ) {
    const holder = document.createElement( "div" );
    holder.innerHTML = html;

    const absolute = value => {
        if ( !value || /^(https?:|data:|#|mailto:)/i.test( value )) return value;
        try { return new URL( value, url ).href; } catch ( error ) { return value; }
    };
    holder.querySelectorAll( "img[src], a[href]" ).forEach( el => {
        const attr = el.tagName == "IMG" ? "src" : "href";
        el.setAttribute( attr, absolute( el.getAttribute( attr )));
    });
    holder.querySelectorAll( "img[srcset]" ).forEach( el => {
        // "url 2x, url 480w" — only the url of each candidate is a url
        el.setAttribute( "srcset", el.getAttribute( "srcset" ).split( "," ).map( candidate => {
            const [ src, ...rest ] = candidate.trim().split( /\s+/ );
            return [ absolute( src ), ...rest ].join( " " );
        }).join( ", " ));
    });

    const service = new Turndown({
        headingStyle    : "atx",
        hr              : "---",
        bulletListMarker: "-",
        codeBlockStyle  : "fenced",
        emDelimiter     : "*",
    });
    service.use([ mdgfm.gfm, mdgfm.tables, mdgfm.strikethrough, mdgfm.highlightedCodeBlock ]);
    service.remove([ "style", "script", "button" ]);
    service.keep([ "iframe", "video", "audio", "sup", "sub", "svg", "math" ]);

    // ordered lists honour <ol start>, which turndown's stock rule ignores
    service.addRule( "listItem", {
        filter: "li",
        replacement: ( content, node, options ) => {
            content = content.trim();
            let prefix = options.bulletListMarker + " ";
            const parent = node.parentNode;
            if ( parent && parent.nodeName == "OL" ) {
                const start = parent.getAttribute( "start" ),
                      index = Array.prototype.indexOf.call( parent.children, node ) + 1;
                prefix = ( start ? Number( start ) + index - 1 : index ) + ". ";
            }
            return prefix + content + "\n";
        }
    });

    service.addRule( "figure", {
        filter: "figure",
        replacement: ( content, node ) => {
            const img = node.querySelector( "img" );
            if ( !img ) return content;
            const caption = node.querySelector( "figcaption" ),
                  text    = caption ? caption.textContent.trim() : "";
            return `\n\n![${ img.getAttribute( "alt" ) || "" }](${ img.getAttribute( "src" ) || "" })\n` +
                   ( text ? `\n*${text}*\n` : "" ) + "\n";
        }
    });

    return service.turndown( holder.innerHTML )
                  // links whose text turned out empty; an image link keeps its "!"
                  .replace( /(!?)\[]\([^)]+\)\n*/g, ( match, image ) => image ? match : "" )
                  .replace( /\n{3,}/g, "\n\n" )
                  .trim();
}

/**
 * Build the note.
 *
 * @param  {string} read mode title
 * @param  {string} read mode desc
 * @param  {string} read mode content html
 * @param  {object} { folder, tags }
 * @return {object} { note, name, info }
 */
function note( title, desc, content, { folder = FOLDER, tags = TAGS } = {} ) {
    const info = metadata( title, desc ),
          body = markdown( content, info.url );
    return { note: frontmatter( info, tags ) + body, name: filename( info.title ), folder, info };
}

/**
 * Save to Obsidian.
 *
 * @param  {string} read mode title
 * @param  {string} read mode desc
 * @param  {string} read mode content html
 * @param  {object} { vault, folder, tags }
 * @return {object} $.Deferred, resolved with the uri actually opened
 */
function save( title, desc, content, options = {} ) {
    const dtd = $.Deferred(),
          { vault = "" } = options,
          { note: text, name, folder } = note( title, desc, content, options );

    let path = folder || "";
    path && !path.endsWith( "/" ) && ( path += "/" );

    const base = `obsidian://new?file=${ encodeURIComponent( path + name ) }` +
                 ( vault ? `&vault=${ encodeURIComponent( vault ) }` : "" ),
          open = uri => { location.href = uri; dtd.resolve( uri ); };

    // Preferred path: hand the body over on the clipboard, so the note is not limited by
    // how much a protocol URL can carry. Needs Obsidian >= 1.7.2.
    try {
        navigator.clipboard.writeText( text )
            .then ( () => open( `${base}&clipboard` ) )
            .catch( () => open( `${base}&content=${ encodeURIComponent( text ) }` ) );
    } catch ( error ) {
        open( `${base}&content=${ encodeURIComponent( text ) }` );
    }
    return dtd;
}

export {
    save        as Save,
    note        as Note,
    metadata    as Metadata,
    frontmatter as Frontmatter,
    markdown    as Markdown,
    filename    as Filename,
}
