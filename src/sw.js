/**
 * MV3 service worker entry.
 *
 * The background bundle is still three classic scripts, so the worker just pulls them
 * in. `importScripts` keeps webpack 1 output usable as-is — it emits plain scripts, not
 * ES modules, so the worker must stay a classic ( non-module ) one.
 *
 * Two globals the bundle expects do not exist in a worker and are stubbed below.
 */

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

importScripts( "/bundle/common.js", "/bundle/background.js" );
