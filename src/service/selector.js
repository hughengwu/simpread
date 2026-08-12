console.log( "=== simpread spec load ===" )

/**
 * Resolve puread's two code bearing special selector forms without eval.
 *
 * website_list.json stores some rule fields as code:
 *
 *     "title"  : "[[{$('header.title h1').text()}]]"
 *     "include": "[[[$('.Post-RichText')]]]"
 *
 * puread resolves both with `new Function( "return " + expr )()`. Under MV3 that is
 * unconditionally fatal: extension_pages CSP may not carry 'unsafe-eval' at all, so the
 * call throws EvalError inside ReadMode() and takes the whole render down — 231 values
 * across 121 of the 351 shipped rules, which is what "the site does nothing when I press
 * A A" looks like from the outside.
 *
 * The values are not really code. Sampling every one of them, 214 of the 231 are a
 * single jQuery expression built from a fixed vocabulary: a selector, a few traversal
 * and extraction calls, an index, `||` alternation, one ternary and one .replace(). This
 * module parses and interprets exactly that vocabulary and nothing else — no statements,
 * no assignment, no function literals, no access to any global but `$` and a short
 * whitelist on `document`. An expression it cannot handle is reported as unsupported
 * rather than guessed at.
 *
 * How it plugs in, without touching the vendored engine: ReadMode() is run against a
 * *copy* of the rule in which every code bearing field has been replaced by an inert
 * placeholder, so nothing evals; the values this module computed are then written into
 * pr.html, which is the deep clone ReadMode produces and the only thing the view reads.
 * @see Read in src/read/read.jsx
 *
 * Placeholders are chosen so that a field this module could not resolve degrades the way
 * that field degrades naturally — a missing title falls back to <title>, a missing
 * include falls back to Readability — instead of rendering something broken.
 *
 * The 17 remaining values are multi statement IIFEs ( they build DOM, loop with .each,
 * use template literals ). Interpreting those means a real JS interpreter, which is not
 * what this is. They are skipped, and the graceful degradation above is what those ~12
 * sites get.
 */

const MAX_LEN = 2000;          // a rule expression this long is not the shape we parse

/**
 * `document`, as a value the interpreter can carry around. A sentinel rather than the
 * real object so nothing can reach a property that is not on the whitelist below.
 */
const DOC = { simpread_document: true };

/**
 * Every call the interpreter will make. Anything absent is unsupported — the list is the
 * security boundary as much as the feature set, so it holds no mutator ( .remove, .html(v),
 * .append ) and nothing that takes a callback.
 */
const JQUERY_CALLS = [
        // traversal
        "find", "children", "parent", "parents", "closest", "prev", "next",
        "prevAll", "nextAll", "nextUntil", "prevUntil", "siblings",
        "first", "last", "eq", "filter", "not", "is", "has", "add", "slice",
        // extraction
        "text", "html", "attr", "prop", "val", "data", "contents",
      ],
      STRING_CALLS = [
        "replace", "trim", "split", "join", "slice", "substr", "substring",
        "toLowerCase", "toUpperCase", "indexOf", "charAt", "concat", "startsWith",
        "endsWith", "includes", "padEnd", "padStart",
      ],
      DOCUMENT_CALLS = [ "getElementById", "querySelector", "querySelectorAll" ],
      // read only, and only the ones the shipped rules actually reach for
      NODE_PROPS  = [
        "lastChild", "firstChild", "parentNode", "nextSibling", "previousSibling",
        "nodeValue", "data", "textContent", "innerText", "innerHTML", "outerHTML",
        "src", "href", "title", "id", "className", "value", "length",
      ];

/**
 * Thrown for anything outside the supported vocabulary. Distinct from a runtime failure
 * ( a selector that matches nothing ) so callers can tell "cannot" from "did not".
 */
function Unsupported( why ) {
    this.name    = "Unsupported";
    this.message = why;
}

function unsupported( why ) {
    throw new Unsupported( why );
}

