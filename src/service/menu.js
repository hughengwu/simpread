console.log( "=== simpread menu load ===" )

import {storage} from 'storage';
import {browser} from 'browser';
import * as msg  from 'message';

/**
 * Create context menus
*/
const context = {
        focus : { id: "", menu: {} },
        read  : { id: "", menu: {} },
        link  : { id: "", menu: {} },
        list  : { id: "", menu: {} },
        whitelist : { id: "", menu: {} },
        exclusion : { id: "", menu: {} },
        blacklist : { id: "", menu: {} },
        unrdist   : { id: "", menu: {} },
        lazyload  : { id: "", menu: {} },
    },
    menu = {
        "type"     : "normal",
        "contexts" :  [ "all" ],
        "documentUrlPatterns" : [ "http://*/*" , "https://*/*" ]
    };

Object.assign( context.focus.menu,      menu, { id: "focus",     "title" : "聚焦模式", contexts: [ "page" ] });
Object.assign( context.read.menu,       menu, { id: "read",      "title" : "阅读模式", contexts: [ "page" ] });
Object.assign( context.link.menu,       menu, { id: "link",      "title" : "使用阅读模式打开此链接", contexts: [ "link" ] });

Object.assign( context.list.menu,       menu, { id: "list",      "title" : "打开稍后读", contexts: [ "page" ] });
Object.assign( context.unrdist.menu,    menu, { id: "unrdist",   "title" : "将当前页面加入稍后读", contexts: [ "page" ] });

Object.assign( context.whitelist.menu,  menu, { id: "whitelist", "title" : "将当前页面加入到白名单", contexts: [ "page" ] });
Object.assign( context.exclusion.menu,  menu, { id: "exclusion", "title" : "将当前页面加入到排除列表", contexts: [ "page" ] });
Object.assign( context.blacklist.menu,  menu, { id: "blacklist", "title" : "将当前页面加入到黑名单", contexts: [ "page" ] });
Object.assign( context.lazyload.menu,   menu, { id: "lazyload",  "title" : "将当前页面加入到延迟加载", contexts: [ "page" ] });

/**
 * Listen contextMenus message
 */
function onClicked( callback ) {
    browser.contextMenus.onClicked.addListener( callback );
}

/**
 * Rebuild bookkeeping.
 *
 * `signature` is the menu options a build was made from. setMenuAndIcon() calls
 * Create( "read" ) on every navigation to an adaptable page, and each of those used to
 * tear the whole menu down and put it back — pointless when nothing about the menu
 * changed, and the source of the races below. A build is now skipped outright when the
 * options are the same as last time.
 */
let building = false, pending = false, signature = "";

/**
 * Swallow a create/update failure.
 *
 * Every contextMenus call gets this. Without a callback Chrome reports the failure as an
 * "Unchecked runtime.lastError", which is noise nobody can act on, and reading the
 * property is what marks it handled.
 */
const checked = () => { void browser.runtime.lastError; };

/**
 * Create all context menu
 *
 * Everything is torn down first. Under MV3 the worker is restarted whenever it has been
 * idle, and background.js rebuilds the menus on every start, so creating straight away
 * would hit "duplicate id" from the second start onwards. removeAll is async, hence the
 * callback rather than the two back-to-back calls this used to do.
 *
 * That same asynchrony is why rebuilds have to be serialized. Two overlapping calls both
 * queue their removeAll, both run before either build does, and then the second build
 * duplicates every id the first one just created — "Cannot create item with duplicate id
 * link" and the same for the separators. A rebuild asked for while one is in flight is
 * therefore folded into a single one afterwards, not started alongside.
 *
 * @param {boolean} rebuild even when the options have not changed
 */
function createAll( force = false ) {
    const current = JSON.stringify( storage.option.menu );
    if ( !force && current == signature ) return;
    if ( building ) { pending = true; return; }

    building  = true;
    signature = current;
    browser.contextMenus.removeAll( () => {
        build();
        building = false;
        if ( pending ) {
            pending = false;
            createAll( true );
        }
    });
}

function build() {
    // ids are only meaningful for items this build actually creates; a stale one left
    // over from a build where the item was still enabled is what update() would then
    // aim at, and miss.
    Object.keys( context ).forEach( key => context[ key ].id = "" );

    storage.option.menu.focus &&
        ( context.focus.id = browser.contextMenus.create( context.focus.menu, checked ));

    storage.option.menu.read &&
        ( context.read.id  = browser.contextMenus.create( context.read.menu, checked ));

    storage.option.menu.link &&
        ( context.link.id  = browser.contextMenus.create( context.link.menu, checked ));

    // MV3 requires an explicit id on every item, separators included
    browser.contextMenus.create({ "id": "separator-1", "type": "separator" }, checked );

    storage.option.menu.list &&
        ( context.list.id     = browser.contextMenus.create( context.list.menu, checked ));

    storage.option.menu.unrdist &&
        ( context.unrdist.id  = browser.contextMenus.create( context.unrdist.menu, checked ));

    browser.contextMenus.create({ "id": "separator-2", "type": "separator" }, checked );

    storage.option.menu.whitelist &&
        ( context.whitelist.id  = browser.contextMenus.create( context.whitelist.menu, checked ));

    storage.option.menu.exclusion &&
        ( context.exclusion.id  = browser.contextMenus.create( context.exclusion.menu, checked ));

    storage.option.menu.blacklist &&
        ( context.blacklist.id  = browser.contextMenus.create( context.blacklist.menu, checked ));

    storage.option.menu.lazyload &&
        ( context.lazyload.id   = browser.contextMenus.create( context.lazyload.menu, checked ));

    // all menu is false remove contextMenus
    Object.values( storage.option.menu ).findIndex( menu => menu == true ) == -1 && browser.contextMenus.removeAll();
}

/**
 * Create menu from type
 * 
 * @param {string} include: foucs read link
 */
function create( type ) {
    /*
    if ( !context[type].id ) {
        delete context[type].menu.generatedId;
        context[type].id = browser.contextMenus.create( context[type].menu );
    }
    */
   createAll();
}

/**
 * Remove menu from type
 * 
 * @param {string} include: foucs read link
 */
function remove( type ) {
    /*
    if ( context[type].id ) {
        browser.contextMenus.remove( context[type].id );
        context[type].id = undefined;
    }
    */
    createAll();
}

/**
 * Update menu from type
 * 
 * @param {string} include: tempread and read
 */
function update( type ) {
    // Not while a rebuild is in flight: removeAll has already run by then, so the item
    // the id names is gone and Chrome answers with "Cannot find menu item with id read"
    // — as a rejected promise, which surfaces as an uncaught error rather than a
    // lastError anyone could swallow.
    if ( building || !context.read.id ) return;
    const title = type == "read" ? "阅读模式" : "临时阅读模式";
    browser.contextMenus.update( context.read.id, { title }, checked );
}

/**
 * Refresh menu ( Enforcement fresh )
 * 
 * @param {object} new menu object 
 */
function refresh( cur ) {
    Object.keys( cur ).forEach( item => {
        browser.runtime.sendMessage( msg.Add( msg.MESSAGE_ACTION.menu, { id: item, value: cur[item] } ));
    });
}

export {
    createAll as CreateAll,
    create    as Create,
    remove    as Remove,
    update    as Update,
    refresh   as Refresh,
    onClicked as OnClicked,
}