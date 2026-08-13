
/**
 * Analytics stub.
 *
 * This file used to build a <script> tag pointing at https://ssl.google-analytics.com/ga.js
 * and insert it into the page. Under MV3 that cannot work in either direction:
 *
 *   - extension_pages CSP is script-src 'self' and, unlike MV2, it may not declare a
 *     remote host. Every options page therefore logged
 *     "Loading the script 'https://ssl.google-analytics.com/ga.js' violates ... The
 *     action has been blocked." on open.
 *   - remotely hosted code is disallowed outright, so widening the policy is not the fix.
 *
 * Classic Analytics — the ga.js property this pushed to — has been shut down by Google
 * anyway, so nothing was being recorded even before MV3 blocked the request.
 *
 * `_gaq` stays defined because background.js's track handler pushes to it, and the queue
 * is capped so a long-lived page cannot grow it without bound. The service worker carries
 * its own copy of this stub for the same reason. @see sw.js
 */

var _AnalyticsCode = 'UA-405976-14';
var _gaq = _gaq || [];

_gaq.push = function () {
    // keep the last few for debugging, drop the rest on the floor
    Array.prototype.push.apply( this, arguments );
    while ( this.length > 20 ) Array.prototype.shift.call( this );
    return this.length;
};