/* ------------------------------------------------------------------ tokenizer -- */

const PUNCT = [ "===", "!==", "==", "!=", "&&", "||", "?", ":", ".", ",",
                "(", ")", "[", "]", "!" ];

/**
 * @param  {string} expression source
 * @return {array}  tokens, { type: str|num|name|punct, value }
 */
function tokenize( src ) {
    const out = [];
    let i = 0;

    while ( i < src.length ) {
        const ch = src[i];

        if ( /\s/.test( ch )) { i++; continue; }

        // string literal; the selectors inside routinely carry the other quote character
        if ( ch == "'" || ch == '"' ) {
            let value = "", j = i + 1;
            while ( j < src.length && src[j] != ch ) {
                if ( src[j] == "\\" ) {
                    j++;
                    const esc = src[j];
                    value += esc == "n" ? "\n" : esc == "t" ? "\t" : esc == "r" ? "\r" : esc;
                } else value += src[j];
                j++;
            }
            if ( j >= src.length ) unsupported( "unterminated string" );
            out.push({ type: "str", value });
            i = j + 1;
            continue;
        }

        if ( /[0-9]/.test( ch )) {
            let j = i;
            while ( j < src.length && /[0-9.]/.test( src[j] )) j++;
            out.push({ type: "num", value: parseFloat( src.slice( i, j )) });
            i = j;
            continue;
        }

        // $ is a legal identifier character, so `$` and `$x` both land here
        if ( /[A-Za-z_$]/.test( ch )) {
            let j = i;
            while ( j < src.length && /[A-Za-z0-9_$]/.test( src[j] )) j++;
            out.push({ type: "name", value: src.slice( i, j ) });
            i = j;
            continue;
        }

        const punct = PUNCT.find( p => src.startsWith( p, i ));
        if ( !punct ) unsupported( `unexpected character ${ ch }` );
        out.push({ type: "punct", value: punct });
        i += punct.length;
    }

    return out;
}

/* --------------------------------------------------------------------- parser -- */

/**
 * Recursive descent over the subset. Precedence, loosest first: ?: || && == unary
 * postfix. No assignment, no comma operator, no statements — a source that needs any of
 * those fails to parse, which is the point.
 *
 * @param  {array}  tokens
 * @return {object} ast
 */
function parse( tokens ) {
    let pos = 0;

    const peek  = () => tokens[pos],
          done  = () => pos >= tokens.length,
          is    = ( type, value ) => !done() && peek().type == type &&
                                     ( value === undefined || peek().value == value ),
          eat   = ( type, value ) => {
              if ( !is( type, value )) unsupported( `expected ${ value || type }` );
              return tokens[pos++];
          },
          maybe = ( type, value ) => is( type, value ) ? ( pos++, true ) : false;

    function expression() {
        const test = or();
        if ( !maybe( "punct", "?" )) return test;
        const yes = expression();
        eat( "punct", ":" );
        return { type: "cond", test, yes, no: expression() };
    }

    function or() {
        let left = and();
        while ( maybe( "punct", "||" )) left = { type: "or", left, right: and() };
        return left;
    }

    function and() {
        let left = equality();
        while ( maybe( "punct", "&&" )) left = { type: "and", left, right: equality() };
        return left;
    }

    function equality() {
        let left = unary();
        while ( is( "punct", "==" ) || is( "punct", "!=" ) ||
                is( "punct", "===" ) || is( "punct", "!==" )) {
            const op = tokens[pos++].value;
            left = { type: "cmp", op, left, right: unary() };
        }
        return left;
    }

    function unary() {
        if ( maybe( "punct", "!" )) return { type: "not", arg: unary() };
        return postfix( primary() );
    }

    function postfix( node ) {
        for ( ;; ) {
            if ( maybe( "punct", "." )) {
                const name = eat( "name" ).value;
                node = maybe( "punct", "(" ) ?
                       { type: "call", target: node, name, args: args() } :
                       { type: "get",  target: node, name };
                continue;
            }
            if ( maybe( "punct", "[" )) {
                const index = expression();
                eat( "punct", "]" );
                node = { type: "index", target: node, index };
                continue;
            }
            return node;
        }
    }

    // assumes the opening paren has been consumed
    function args() {
        const list = [];
        if ( maybe( "punct", ")" )) return list;
        for ( ;; ) {
            list.push( expression() );
            if ( maybe( "punct", "," )) continue;
            eat( "punct", ")" );
            return list;
        }
    }

    function primary() {
        if ( is( "str" ) || is( "num" )) return { type: "lit", value: tokens[pos++].value };

        if ( maybe( "punct", "(" )) {
            const inner = expression();
            eat( "punct", ")" );
            return inner;
        }

        if ( is( "name" )) {
            const name = tokens[pos++].value;
            if ( name == "$" ) {
                eat( "punct", "(" );
                return { type: "jquery", args: args() };
            }
            if ( name == "document" ) return { type: "document" };
            if ( name == "true"     ) return { type: "lit", value: true  };
            if ( name == "false"    ) return { type: "lit", value: false };
            if ( name == "null"     ) return { type: "lit", value: null  };
            if ( name == "undefined") return { type: "lit", value: undefined };
            unsupported( `unknown identifier ${ name }` );
        }

        unsupported( done() ? "unexpected end of expression" : `unexpected ${ peek().value }` );
    }

    const ast = expression();
    if ( !done() ) unsupported( `trailing input at ${ peek().value }` );
    return ast;
}

