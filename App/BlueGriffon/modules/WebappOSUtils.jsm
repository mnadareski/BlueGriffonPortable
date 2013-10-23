/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");

this.EXPORTED_SYMBOLS = ["WebappOSUtils"];

this.WebappOSUtils = {
  launch: function(aData) {
//@line 17 "c:\trees\official1.7\toolkit\webapps\WebappOSUtils.jsm"
    let appRegKey;
    try {
      let open = CC("@mozilla.org/windows-registry-key;1",
                    "nsIWindowsRegKey", "open");
      let initWithPath = CC("@mozilla.org/file/local;1",
                            "nsILocalFile", "initWithPath");
      let initProcess = CC("@mozilla.org/process/util;1",
                           "nsIProcess", "init");

      appRegKey = open(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                       "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" +
                       aData.origin, Ci.nsIWindowsRegKey.ACCESS_READ);

      let launchTarget = initWithPath(appRegKey.readStringValue("InstallLocation"));
      launchTarget.append(appRegKey.readStringValue("AppFilename") + ".exe");

      let process = initProcess(launchTarget);
      process.runwAsync([], 0);
    } catch (e) {
      return false;
    } finally {
      if (appRegKey) {
        appRegKey.close();
      }
    }

    return true;
//@line 80 "c:\trees\official1.7\toolkit\webapps\WebappOSUtils.jsm"
  },

  uninstall: function(aData) {
//@line 106 "c:\trees\official1.7\toolkit\webapps\WebappOSUtils.jsm"
  }
}
