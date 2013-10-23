/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

////////////////////////////////////////////////////////////////////////////////
//// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

const CONTENT_HANDLING_URL = "chrome://mozapps/content/handling/dialog.xul";
const STRINGBUNDLE_URL = "chrome://mozapps/locale/handling/handling.properties";

////////////////////////////////////////////////////////////////////////////////
//// nsContentDispatchChooser class

function nsContentDispatchChooser()
{
}

nsContentDispatchChooser.prototype =
{
  classID: Components.ID("e35d5067-95bc-4029-8432-e8f1e431148d"),

  //////////////////////////////////////////////////////////////////////////////
  //// nsIContentDispatchChooser

  ask: function ask(aHandler, aWindowContext, aURI, aReason)
  {
    var window = null;
    try {
      if (aWindowContext)
        window = aWindowContext.getInterface(Ci.nsIDOMWindow);
    } catch (e) { /* it's OK to not have a window */ }

    var sbs = Cc["@mozilla.org/intl/stringbundle;1"].
              getService(Ci.nsIStringBundleService);
    var bundle = sbs.createBundle(STRINGBUNDLE_URL);

    var xai = Cc["@mozilla.org/xre/app-info;1"].
              getService(Ci.nsIXULAppInfo);
    // TODO when this is hooked up for content, we will need different strings
    //      for most of these
    var arr = [bundle.GetStringFromName("protocol.title"),
               "",
               bundle.GetStringFromName("protocol.description"),
               bundle.GetStringFromName("protocol.choices.label"),
               bundle.formatStringFromName("protocol.checkbox.label",
                                           [aURI.scheme], 1),
               bundle.GetStringFromName("protocol.checkbox.accesskey"),
               bundle.formatStringFromName("protocol.checkbox.extra",
                                           [xai.name], 1)];

    var params = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    let SupportsString = Components.Constructor(
                           "@mozilla.org/supports-string;1",
                           "nsISupportsString");
    for each (let text in arr) {
      let string = new SupportsString;
      string.data = text;
      params.appendElement(string, false);
    }
    params.appendElement(aHandler, false);
    params.appendElement(aURI, false);
    params.appendElement(aWindowContext, false);
    
    // if a modal window is already shown, we need to open the app chooser
    // as a modal window otherwise it will be unresponsive; bug 687423
    var wm = Cc["@mozilla.org/appshell/window-mediator;1"].
               getService(Ci.nsIWindowMediator);
    var enumerator = wm.getXULWindowEnumerator(null);
    var inModalState = false;
    while (!inModalState && enumerator.hasMoreElements()) {
      var win = enumerator.getNext();
      var windowDocShell = win.QueryInterface(Ci.nsIXULWindow).docShell;
  
      var containedDocShells = windowDocShell.getDocShellEnumerator(
                                        Ci.nsIDocShellTreeItem.typeChrome,
                                        Ci.nsIDocShell.ENUMERATE_FORWARDS);

      while (!inModalState && containedDocShells.hasMoreElements()) {
        // Get the corresponding document for this docshell
        var childDocShell = containedDocShells.getNext();

        // We don't want it if it's not done loading.
        if (childDocShell.busyFlags != Ci.nsIDocShell.BUSY_FLAGS_NONE)
          continue;

        // Ensure that we are only returning true if it is indeed modal
        var chrome = win.QueryInterface(Ci.nsIInterfaceRequestor).
                         getInterface(Ci.nsIWebBrowserChrome);
        if (chrome.isWindowModal()) {
          inModalState = true;
        }
      }
    }

    var ww = Cc["@mozilla.org/embedcomp/window-watcher;1"].
             getService(Ci.nsIWindowWatcher);
    ww.openWindow(window,
                  CONTENT_HANDLING_URL,
                  null,
                  "chrome,dialog=yes,resizable,centerscreen"
                    + (inModalState ? ",modal" : ""),
                  params);
  },

  //////////////////////////////////////////////////////////////////////////////
  //// nsISupports

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentDispatchChooser])
};

////////////////////////////////////////////////////////////////////////////////
//// Module

let components = [nsContentDispatchChooser];

this.NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
