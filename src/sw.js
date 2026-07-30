/**
 * MV3 service worker entry.
 *
 * The background bundle is still three classic scripts, so the worker just pulls them
 * in. `importScripts` keeps webpack 1 output usable as-is — it emits plain scripts, not
 * ES modules, so the worker must stay a classic ( non-module ) one.
 *
 * Three globals the bundle expects do not exist in a worker and are stubbed below.
 */

/**
 * webpack 1's CommonsChunkPlugin runtime opens with `window.webpackJsonp = ...` and the
 * background chunk then calls the bare global `webpackJsonp(...)`. With no `window`,
 * common.js throws on its very first statement and the worker never registers.
 *
 * Aliasing window to the worker global fixes both halves at once: the assignment lands
 * on the global object, so the bare call in background.js resolves to it. It has to be
 * `self` and not `{}` for that second half to work.
 *
 * `document` is deliberately NOT stubbed. jQuery's UMD only builds a real instance when
 * `global.document` exists, and otherwise exports an inert factory; leaving it undefined
 * is what keeps jQuery from initialising and failing hard here.
 */
self.window = self;

/**
 * ga.js is deliberately not imported: MV3 forbids remote script, and it also builds a
 * <script> tag through the DOM. background.js still calls _gaq.push() from its track
 * handler, so a no-op keeps that path from throwing. Analytics is gone until reworked.
 */
var _gaq = { push: function () {} };

/**
 * localStorage does not exist in a service worker, and both local.js and tips.js reach
 * for it — local.js at startup, so without this the worker dies immediately.
 *
 * Deliberately in-memory only. A faithful shim is not possible: localStorage is
 * synchronous while chrome.storage.local is not, and the worker is torn down whenever
 * it goes idle, so there is no point at which an async hydration could complete before
 * local.js reads. Consequences, all acceptable for a build meant for testing:
 *
 *   - `simpread-firstload` is pre-seeded to "false". Left unseeded, Firstload() would
 *     return true on every worker wake-up and spawn an options tab each time.
 *   - local.Count() always restarts at 0, so the throttle on refetching the remote site
 *     list never trips.
 *   - tips.js dismissals do not survive a worker restart.
 *
 * Fixing this properly means porting local.js/tips.js onto chrome.storage.local and
 * making their callers async.
 */
var localStorage = {
    "simpread-firstload": "false",
    removeItem: function ( key ) { delete this[ key ]; },
    getItem   : function ( key ) { return this[ key ]; },
    setItem   : function ( key, value ) { this[ key ] = value; },
};

importScripts( "/bundle/common.js" );

/**
 * jQuery's UMD exports an inert factory when there is no document, so `$` ends up a bare
 * function with none of the static helpers on it. storage.js reaches for two of them
 * ( $.isEmptyObject and $.extend ) from paths background.js hits on startup, so `$` is
 * re-published here with just those. They are the only two the background bundles use.
 *
 * This has to sit between the two importScripts calls: expose-loader assigns `$` while
 * common.js is evaluating, so anything installed before that gets clobbered, and
 * background.js needs it in place by the time it runs.
 */
( function () {
    const jquery = self.$;

    function isPlain( value ) {
        return value != null && typeof value == "object" && !Array.isArray( value ) &&
               ( Object.getPrototypeOf( value ) == Object.prototype || Object.getPrototypeOf( value ) == null );
    }

    // jQuery signature: extend( [deep,] target, ...sources )
    function extend() {
        const args = [].slice.call( arguments );
        let deep = false;
        typeof args[0] == "boolean" && ( deep = args.shift() );
        const target = args.shift() || {};
        args.forEach( function ( source ) {
            source && Object.keys( source ).forEach( function ( key ) {
                const value = source[ key ];
                if ( value === undefined ) return;
                if ( deep && ( isPlain( value ) || Array.isArray( value ) ) ) {
                    const seed = Array.isArray( value )
                               ? ( Array.isArray( target[ key ] ) ? target[ key ] : [] )
                               : ( isPlain( target[ key ] ) ? target[ key ] : {} );
                    target[ key ] = extend( true, seed, value );
                } else target[ key ] = value;
            });
        });
        return target;
    }

    function $shim() {
        return jquery.apply( this, arguments );
    }
    $shim.isEmptyObject = function ( object ) {
        for ( const key in object ) return false;
        return true;
    };
    $shim.extend = extend;

    self.$ = self.jQuery = $shim;
}() );

importScripts( "/bundle/background.js" );