/* ---------------------------------------------------------------- interpreter -- */

function isJquery( value ) {
    return !!value && typeof value == "object" && typeof value.jquery == "string";
}

function isNode( value ) {
    return !!value && typeof value == "object" && typeof value.nodeType == "number";
}

function run( node ) {
    switch ( node.type ) {

    case "lit"     : return node.value;
    case "document": return DOC;

    // jQuery objects are always truthy, which is exactly why the shipped `||` chains
    // alternate on .html()/.attr() ( undefined when empty ) rather than on the set
    case "or"      : { const left = run( node.left ); return left ? left : run( node.right ); }
    case "and"     : { const left = run( node.left ); return left ? run( node.right ) : left; }
    case "not"     : return !run( node.arg );
    case "cond"    : return run( node.test ) ? run( node.yes ) : run( node.no );

    case "cmp"     : {
        const left = run( node.left ), right = run( node.right );
        switch ( node.op ) {
        case "==" : return left == right;
        case "!=" : return left != right;
        case "===": return left === right;
        default   : return left !== right;
        }
    }

    case "jquery"  : {
        const arg = node.args.length ? run( node.args[0] ) : undefined;
        if ( arg === undefined || arg === null ) return $();
        if ( isJquery( arg ) || isNode( arg )) return $( arg );
        if ( typeof arg != "string" ) unsupported( "$() argument is not a selector" );
        // a malformed selector -- website_list.json has at least one -- must read as
        // "matched nothing", not as a crash
        try {
            return $( arg );
        } catch ( error ) {
            return $();
        }
    }

    case "index"   : {
        const target = run( node.target ), index = run( node.index );
        if ( typeof index != "number" ) unsupported( "non numeric index" );
        if ( isJquery( target ) || Array.isArray( target ) || typeof target == "string" ) {
            return target[index];
        }
        unsupported( "index on an unsupported value" );
        break;
    }

    case "get"     : return get( run( node.target ), node.name );
    case "call"    : return call( run( node.target ), node.name, node.args.map( run ));
    }

    unsupported( `unsupported node ${ node.type }` );
}

function get( target, name ) {
    if ( target === DOC ) {
        if ( name == "title" ) return document.title;
        if ( name == "body"  ) return document.body;
        unsupported( `document.${ name }` );
    }
    if ( isJquery( target )) {
        if ( name == "length" ) return target.length;
        unsupported( `jQuery property .${ name }` );
    }
    if ( typeof target == "string" || Array.isArray( target )) {
        if ( name == "length" ) return target.length;
        unsupported( `.${ name }` );
    }
    if ( isNode( target )) {
        if ( NODE_PROPS.includes( name )) return target[name];
        unsupported( `node property .${ name }` );
    }
    if ( target === undefined || target === null ) unsupported( `.${ name } of ${ target }` );
    unsupported( `.${ name }` );
}

function call( target, name, args ) {
    if ( args.some( arg => typeof arg == "function" )) unsupported( "callback argument" );

    if ( target === DOC ) {
        if ( !DOCUMENT_CALLS.includes( name )) unsupported( `document.${ name }()` );
        try {
            return document[name].apply( document, args );
        } catch ( error ) {
            return undefined;
        }
    }

    if ( isJquery( target )) {
        if ( !JQUERY_CALLS.includes( name )) unsupported( `jQuery .${ name }()` );
        // .attr('x', v) and friends would be writes; only the reading arity is allowed
        if ( [ "attr", "prop", "data", "val", "text", "html" ].includes( name ) && args.length > 1 ) {
            unsupported( `.${ name }() as a setter` );
        }
        if ( [ "text", "html", "val" ].includes( name ) && args.length == 1 ) {
            unsupported( `.${ name }() as a setter` );
        }
        try {
            return target[name].apply( target, args );
        } catch ( error ) {
            return undefined;
        }
    }

    if ( typeof target == "string" ) {
        if ( !STRING_CALLS.includes( name )) unsupported( `string .${ name }()` );
        return target[name].apply( target, args );
    }

    if ( target === undefined || target === null ) unsupported( `.${ name }() of ${ target }` );
    unsupported( `.${ name }()` );
}

/* -------------------------------------------------------------------- the api -- */

/**
 * Which code bearing form a rule value uses, or -1
 *
 * Mirrors d() in puread: after the outer [[ ]] come off, a leading `{` is the expression
 * form and a leading `[` is the array form. The other three leading characters ( ' / ` )
 * are the eval free forms and are left alone.
 *
 * @param  {any}    rule value
 * @return {number} 0, 3, or -1
 */
function formOf( value ) {
    if ( typeof value != "string" ) return -1;
    const text = value.trim();
    if ( text.length > MAX_LEN ) return -1;
    if ( text.startsWith( "[[{" ) && text.endsWith( "}]]" )) return 0;
    if ( text.startsWith( "[[[" ) && text.endsWith( "]]]" )) return 3;
    return -1;
}

/**
 * Evaluate one rule value
 *
 * @param  {string} rule value, must be a code bearing form
 * @return {object} { ok, value } — ok false means the expression is outside the subset
 */
function evaluate( value ) {
    const form = formOf( value );
    if ( form < 0 ) return { ok: false, value: undefined };

    const source = value.trim().slice( 3, -3 );

    try {
        return { ok: true, value: run( parse( tokenize( source ))) };
    } catch ( error ) {
        error instanceof Unsupported ?
            console.warn( "simpread spec: unsupported expression", source, error.message ) :
            console.warn( "simpread spec: expression failed", source, error );
        return { ok: false, value: undefined };
    }
}

/**
 * puread's M(): how a set becomes the html of a field
 *
 * Duplicated rather than called because it is private to the vendored bundle, the same
 * reason util.js duplicates verifyHtml. The sentinel in the empty case is load bearing —
 * read.jsx watches for it and falls back to Readability.
 *
 * @param  {jquery} set
 * @return {string} html
 */
function multi( $set ) {
    switch ( $set.length ) {
    case 0 : return "<sr-rd-content-error></sr-rd-content-error>";
    case 1 : return $set.html().trim();
    default: return $set.map( ( idx, el ) => $( el ).html() ).get().join( "<br>" );
    }
}

/**
 * What S() would have produced for this rule value
 *
 * Form 0 is returned verbatim — S() passes the eval result straight through, which is
 * why an `include` can legitimately be a jQuery object here ( spec.Multiple calls .each
 * on it ) rather than an html string. Form 3 goes through find + M, exactly as S() does.
 *
 * @param  {string} rule value
 * @return {object} { ok, value }
 */
function resolve( value ) {
    const form   = formOf( value ),
          result = evaluate( value );
    if ( !result.ok ) return result;
    return form == 0 ?
           result :
           { ok: true, value: multi( $( "html" ).find( result.value )) };
}

/**
 * Inert stand-ins, one per field, chosen so an unresolved field degrades the way that
 * field degrades on its own:
 *
 *   title   "<title>"  ReadMode substitutes the page title
 *   desc    ""         resolves to ""
 *   include ""         resolves to the <sr-rd-content-error> sentinel, and read.jsx
 *                      answers that by running Readability
 *   avatar  "<sr-spec>" and
 *   paging  "<sr-spec>" non empty on purpose: ReadMode drops the whole avatar/paging
 *                      block when the first entry is "", and dropping it would hide the
 *                      fields before they could be filled in
 *
 * <sr-spec> is tag notation, so c() turns it into a selector that matches nothing.
 */
const PLACEHOLDER = { title: "<title>", desc: "", include: "", avatar: "<sr-spec>", paging: "<sr-spec>" };

/**
 * Every code bearing field of a rule, with its resolved value
 *
 * @param  {object} site rule
 * @return {array}  { field, key, index, source, ok, value }
 */
function scan( site ) {
    const found = [];

    [ "title", "desc", "include" ].forEach( field => {
        if ( formOf( site[field] ) < 0 ) return;
        const { ok, value } = resolve( site[field] );
        found.push({ field, source: site[field], ok, value });
    });

    [ "avatar", "paging" ].forEach( field => {
        Array.isArray( site[field] ) && site[field].forEach( ( entry, index ) => {
            Object.keys( entry || {} ).forEach( key => {
                if ( formOf( entry[key] ) < 0 ) return;
                const { ok, value } = resolve( entry[key] );
                found.push({ field, key, index, source: entry[key], ok, value });
            });
        });
    });

    return found;
}

/**
 * Run ReadMode with every code bearing field resolved here instead of by eval
 *
 * pr.current.site is swapped for a copy rather than mutated: the same object is
 * storage.current.site, which the site editor edits and Cleansite() persists, and a
 * placeholder written into it would be saved to the user's rules.
 *
 * @param  {object} puread instance
 */
function readMode( pr ) {
    const site = pr.current && pr.current.site;
    if ( !site ) return pr.ReadMode();

    const plan = scan( site );
    if ( plan.length == 0 ) return pr.ReadMode();

    const original = pr.current.site;
    pr.current.site = neutral( site, plan );
    try {
        pr.ReadMode();
    } finally {
        pr.current.site = original;
    }

    patch( pr.html, plan );
}

/**
 * A copy of the rule with the code bearing fields replaced by their placeholders
 *
 * @param  {object} site rule
 * @param  {array}  scan result
 * @return {object} copy
 */
function neutral( site, plan ) {
    const copy = { ...site };

    plan.forEach( item => {
        if ( item.key === undefined ) {
            copy[item.field] = PLACEHOLDER[item.field];
            return;
        }
        // avatar/paging are arrays of single key objects; copy down to the entry so the
        // original rule keeps its own
        copy[item.field] = copy[item.field].map( ( entry, index ) =>
            index == item.index ? { ...entry, [item.key]: PLACEHOLDER[item.field] } : entry );
    });

    return copy;
}

/**
 * Write the resolved values into the render model
 *
 * Only values that actually resolved are written; a field left alone keeps the
 * placeholder's natural fallback. @see PLACEHOLDER
 *
 * @param {object} pr.html
 * @param {array}  scan result
 */
function patch( html, plan ) {
    if ( !html ) return;

    let avatarFailed = false;

    plan.forEach( item => {
        if ( item.field == "avatar" && !item.ok ) avatarFailed = true;
        if ( !item.ok ) return;

        if ( item.key === undefined ) {
            // desc is truncated by ReadMode; the placeholder skipped that, so redo it
            html[item.field] = item.field == "desc" ? excerpt( item.value ) : item.value;
            return;
        }
        html[item.field] && html[item.field][item.index] &&
            ( html[item.field][item.index][item.key] = item.value );
    });

    // Only rules whose avatar block came from an expression are ours to second guess;
    // one built from plain selectors is left exactly as ReadMode produced it.
    const ours = plan.some( item => item.field == "avatar" );
    if ( ours && ( avatarFailed || !html.include || !html.include.each )) delete html.avatar;

    // include stays a jQuery object only for spec.Multiple, which iterates it. With no
    // avatar block the view injects it as html instead, and a jQuery object would
    // stringify to [object Object].
    !html.avatar && isJquery( html.include ) && ( html.include = multi( html.include ));
}

/**
 * puread's desc truncation, applied to a value that bypassed ReadMode
 *
 * @param  {string} text
 * @return {string} at most ~100 chars, cut at the first 。 when there is one
 */
function excerpt( text ) {
    if ( typeof text != "string" ) return text;
    const stop = text.indexOf( "。" ) + 1;
    if ( text.length <= 100 ) return text;
    return stop > 0 ? text.substr( 0, stop ) : text.substr( 0, 101 ) + "......";
}

/**
 * Exclude, with the code bearing entries applied here
 *
 * puread's Exclude() removes the matched elements itself for the array form and — a
 * vendor bug — silently re-pushes the previous selector for the expression form, so the
 * two expression-form entries in the shipped rules never did anything. Both are treated
 * as removals here, which is plainly what an `exclude` entry means.
 *
 * The entries this module handled are withheld from puread so it neither evals them nor
 * hits that bug; everything else ( tag notation, [['text']], [[/re/]] ) is untouched.
 *
 * `remove` is off for focus mode, which hides and unhides the excluded elements rather
 * than deleting them — there, dropping the entries is enough to stop the EvalError that
 * escapes puread's Exclude() through its own finally block.
 *
 * @param  {object}  puread instance
 * @param  {jquery}  rendered content root
 * @param  {boolean} whether a resolved entry should be removed from the page
 * @return {string}  selector list for the caller to remove
 */
function excludes( pr, $target, remove = true ) {
    const site = pr.current && pr.current.site;
    if ( !site || !Array.isArray( site.exclude )) return pr.Exclude( $target );

    const keep = site.exclude.filter( source => {
        if ( formOf( source ) < 0 ) return true;
        if ( !remove ) return false;
        const { ok, value } = evaluate( source );
        ok && value && value.remove && value.remove();
        return false;
    });

    if ( keep.length == site.exclude.length ) return pr.Exclude( $target );

    const original = pr.current.site;
    pr.current.site = { ...site, exclude: keep };
    try {
        return pr.Exclude( $target );
    } finally {
        pr.current.site = original;
    }
}

/**
 * Include, for focus mode
 *
 * Mirrors puread's own Include(): the expression form yields $( first element ), the
 * array form yields the set as it stands.
 *
 * @param  {object} puread instance
 * @return {jquery} elements, empty when unresolved
 */
function include( pr ) {
    const site = pr.current && pr.current.site,
          form = site ? formOf( site.include ) : -1;
    if ( form < 0 ) return pr.Include();

    const { ok, value } = evaluate( site.include );
    if ( !ok || !value ) return $();
    return form == 0 ? $( value[0] ) : value;
}

export {
    formOf   as FormOf,
    evaluate as Evaluate,
    resolve  as Resolve,
    scan     as Scan,
    readMode as ReadMode,
    excludes as Excludes,
    include  as Include,
}
