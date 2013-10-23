/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

this.EXPORTED_SYMBOLS = ["DOMApplicationRegistry"];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import('resource://gre/modules/ActivitiesService.jsm');
Cu.import("resource://gre/modules/AppsUtils.jsm");
Cu.import("resource://gre/modules/PermissionsInstaller.jsm");
Cu.import("resource://gre/modules/OfflineCacheInstaller.jsm");
Cu.import("resource://gre/modules/SystemMessagePermissionsChecker.jsm");
Cu.import("resource://gre/modules/AppDownloadManager.jsm");

function debug(aMsg) {
  //dump("-*-*- Webapps.jsm : " + aMsg + "\n");
}

// Minimum delay between two progress events while downloading, in ms.
const MIN_PROGRESS_EVENT_DELAY = 1000;

const WEBAPP_RUNTIME = Services.appinfo.ID == "webapprt@mozilla.org";

XPCOMUtils.defineLazyGetter(this, "NetUtil", function() {
  Cu.import("resource://gre/modules/NetUtil.jsm");
  return NetUtil;
});

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                                   "@mozilla.org/parentprocessmessagemanager;1",
                                   "nsIMessageBroadcaster");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsIMessageSender");

XPCOMUtils.defineLazyGetter(this, "msgmgr", function() {
  return Cc["@mozilla.org/system-message-internal;1"]
         .getService(Ci.nsISystemMessagesInternal);
});

XPCOMUtils.defineLazyGetter(this, "updateSvc", function() {
  return Cc["@mozilla.org/offlinecacheupdate-service;1"]
           .getService(Ci.nsIOfflineCacheUpdateService);
});

//@line 61 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
  // If we're executing in the context of the webapp runtime, the data files
  // are in a different directory (currently the Firefox profile that installed
  // the webapp); otherwise, they're in the current profile.
  const DIRECTORY_NAME = WEBAPP_RUNTIME ? "WebappRegD" : "ProfD";
//@line 66 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

this.DOMApplicationRegistry = {
  appsFile: null,
  webapps: { },
  children: [ ],
  allAppsLaunchable: false,

  init: function() {
    this.messages = ["Webapps:Install", "Webapps:Uninstall",
                     "Webapps:GetSelf", "Webapps:CheckInstalled",
                     "Webapps:GetInstalled", "Webapps:GetNotInstalled",
                     "Webapps:Launch", "Webapps:GetAll",
                     "Webapps:InstallPackage",
                     "Webapps:GetList", "Webapps:RegisterForMessages",
                     "Webapps:UnregisterForMessages",
                     "Webapps:CancelDownload", "Webapps:CheckForUpdate",
                     "Webapps:Download", "Webapps:ApplyDownload",
                     "Webapps:Install:Return:Ack",
                     "child-process-shutdown"];

    this.frameMessages = ["Webapps:ClearBrowserData"];

    this.messages.forEach((function(msgName) {
      ppmm.addMessageListener(msgName, this);
    }).bind(this));

    cpmm.addMessageListener("Activities:Register:OK", this);

    Services.obs.addObserver(this, "xpcom-shutdown", false);

    AppDownloadManager.registerCancelFunction(this.cancelDownload.bind(this));

    this.appsFile = FileUtils.getFile(DIRECTORY_NAME,
                                      ["webapps", "webapps.json"], true);

    this.loadAndUpdateApps();
  },

  // loads the current registry, that could be empty on first run.
  // aNext() is called after we load the current webapps list.
  loadCurrentRegistry: function loadCurrentRegistry(aNext) {
    let file = FileUtils.getFile(DIRECTORY_NAME, ["webapps", "webapps.json"], false);
    if (file && file.exists()) {
      this._loadJSONAsync(file, (function loadRegistry(aData) {
        if (aData) {
          this.webapps = aData;
          let appDir = FileUtils.getDir(DIRECTORY_NAME, ["webapps"], false);
          for (let id in this.webapps) {
            let app = this.webapps[id];

            app.id = id;

            // Make sure we have a localId
            if (app.localId === undefined) {
              app.localId = this._nextLocalId();
            }

            if (app.basePath === undefined) {
              app.basePath = appDir.path;
            }

            // Default to removable apps.
            if (app.removable === undefined) {
              app.removable = true;
            }

            // Default to a non privileged status.
            if (app.appStatus === undefined) {
              app.appStatus = Ci.nsIPrincipal.APP_STATUS_INSTALLED;
            }

            // Default to NO_APP_ID and not in browser.
            if (app.installerAppId === undefined) {
              app.installerAppId = Ci.nsIScriptSecurityManager.NO_APP_ID;
            }
            if (app.installerIsBrowser === undefined) {
              app.installerIsBrowser = false;
            }

            // Default installState to "installed", and reset if we shutdown
            // during an update.
            if (app.installState === undefined ||
                app.installState === "updating") {
              app.installState = "installed";
            }

            // At startup we can't be downloading, and the $TMP directory
            // will be empty so we can't just apply a staged update.
            app.downloading = false;
            app.readyToApplyDownload = false;
          };
        }
        aNext();
      }).bind(this));
    } else {
      aNext();
    }
  },

  // Notify we are starting with registering apps.
  notifyAppsRegistryStart: function notifyAppsRegistryStart() {
    Services.obs.notifyObservers(this, "webapps-registry-start", null);
  },

  // Notify we are done with registering apps and save a copy of the registry.
  notifyAppsRegistryReady: function notifyAppsRegistryReady() {
    Services.obs.notifyObservers(this, "webapps-registry-ready", null);
    this._saveApps();
  },

  // Registers all the activities and system messages.
  registerAppsHandlers: function registerAppsHandlers(aRunUpdate) {
    this.notifyAppsRegistryStart();
    let ids = [];
    for (let id in this.webapps) {
      ids.push({ id: id });
    }
//@line 186 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
    // Read the CSPs. If MOZ_SYS_MSG is defined this is done on
    // _processManifestForIds so as to not reading the manifests
    // twice
    this._readManifests(ids, (function readCSPs(aResults) {
      aResults.forEach(function registerManifest(aResult) {
        this.webapps[aResult.id].csp = aResult.manifest.csp || "";
      }, this);
    }).bind(this));

    // Nothing else to do but notifying we're ready.
    this.notifyAppsRegistryReady();
//@line 198 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
  },

  updatePermissionsForApp: function updatePermissionsForApp(aId) {
    if (!this.webapps[aId]) {
      return;
    }

    // Install the permissions for this app, as if we were updating
    // to cleanup the old ones if needed.
    this._readManifests([{ id: aId }], (function(aResult) {
      let data = aResult[0];
      PermissionsInstaller.installPermissions({
        manifest: data.manifest,
        manifestURL: this.webapps[aId].manifestURL,
        origin: this.webapps[aId].origin
      }, true, function() {
        debug("Error installing permissions for " + aId);
      });
    }).bind(this));
  },

  updateOfflineCacheForApp: function updateOfflineCacheForApp(aId) {
    let app = this.webapps[aId];
    OfflineCacheInstaller.installCache({
      basePath: app.basePath,
      appId: aId,
      origin: app.origin,
      localId: app.localId
    });
  },

  // Installs a 3rd party app.
  installPreinstalledApp: function installPreinstalledApp(aId) {
//@line 310 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
  },

  // Implements the core of bug 787439
  // if at first run, go through these steps:
  //   a. load the core apps registry.
  //   b. uninstall any core app from the current registry but not in the
  //      new core apps registry.
  //   c. for all apps in the new core registry, install them if they are not
  //      yet in the current registry, and run installPermissions()
  installSystemApps: function installSystemApps(aNext) {
    let file;
    try {
      file = FileUtils.getFile("coreAppsDir", ["webapps", "webapps.json"], false);
    } catch(e) { }

    if (file && file.exists()) {
      // a
      this._loadJSONAsync(file, (function loadCoreRegistry(aData) {
        if (!aData) {
          aNext();
          return;
        }

        // b : core apps are not removable.
        for (let id in this.webapps) {
          if (id in aData || this.webapps[id].removable)
            continue;
          delete this.webapps[id];
          // Remove the permissions, cookies and private data for this app.
          let localId = this.webapps[id].localId;
          let permMgr = Cc["@mozilla.org/permissionmanager;1"]
                          .getService(Ci.nsIPermissionManager);
          permMgr.RemovePermissionsForApp(localId, false);
          Services.cookies.removeCookiesForApp(localId, false);
          this._clearPrivateData(localId, false);
        }

        let appDir = FileUtils.getDir("coreAppsDir", ["webapps"], false);
        // c
        for (let id in aData) {
          // Core apps have ids matching their domain name (eg: dialer.gaiamobile.org)
          // Use that property to check if they are new or not.
          if (!(id in this.webapps)) {
            this.webapps[id] = aData[id];
            this.webapps[id].basePath = appDir.path;

            this.webapps[id].id = id;

            // Create a new localId.
            this.webapps[id].localId = this._nextLocalId();

            // Core apps are not removable.
            if (this.webapps[id].removable === undefined) {
              this.webapps[id].removable = false;
            }
          }
        }
        aNext();
      }).bind(this));
    } else {
      aNext();
    }
  },

//@line 401 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

  loadAndUpdateApps: function loadAndUpdateApps() {
    let runUpdate = AppsUtils.isFirstRun(Services.prefs);

//@line 410 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

    let onAppsLoaded = (function onAppsLoaded() {
      if (runUpdate) {
        // At first run, install preloaded apps and set up their permissions.
        for (let id in this.webapps) {
          this.installPreinstalledApp(id);
          if (!this.webapps[id]) {
            continue;
          }
          this.updateOfflineCacheForApp(id);
          this.updatePermissionsForApp(id);
        }
        // Need to update the persisted list of apps since
        // installPreinstalledApp() removes the ones failing to install.
        this._saveApps();
      }
      this.registerAppsHandlers(runUpdate);
    }).bind(this);

    this.loadCurrentRegistry((function() {
//@line 437 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
      onAppsLoaded();
//@line 439 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
    }).bind(this));
  },

//@line 661 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "xpcom-shutdown") {
      this.messages.forEach((function(msgName) {
        ppmm.removeMessageListener(msgName, this);
      }).bind(this));
      Services.obs.removeObserver(this, "xpcom-shutdown");
      ppmm = null;
    }
  },

  _loadJSONAsync: function(aFile, aCallback) {
    try {
      let channel = NetUtil.newChannel(aFile);
      channel.contentType = "application/json";
      NetUtil.asyncFetch(channel, function(aStream, aResult) {
        if (!Components.isSuccessCode(aResult)) {
          Cu.reportError("DOMApplicationRegistry: Could not read from json file "
                         + aFile.path);
          if (aCallback)
            aCallback(null);
          return;
        }

        // Read json file into a string
        let data = null;
        try {
          // Obtain a converter to read from a UTF-8 encoded input stream.
          let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                          .createInstance(Ci.nsIScriptableUnicodeConverter);
          converter.charset = "UTF-8";

          data = JSON.parse(converter.ConvertToUnicode(NetUtil.readInputStreamToString(aStream,
                                                            aStream.available()) || ""));
          aStream.close();
          if (aCallback)
            aCallback(data);
        } catch (ex) {
          Cu.reportError("DOMApplicationRegistry: Could not parse JSON: " +
                         aFile.path + " " + ex + "\n" + ex.stack);
          if (aCallback)
            aCallback(null);
        }
      });
    } catch (ex) {
      Cu.reportError("DOMApplicationRegistry: Could not read from " +
                     aFile.path + " : " + ex + "\n" + ex.stack);
      if (aCallback)
        aCallback(null);
    }
  },

  addMessageListener: function(aMsgNames, aMm) {
    aMsgNames.forEach(function (aMsgName) {
      if (!(aMsgName in this.children)) {
        this.children[aMsgName] = [];
      }

      let mmFound = this.children[aMsgName].some(function(mmRef) {
        if (mmRef.mm === aMm) {
          mmRef.refCount++;
          return true;
        }
        return false;
      });

      if (!mmFound) {
        this.children[aMsgName].push({
          mm: aMm,
          refCount: 1
        });
      }
    }, this);
  },

  removeMessageListener: function(aMsgNames, aMm) {
    if (aMsgNames.length === 1 &&
        aMsgNames[0] === "Webapps:Internal:AllMessages") {
      for (let msgName in this.children) {
        let msg = this.children[msgName];

        for (let mmI = msg.length - 1; mmI >= 0; mmI -= 1) {
          let mmRef = msg[mmI];
          if (mmRef.mm === aMm) {
            msg.splice(mmI, 1);
          }
        }

        if (msg.length === 0) {
          delete this.children[msgName];
        }
      }
      return;
    }

    aMsgNames.forEach(function(aMsgName) {
      if (!(aMsgName in this.children)) {
        return;
      }

      let removeIndex;
      this.children[aMsgName].some(function(mmRef, index) {
        if (mmRef.mm === aMm) {
          mmRef.refCount--;
          if (mmRef.refCount === 0) {
            removeIndex = index;
          }
          return true;
        }
        return false;
      });

      if (removeIndex) {
        this.children[aMsgName].splice(removeIndex, 1);
      }
    }, this);
  },

  receiveMessage: function(aMessage) {
    // nsIPrefBranch throws if pref does not exist, faster to simply write
    // the pref instead of first checking if it is false.
    Services.prefs.setBoolPref("dom.mozApps.used", true);

    // We need to check permissions for calls coming from mozApps.mgmt.
    // These are: getAll(), getNotInstalled(), applyDownload() and uninstall().
    if (["Webapps:GetAll",
         "Webapps:GetNotInstalled",
         "Webapps:ApplyDownload",
         "Webapps:Uninstall"].indexOf(aMessage.name) != -1) {
      if (!aMessage.target.assertPermission("webapps-manage")) {
        debug("mozApps message " + aMessage.name +
        " from a content process with no 'webapps-manage' privileges.");
        return null;
      }
    }

    let msg = aMessage.data || {};
    let mm = aMessage.target;
    msg.mm = mm;

    switch (aMessage.name) {
      case "Webapps:Install":
        this.doInstall(msg, mm);
        break;
      case "Webapps:GetSelf":
        this.getSelf(msg, mm);
        break;
      case "Webapps:Uninstall":
        this.uninstall(msg, mm);
        break;
      case "Webapps:Launch":
        this.launchApp(msg, mm);
        break;
      case "Webapps:CheckInstalled":
        this.checkInstalled(msg, mm);
        break;
      case "Webapps:GetInstalled":
        this.getInstalled(msg, mm);
        break;
      case "Webapps:GetNotInstalled":
        this.getNotInstalled(msg, mm);
        break;
      case "Webapps:GetAll":
        this.getAll(msg, mm);
        break;
      case "Webapps:InstallPackage":
        this.doInstallPackage(msg, mm);
        break;
      case "Webapps:RegisterForMessages":
        this.addMessageListener(msg, mm);
        break;
      case "Webapps:UnregisterForMessages":
        this.removeMessageListener(msg, mm);
        break;
      case "child-process-shutdown":
        this.removeMessageListener(["Webapps:Internal:AllMessages"], mm);
        break;
      case "Webapps:GetList":
        this.addMessageListener(["Webapps:AddApp", "Webapps:RemoveApp"], mm);
        return this.webapps;
      case "Webapps:Download":
        this.startDownload(msg.manifestURL);
        break;
      case "Webapps:CancelDownload":
        this.cancelDownload(msg.manifestURL);
        break;
      case "Webapps:CheckForUpdate":
        this.checkForUpdate(msg, mm);
        break;
      case "Webapps:ApplyDownload":
        this.applyDownload(msg.manifestURL);
        break;
      case "Activities:Register:OK":
        this.notifyAppsRegistryReady();
        break;
      case "Webapps:Install:Return:Ack":
        this.onInstallSuccessAck(msg.manifestURL);
        break;
    }
  },

  getAppInfo: function getAppInfo(aAppId) {
    return AppsUtils.getAppInfo(this.webapps, aAppId);
  },

  // Some messages can be listened by several content processes:
  // Webapps:AddApp
  // Webapps:RemoveApp
  // Webapps:Install:Return:OK
  // Webapps:Uninstall:Return:OK
  // Webapps:Uninstall:Broadcast:Return:OK
  // Webapps:OfflineCache
  // Webapps:checkForUpdate:Return:OK
  // Webapps:PackageEvent
  broadcastMessage: function broadcastMessage(aMsgName, aContent) {
    if (!(aMsgName in this.children)) {
      return;
    }
    this.children[aMsgName].forEach(function(mmRef) {
      mmRef.mm.sendAsyncMessage(aMsgName, aContent);
    });
  },

  _getAppDir: function(aId) {
    return FileUtils.getDir(DIRECTORY_NAME, ["webapps", aId], true, true);
  },

  _writeFile: function ss_writeFile(aFile, aData, aCallbak) {
    debug("Saving " + aFile.path);
    // Initialize the file output stream.
    let ostream = FileUtils.openSafeFileOutputStream(aFile);

    // Obtain a converter to convert our data to a UTF-8 encoded input stream.
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                    .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";

    // Asynchronously copy the data to the file.
    let istream = converter.convertToInputStream(aData);
    NetUtil.asyncCopy(istream, ostream, function(rc) {
      if (aCallbak)
        aCallbak();
    });
  },

  launchApp: function launchApp(aData, aMm) {
    let app = this.getAppByManifestURL(aData.manifestURL);
    if (!app) {
      aMm.sendAsyncMessage("Webapps:Launch:Return:KO", aData);
      return;
    }

    // Fire an error when trying to launch an app that is not
    // yet fully installed.
    if (app.installState == "pending") {
      aMm.sendAsyncMessage("Webapps:Launch:Return:KO", aData);
      return;
    }

    Services.obs.notifyObservers(aMm, "webapps-launch", JSON.stringify(aData));
  },

  cancelDownload: function cancelDownload(aManifestURL, aError) {
    debug("cancelDownload " + aManifestURL);
    let error = aError || "DOWNLOAD_CANCELED";
    let download = AppDownloadManager.get(aManifestURL);
    if (!download) {
      debug("Could not find a download for " + aManifestURL);
      return;
    }

    let app = this.webapps[download.appId];

    if (download.cacheUpdate) {
      // Cancel hosted app download.
      app.isCanceling = true;
      try {
        download.cacheUpdate.cancel();
      } catch (e) {
        delete app.isCanceling;
        debug (e);
      }
    } else if (download.channel) {
      // Cancel packaged app download.
      app.isCanceling = true;
      try {
        download.channel.cancel(Cr.NS_BINDING_ABORTED);
      } catch(e) {
        delete app.isCanceling;
      }
    } else {
      return;
    }

    let app = this.webapps[download.appId];
    app.progress = 0;
    app.installState = download.previousState;
    app.downloading = false;
    this._saveApps((function() {
      this.broadcastMessage("Webapps:PackageEvent",
                             { type: "canceled",
                               manifestURL:  app.manifestURL,
                               app: app,
                               error: error });
    }).bind(this));
    AppDownloadManager.remove(aManifestURL);
  },

  startDownload: function startDownload(aManifestURL) {
    debug("startDownload for " + aManifestURL);
    let id = this._appIdForManifestURL(aManifestURL);
    let app = this.webapps[id];
    if (!app) {
      debug("startDownload: No app found for " + aManifestURL);
      return;
    }

    if (app.downloading) {
      debug("app is already downloading. Ignoring.");
      return;
    }

    // If the caller is trying to start a download but we have nothing to
    // download, send an error.
    if (!app.downloadAvailable) {
      this.broadcastMessage("Webapps:PackageEvent",
                            { type: "canceled",
                              manifestURL: app.manifestURL,
                              app: app,
                              error: "NO_DOWNLOAD_AVAILABLE" });
      return;
    }

    // First of all, we check if the download is supposed to update an
    // already installed application.
    let isUpdate = (app.installState == "installed");

    // An app download would only be triggered for two reasons: an app
    // update or while retrying to download a previously failed or canceled
    // instalation.
    app.retryingDownload = !isUpdate;

    // We need to get the update manifest here, not the webapp manifest.
    // If this is an update, the update manifest is staged.
    let file = FileUtils.getFile(DIRECTORY_NAME,
                                 ["webapps", id,
                                  isUpdate ? "staged-update.webapp"
                                           : "update.webapp"],
                                 true);

    if (!file.exists()) {
      // This is a hosted app, let's check if it has an appcache
      // and download it.
      this._readManifests([{ id: id }], (function readManifest(aResults) {
        let jsonManifest = aResults[0].manifest;
        let manifest = new ManifestHelper(jsonManifest, app.origin);

        if (manifest.appcache_path) {
          debug("appcache found");
          this.startOfflineCacheDownload(manifest, app, null, null, isUpdate);
        } else {
          // hosted app with no appcache, nothing to do, but we fire a
          // downloaded event
          debug("No appcache found, sending 'downloaded' for " + aManifestURL);
          app.downloadAvailable = false;
          DOMApplicationRegistry.broadcastMessage("Webapps:PackageEvent",
                                                  { type: "downloaded",
                                                    manifestURL: aManifestURL,
                                                    app: app,
                                                    manifest: jsonManifest });
          DOMApplicationRegistry._saveApps();
        }
      }).bind(this));

      return;
    }

    this._loadJSONAsync(file, (function(aJSON) {
      if (!aJSON) {
        debug("startDownload: No update manifest found at " + file.path + " " + aManifestURL);
        return;
      }

      let manifest = new ManifestHelper(aJSON, app.installOrigin);
      this.downloadPackage(manifest, {
          manifestURL: aManifestURL,
          origin: app.origin,
          installOrigin: app.installOrigin,
          downloadSize: app.downloadSize
        }, isUpdate, function(aId, aManifest) {
          // Success! Keep the zip in of TmpD, we'll move it out when
          // applyDownload() will be called.
          let tmpDir = FileUtils.getDir("TmpD", ["webapps", aId], true, true);

          // Save the manifest in TmpD also
          let manFile = tmpDir.clone();
          manFile.append("manifest.webapp");
          DOMApplicationRegistry._writeFile(manFile,
                                            JSON.stringify(aManifest),
                                            function() { });
          // Set state and fire events.
          app.downloading = false;
          app.downloadAvailable = false;
          app.readyToApplyDownload = true;
          app.updateTime = Date.now();
          DOMApplicationRegistry._saveApps(function() {
            debug("About to fire Webapps:PackageEvent");
            DOMApplicationRegistry.broadcastMessage("Webapps:PackageEvent",
                                                    { type: "downloaded",
                                                      manifestURL: aManifestURL,
                                                      app: app });
            if (app.installState == "pending") {
              // We restarted a failed download, apply it automatically.
              DOMApplicationRegistry.applyDownload(aManifestURL);
            }
          });
        });
    }).bind(this));
  },

  applyDownload: function applyDownload(aManifestURL) {
    debug("applyDownload for " + aManifestURL);
    let id = this._appIdForManifestURL(aManifestURL);
    let app = this.webapps[id];
    if (!app || (app && !app.readyToApplyDownload)) {
      return;
    }

    // We need to get the old manifest to unregister web activities.
    this.getManifestFor(app.origin, (function(aOldManifest) {
      debug("Old manifest: " + JSON.stringify(aOldManifest));
      // Move the application.zip and manifest.webapp files out of TmpD
      let tmpDir = FileUtils.getDir("TmpD", ["webapps", id], true, true);
      let manFile = tmpDir.clone();
      manFile.append("manifest.webapp");
      let appFile = tmpDir.clone();
      appFile.append("application.zip");

      let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
      appFile.moveTo(dir, "application.zip");
      manFile.moveTo(dir, "manifest.webapp");

      // Move the staged update manifest to a non staged one.
      let staged = dir.clone();
      staged.append("staged-update.webapp");

      // If we are applying after a restarted download, we have no
      // staged update manifest.
      if (staged.exists()) {
        staged.moveTo(dir, "update.webapp");
      }

      try {
        tmpDir.remove(true);
      } catch(e) { }

      // Clean up the deprecated manifest cache if needed.
      if (id in this._manifestCache) {
        delete this._manifestCache[id];
      }

      // Flush the zip reader cache to make sure we use the new application.zip
      // when re-launching the application.
      let zipFile = dir.clone();
      zipFile.append("application.zip");
      Services.obs.notifyObservers(zipFile, "flush-cache-entry", null);

      // Get the manifest, and set properties.
      this.getManifestFor(app.origin, (function(aData) {
        debug("New manifest: " + JSON.stringify(aData));
        app.downloading = false;
        app.downloadAvailable = false;
        app.downloadSize = 0;
        app.installState = "installed";
        app.readyToApplyDownload = false;

        // Update the staged properties.
        if (app.staged) {
          for (let prop in app.staged) {
            app[prop] = app.staged[prop];
          }
          delete app.staged;
        }

        delete app.retryingDownload;

        this._saveApps((function() {
          // Update the handlers and permissions for this app.
          this.updateAppHandlers(aOldManifest, aData, app);
          PermissionsInstaller.installPermissions(
            { manifest: aData,
              origin: app.origin,
              manifestURL: app.manifestURL },
            true);
          this.broadcastMessage("Webapps:PackageEvent",
                                { type: "applied",
                                  manifestURL: app.manifestURL,
                                  app: app,
                                  manifest: aData });
        }).bind(this));
      }).bind(this));
    }).bind(this));
  },

  startOfflineCacheDownload: function startOfflineCacheDownload(aManifest, aApp,
                                                                aProfileDir,
                                                                aOfflineCacheObserver,
                                                                aIsUpdate) {
    if (!aManifest.appcache_path) {
      return;
    }

    // If the manifest has an appcache_path property, use it to populate the
    // appcache.
    let appcacheURI = Services.io.newURI(aManifest.fullAppcachePath(),
                                         null, null);
    let docURI = Services.io.newURI(aManifest.fullLaunchPath(), null, null);

    // We determine the app's 'installState' according to its previous
    // state. Cancelled downloads should remain as 'pending'. Successfully
    // installed apps should morph to 'updating'.
    if (aIsUpdate) {
      aApp.installState = "updating";
    }

    // We set the 'downloading' flag and update the apps registry right before
    // starting the app download/update.
    aApp.downloading = true;
    aApp.progress = 0;
    DOMApplicationRegistry._saveApps((function() {
      let cacheUpdate = aProfileDir
        ? updateSvc.scheduleCustomProfileUpdate(appcacheURI, docURI, aProfileDir)
        : updateSvc.scheduleAppUpdate(appcacheURI, docURI, aApp.localId, false);

      // We save the download details for potential further usage like
      // cancelling it.
      let download = {
        cacheUpdate: cacheUpdate,
        appId: this._appIdForManifestURL(aApp.manifestURL),
        previousState: aIsUpdate ? "installed" : "pending"
      };
      AppDownloadManager.add(aApp.manifestURL, download);

      cacheUpdate.addObserver(new AppcacheObserver(aApp), false);
      if (aOfflineCacheObserver) {
        cacheUpdate.addObserver(aOfflineCacheObserver, false);
      }
    }).bind(this));
  },

  // Returns the MD5 hash of a file, doing async IO off the main thread.
  computeFileHash: function computeFileHash(aFile, aCallback) {
    Cu.import("resource://gre/modules/osfile.jsm");
    const CHUNK_SIZE = 16384;

    // Return the two-digit hexadecimal code for a byte.
    function toHexString(charCode) {
      return ("0" + charCode.toString(16)).slice(-2);
    }

    let hasher = Cc["@mozilla.org/security/hash;1"]
                   .createInstance(Ci.nsICryptoHash);
    // We want to use the MD5 algorithm.
    hasher.init(hasher.MD5);

    OS.File.open(aFile.path, { read: true }).then(
      function opened(file) {
        let readChunk = function readChunk() {
          file.read(CHUNK_SIZE).then(
            function readSuccess(array) {
              hasher.update(array, array.length);
              if (array.length == CHUNK_SIZE) {
                readChunk();
              } else {
                // We're passing false to get the binary hash and not base64.
                let hash = hasher.finish(false);
                // convert the binary hash data to a hex string.
                aCallback([toHexString(hash.charCodeAt(i)) for (i in hash)]
                          .join(""));
              }
            },
            function readError() {
              debug("Error reading " + aFile.path);
              aCallback(null);
            }
          );
        }

        readChunk();
      },
      function openError() {
        debug("Error opening " + aFile.path);
        aCallback(null);
      }
    );
  },

  // Returns the MD5 hash of the manifest.
  computeManifestHash: function(aManifest) {
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                      .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    let result = {};
    // Data is an array of bytes.
    let data = converter.convertToByteArray(JSON.stringify(aManifest), result);

    let hasher = Cc["@mozilla.org/security/hash;1"]
                   .createInstance(Ci.nsICryptoHash);
    hasher.init(hasher.MD5);
    hasher.update(data, data.length);
    // We're passing false to get the binary hash and not base64.
    let hash = hasher.finish(false);

    function toHexString(charCode) {
      return ("0" + charCode.toString(16)).slice(-2);
    }

    // Convert the binary hash data to a hex string.
    return [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");
  },

  // Updates the activities and system message handlers.
  // aOldManifest can be null if we don't have any handler to unregister.
  updateAppHandlers: function(aOldManifest, aNewManifest, aApp) {
    debug("updateAppHandlers: old=" + aOldManifest + " new=" + aNewManifest);
    this.notifyAppsRegistryStart();
//@line 1294 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
    // Nothing else to do but notifying we're ready.
    this.notifyAppsRegistryReady();
//@line 1297 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
  },

  checkForUpdate: function(aData, aMm) {
    debug("checkForUpdate for " + aData.manifestURL);

    function sendError(aError) {
      aData.error = aError;
      aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
    }

    let id = this._appIdForManifestURL(aData.manifestURL);
    let app = this.webapps[id];

    function updatePackagedApp(aManifest) {
      debug("updatePackagedApp");

      // if the app manifestURL has a app:// scheme, we can't have an
      // update.
      if (app.manifestURL.startsWith("app://")) {
        aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
        return;
      }

      // Store the new update manifest.
      let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
      let manFile = dir.clone();
      manFile.append("staged-update.webapp");
      this._writeFile(manFile, JSON.stringify(aManifest), function() { });

      let manifest = new ManifestHelper(aManifest, app.manifestURL);
      // A package is available: set downloadAvailable to fire the matching
      // event.
      app.downloadAvailable = true;
      app.downloadSize = manifest.size;
      aData.event = "downloadavailable";
      aData.app = {
        downloadAvailable: true,
        downloadSize: manifest.size,
        updateManifest: aManifest
      }
      DOMApplicationRegistry._saveApps(function() {
        DOMApplicationRegistry.broadcastMessage("Webapps:CheckForUpdate:Return:OK",
                                                aData);
        delete aData.app.updateManifest;
      });
    }

    // A hosted app is updated if the app manifest or the appcache needs
    // updating. Even if the app manifest has not changed, we still check
    // for changes in the app cache.
    // 'aNewManifest' would contain the updated app manifest if
    // it has actually been updated, while 'aOldManifest' contains the
    // stored app manifest.
    function updateHostedApp(aOldManifest, aNewManifest) {
      debug("updateHostedApp " + aData.manifestURL);

      // Clean up the deprecated manifest cache if needed.
      if (id in this._manifestCache) {
        delete this._manifestCache[id];
      }

      app.manifest = aNewManifest || aOldManifest;

      let manifest;
      if (aNewManifest) {
        this.updateAppHandlers(aOldManifest, aNewManifest, app);

        // Store the new manifest.
        let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
        let manFile = dir.clone();
        manFile.append("manifest.webapp");
        this._writeFile(manFile, JSON.stringify(aNewManifest), function() { });
        manifest = new ManifestHelper(aNewManifest, app.origin);

        // Update the permissions for this app.
        PermissionsInstaller.installPermissions({
          manifest: app.manifest,
          origin: app.origin,
          manifestURL: aData.manifestURL
        }, true);

        app.name = manifest.name;
        app.csp = manifest.csp || "";
      } else {
        manifest = new ManifestHelper(aOldManifest, app.origin);
      }

      // Update the registry.
      this.webapps[id] = app;
      this._saveApps(function() {
        let reg = DOMApplicationRegistry;
        aData.app = app;
        if (!manifest.appcache_path) {
          aData.event = "downloadapplied";
          reg.broadcastMessage("Webapps:CheckForUpdate:Return:OK", aData);
        } else {
          // Check if the appcache is updatable, and send "downloadavailable" or
          // "downloadapplied".
          let updateObserver = {
            observe: function(aSubject, aTopic, aObsData) {
              debug("updateHostedApp: updateSvc.checkForUpdate return for " +
                    app.manifestURL + " - event is " + aTopic);
              aData.event =
                aTopic == "offline-cache-update-available" ? "downloadavailable"
                                                           : "downloadapplied";
              aData.app.downloadAvailable = (aData.event == "downloadavailable");
              reg._saveApps();
              reg.broadcastMessage("Webapps:CheckForUpdate:Return:OK", aData);
            }
          }
          debug("updateHostedApp: updateSvc.checkForUpdate for " +
                manifest.fullAppcachePath());
          updateSvc.checkForUpdate(Services.io.newURI(manifest.fullAppcachePath(), null, null),
                                   app.localId, false, updateObserver);
        }
        delete app.manifest;
      });
    }


    // We cannot update an app that does not exists.
    if (!app) {
      sendError("NO_SUCH_APP");
      return;
    }

    // We cannot update an app that is not fully installed.
    if (app.installState !== "installed") {
      sendError("PENDING_APP_NOT_UPDATABLE");
      return;
    }

    // We may be able to remove this when Bug 839071 is fixed.
    if (app.downloading) {
      sendError("APP_IS_DOWNLOADING");
      return;
    }

    // For non-removable hosted apps that lives in the core apps dir we
    // only check the appcache because we can't modify the manifest even
    // if it has changed.
    let onlyCheckAppCache = false;

//@line 1444 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

    if (onlyCheckAppCache) {
      // Bail out for packaged apps.
      if (app.origin.startsWith("app://")) {
        aData.error = "NOT_UPDATABLE";
        aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
        return;
      }

      // We need the manifest to check if we have an appcache.
      this._readManifests([{ id: id }], function(aResult) {
        let manifest = aResult[0].manifest;
        if (!manifest.appcache_path) {
          aData.error = "NOT_UPDATABLE";
          aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
          return;
        }

        debug("Checking only appcache for " + aData.manifestURL);
        // Check if the appcache is updatable, and send "downloadavailable" or
        // "downloadapplied".
        let updateObserver = {
          observe: function(aSubject, aTopic, aObsData) {
            debug("onlyCheckAppCache updateSvc.checkForUpdate return for " +
                  app.manifestURL + " - event is " + aTopic);
            if (aTopic == "offline-cache-update-available") {
              aData.event = "downloadavailable";
              app.downloadAvailable = true;
              aData.app = app;
              this._saveApps(function() {
                DOMApplicationRegistry.broadcastMessage(
                  "Webapps:CheckForUpdate:Return:OK", aData);
              });
            } else {
              aData.error = "NOT_UPDATABLE";
              aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
            }
          }
        }
        let helper = new ManifestHelper(manifest);
        debug("onlyCheckAppCache - launch updateSvc.checkForUpdate for " +
              helper.fullAppcachePath());
        updateSvc.checkForUpdate(Services.io.newURI(helper.fullAppcachePath(), null, null),
                                 app.localId, false, updateObserver);
      });
      return;
    }

    // On xhr load request event
    function onload(xhr, oldManifest) {
      debug("Got http status=" + xhr.status + " for " + aData.manifestURL);
      let oldHash = app.manifestHash;
      let isPackage = app.origin.startsWith("app://");

      if (xhr.status == 200) {
        let manifest = xhr.response;
        if (manifest == null) {
          sendError("MANIFEST_PARSE_ERROR");
          return;
        }

        if (!AppsUtils.checkManifest(manifest, app)) {
          sendError("INVALID_MANIFEST");
          return;
        } else if (!AppsUtils.checkInstallAllowed(manifest, app.installOrigin)) {
          sendError("INSTALL_FROM_DENIED");
          return;
        } else {
          AppsUtils.ensureSameAppName(oldManifest, manifest, app);

          let hash = this.computeManifestHash(manifest);
          debug("Manifest hash = " + hash);
          if (isPackage) {
            if (!app.staged) {
              app.staged = { };
            }
            app.staged.manifestHash = hash;
            app.staged.etag = xhr.getResponseHeader("Etag");
          } else {
            app.manifestHash = hash;
            app.etag = xhr.getResponseHeader("Etag");
          }

          app.lastCheckedUpdate = Date.now();
          if (isPackage) {
            if (oldHash != hash) {
              updatePackagedApp.call(this, manifest);
            } else {
              // Like if we got a 304, just send a 'downloadapplied'
              // or downloadavailable event.
              aData.event = app.downloadAvailable ? "downloadavailable"
                                                  : "downloadapplied";
              aData.app = {
                lastCheckedUpdate: app.lastCheckedUpdate
              }
              aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:OK", aData);
              this._saveApps();
            }
          } else {
            // Update only the appcache if the manifest has not changed
            // based on the hash value.
            updateHostedApp.call(this, oldManifest,
                                 oldHash == hash ? null : manifest);
          }
        }
      } else if (xhr.status == 304) {
        // The manifest has not changed.
        if (isPackage) {
          // If the app is a packaged app, we just send a 'downloadapplied'
          // or downloadavailable event.
          app.lastCheckedUpdate = Date.now();
          aData.event = app.downloadAvailable ? "downloadavailable"
                                              : "downloadapplied";
          aData.app = {
            lastCheckedUpdate: app.lastCheckedUpdate
          }
          aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:OK", aData);
          this._saveApps();
        } else {
          // For hosted apps, even if the manifest has not changed, we check
          // for offline cache updates.
          updateHostedApp.call(this, oldManifest, null);
        }
      } else {
        sendError("MANIFEST_URL_ERROR");
      }
    }

    // Try to download a new manifest.
    function doRequest(oldManifest) {
      let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                  .createInstance(Ci.nsIXMLHttpRequest);
      xhr.open("GET", aData.manifestURL, true);
      xhr.channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
      xhr.responseType = "json";
      if (app.etag) {
        debug("adding manifest etag:" + app.etag);
        xhr.setRequestHeader("If-None-Match", app.etag);
      }
      xhr.channel.notificationCallbacks =
        this.createLoadContext(app.installerAppId, app.installerIsBrowser);

      xhr.addEventListener("load", onload.bind(this, xhr, oldManifest), false);
      xhr.addEventListener("error", (function() {
        sendError("NETWORK_ERROR");
      }).bind(this), false);

      debug("Checking manifest at " + aData.manifestURL);
      xhr.send(null);
    }

    // Read the current app manifest file
    this._readManifests([{ id: id }], (function(aResult) {
      doRequest.call(this, aResult[0].manifest);
    }).bind(this));
  },

  // Creates a nsILoadContext object with a given appId and isBrowser flag.
  createLoadContext: function createLoadContext(aAppId, aIsBrowser) {
    return {
       associatedWindow: null,
       topWindow : null,
       appId: aAppId,
       isInBrowserElement: aIsBrowser,
       usePrivateBrowsing: false,
       isContent: false,

       isAppOfType: function(appType) {
         throw Cr.NS_ERROR_NOT_IMPLEMENTED;
       },

       QueryInterface: XPCOMUtils.generateQI([Ci.nsILoadContext,
                                              Ci.nsIInterfaceRequestor,
                                              Ci.nsISupports]),
       getInterface: function(iid) {
         if (iid.equals(Ci.nsILoadContext))
           return this;
         throw Cr.NS_ERROR_NO_INTERFACE;
       }
     }
  },

  // Downloads the manifest and run checks, then eventually triggers the
  // installation UI.
  doInstall: function doInstall(aData, aMm) {
    let app = aData.app;

    let sendError = function sendError(aError) {
      aData.error = aError;
      aMm.sendAsyncMessage("Webapps:Install:Return:KO", aData);
      Cu.reportError("Error installing app from: " + app.installOrigin +
                     ": " + aError);
    }.bind(this);

    // Disallow reinstalls from the same origin for now.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=821288
    if (this._appId(app.origin) !== null && this._isLaunchable(app.origin)) {
      sendError("REINSTALL_FORBIDDEN");
      return;
    }

    // Hosted apps can't be trusted or certified, so just check that the
    // manifest doesn't ask for those.
    function checkAppStatus(aManifest) {
      let manifestStatus = aManifest.type || "web";
      return manifestStatus === "web";
    }

    let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    xhr.open("GET", app.manifestURL, true);
    xhr.channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
    xhr.channel.notificationCallbacks = this.createLoadContext(aData.appId,
                                                               aData.isBrowser);
    xhr.responseType = "json";

    xhr.addEventListener("load", (function() {
      if (xhr.status == 200) {
        if (!AppsUtils.checkManifestContentType(app.installOrigin, app.origin,
                                                xhr.getResponseHeader("content-type"))) {
          sendError("INVALID_MANIFEST");
          return;
        }

        app.manifest = xhr.response;
        if (!app.manifest) {
          sendError("MANIFEST_PARSE_ERROR");
          return;
        }

        if (!AppsUtils.checkManifest(app.manifest, app)) {
          sendError("INVALID_MANIFEST");
        } else if (!AppsUtils.checkInstallAllowed(app.manifest, app.installOrigin)) {
          sendError("INSTALL_FROM_DENIED");
        } else if (!checkAppStatus(app.manifest)) {
          sendError("INVALID_SECURITY_LEVEL");
        } else {
          app.etag = xhr.getResponseHeader("Etag");
          app.manifestHash = this.computeManifestHash(app.manifest);
          // We allow bypassing the install confirmation process to facilitate
          // automation.
          let prefName = "dom.mozApps.auto_confirm_install";
          if (Services.prefs.prefHasUserValue(prefName) &&
              Services.prefs.getBoolPref(prefName)) {
            this.confirmInstall(aData);
          } else {
            Services.obs.notifyObservers(aMm, "webapps-ask-install",
                                         JSON.stringify(aData));
          }
        }
      } else {
        sendError("MANIFEST_URL_ERROR");
      }
    }).bind(this), false);

    xhr.addEventListener("error", (function() {
      sendError("NETWORK_ERROR");
    }).bind(this), false);

    xhr.send(null);
  },

  doInstallPackage: function doInstallPackage(aData, aMm) {
    let app = aData.app;

    let sendError = function sendError(aError) {
      aData.error = aError;
      aMm.sendAsyncMessage("Webapps:Install:Return:KO", aData);
      Cu.reportError("Error installing packaged app from: " +
                     app.installOrigin + ": " + aError);
    }.bind(this);

    // Disallow reinstalls from the same manifest URL for now.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=821288
    if (this.getAppLocalIdByManifestURL(app.manifestURL) !==
        Ci.nsIScriptSecurityManager.NO_APP_ID ||
        this._appId(app.origin) !== null) {
      sendError("REINSTALL_FORBIDDEN");
      return;
    }

    let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    xhr.open("GET", app.manifestURL, true);
    xhr.channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
    xhr.channel.notificationCallbacks = this.createLoadContext(aData.appId,
                                                               aData.isBrowser);
    xhr.responseType = "json";

    xhr.addEventListener("load", (function() {
      if (xhr.status == 200) {
        if (!AppsUtils.checkManifestContentType(app.installOrigin, app.origin,
                                                xhr.getResponseHeader("content-type"))) {
          sendError("INVALID_MANIFEST");
          return;
        }

        let manifest = app.updateManifest = xhr.response;
        if (!manifest) {
          sendError("MANIFEST_PARSE_ERROR");
          return;
        }

        if (!(AppsUtils.checkManifest(manifest, app) &&
              manifest.package_path)) {
          sendError("INVALID_MANIFEST");
        } else if (!AppsUtils.checkInstallAllowed(manifest, app.installOrigin)) {
          sendError("INSTALL_FROM_DENIED");
        } else {
          app.etag = xhr.getResponseHeader("Etag");
          app.manifestHash = this.computeManifestHash(manifest);
          debug("at install package got app etag=" + app.etag);
          Services.obs.notifyObservers(aMm, "webapps-ask-install",
                                       JSON.stringify(aData));
        }
      }
      else {
        sendError("MANIFEST_URL_ERROR");
      }
    }).bind(this), false);

    xhr.addEventListener("error", (function() {
      sendError("NETWORK_ERROR");
    }).bind(this), false);

    xhr.send(null);
  },

  denyInstall: function(aData) {
    let packageId = aData.app.packageId;
    if (packageId) {
      let dir = FileUtils.getDir("TmpD", ["webapps", packageId],
                                 true, true);
      try {
        dir.remove(true);
      } catch(e) {
      }
    }
    aData.mm.sendAsyncMessage("Webapps:Install:Return:KO", aData);
  },

  // This function is called after we called the onsuccess callback on the
  // content side. This let the webpage the opportunity to set event handlers
  // on the app before we start firing progress events.
  queuedDownload: {},

  onInstallSuccessAck: function onInstallSuccessAck(aManifestURL) {
    let download = this.queuedDownload[aManifestURL];
    if (!download) {
      return;
    }
    this.startOfflineCacheDownload(download.manifest,
                                   download.app,
                                   download.profileDir,
                                   download.offlineCacheObserver);
    delete this.queuedDownload[aManifestURL];
  },

  confirmInstall: function(aData, aFromSync, aProfileDir,
                           aOfflineCacheObserver,
                           aZipDownloadSuccessCallback) {
    let isReinstall = false;
    let app = aData.app;
    app.removable = true;

    let origin = Services.io.newURI(app.origin, null, null);
    let manifestURL = origin.resolve(app.manifestURL);

    let id = app.syncId || this._appId(app.origin);
    let localId = this.getAppLocalIdByManifestURL(manifestURL);

    // For packaged apps, we need to get the id from the manifestURL.
    if (localId && !id) {
      id = this._appIdForManifestURL(manifestURL);
    }

    // Installing an application again is considered as an update.
    if (id) {
      isReinstall = true;
      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch(e) {
      }
    } else {
      id = this.makeAppId();
      localId = this._nextLocalId();
    }
    app.id = id;

    let manifestName = "manifest.webapp";
    if (aData.isPackage) {
      // Override the origin with the correct id.
      app.origin = "app://" + id;

      // For packaged apps, keep the update manifest distinct from the app
      // manifest.
      manifestName = "update.webapp";
    }

    let appObject = AppsUtils.cloneAppObject(app);
    appObject.appStatus = app.appStatus || Ci.nsIPrincipal.APP_STATUS_INSTALLED;

    appObject.installTime = app.installTime = Date.now();
    appObject.lastUpdateCheck = app.lastUpdateCheck = Date.now();
    let appNote = JSON.stringify(appObject);
    appNote.id = id;

    appObject.id = id;
    appObject.localId = localId;
    appObject.basePath = FileUtils.getDir(DIRECTORY_NAME, ["webapps"], true, true).path;
    let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
    let manFile = dir.clone();
    manFile.append(manifestName);
    let jsonManifest = aData.isPackage ? app.updateManifest : app.manifest;
    this._writeFile(manFile, JSON.stringify(jsonManifest), function() { });

    let manifest = new ManifestHelper(jsonManifest, app.origin);

    if (manifest.appcache_path) {
      appObject.installState = "pending";
      appObject.downloadAvailable = true;
      appObject.downloading = true;
      appObject.downloadSize = 0;
      appObject.readyToApplyDownload = false;
    } else if (manifest.package_path) {
      appObject.installState = "pending";
      appObject.downloadAvailable = true;
      appObject.downloading = true;
      appObject.downloadSize = manifest.size;
      appObject.readyToApplyDownload = false;
    } else {
      appObject.installState = "installed";
      appObject.downloadAvailable = false;
      appObject.downloading = false;
      appObject.readyToApplyDownload = false;
    }

    appObject.name = manifest.name;
    appObject.csp = manifest.csp || "";

    appObject.installerAppId = aData.appId;
    appObject.installerIsBrowser = aData.isBrowser;

    this.webapps[id] = appObject;

    // For package apps, the permissions are not in the mini-manifest, so
    // don't update the permissions yet.
    if (!aData.isPackage) {
      PermissionsInstaller.installPermissions({ origin: appObject.origin,
                                                manifestURL: appObject.manifestURL,
                                                manifest: jsonManifest },
                                              isReinstall, (function() {
        this.uninstall(aData, aData.mm);
      }).bind(this));
    }

    ["installState", "downloadAvailable",
     "downloading", "downloadSize", "readyToApplyDownload"].forEach(function(aProp) {
      aData.app[aProp] = appObject[aProp];
     });

    this.queuedDownload[app.manifestURL] = {
      manifest: manifest,
      app: appObject,
      profileDir: aProfileDir,
      offlineCacheObserver: aOfflineCacheObserver
    }

    if (!aFromSync)
      this._saveApps((function() {
        this.broadcastMessage("Webapps:AddApp", { id: id, app: appObject });
        this.broadcastMessage("Webapps:Install:Return:OK", aData);
        Services.obs.notifyObservers(this, "webapps-sync-install", appNote);
      }).bind(this));

    if (!aData.isPackage) {
      this.updateAppHandlers(null, app.manifest, app);
    }

    if (manifest.package_path) {
      // origin for install apps is meaningless here, since it's app:// and this
      // can't be used to resolve package paths.
      manifest = new ManifestHelper(jsonManifest, app.manifestURL);
      this.downloadPackage(manifest, appObject, false, (function(aId, aManifest) {
        // Success! Move the zip out of TmpD.
        let app = DOMApplicationRegistry.webapps[id];
        let zipFile = FileUtils.getFile("TmpD", ["webapps", aId, "application.zip"], true);
        let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", aId], true, true);
        zipFile.moveTo(dir, "application.zip");
        let tmpDir = FileUtils.getDir("TmpD", ["webapps", aId], true, true);
        try {
          tmpDir.remove(true);
        } catch(e) { }

        // Save the manifest
        let manFile = dir.clone();
        manFile.append("manifest.webapp");
        this._writeFile(manFile, JSON.stringify(aManifest), function() { });
        // Set state and fire events.
        app.installState = "installed";
        app.downloading = false;
        app.downloadAvailable = false;
        this._saveApps((function() {
          this.updateAppHandlers(null, aManifest, appObject);

          // Update the permissions for this app.
          PermissionsInstaller.installPermissions({ manifest: aManifest,
                                                    origin: appObject.origin,
                                                    manifestURL: appObject.manifestURL },
                                                  true);
          debug("About to fire Webapps:PackageEvent 'installed'");
          this.broadcastMessage("Webapps:PackageEvent",
                                { type: "installed",
                                  manifestURL: appObject.manifestURL,
                                  app: app,
                                  manifest: aManifest });
          if (aZipDownloadSuccessCallback) {
            aZipDownloadSuccessCallback(aManifest);
          }
        }).bind(this));
      }).bind(this));
    }
  },

  _nextLocalId: function() {
    let id = Services.prefs.getIntPref("dom.mozApps.maxLocalId") + 1;
    Services.prefs.setIntPref("dom.mozApps.maxLocalId", id);
    return id;
  },

  _appId: function(aURI) {
    for (let id in this.webapps) {
      if (this.webapps[id].origin == aURI)
        return id;
    }
    return null;
  },

  _appIdForManifestURL: function(aURI) {
    for (let id in this.webapps) {
      if (this.webapps[id].manifestURL == aURI)
        return id;
    }
    return null;
  },

  makeAppId: function() {
    let uuidGenerator = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
    return uuidGenerator.generateUUID().toString();
  },

  _saveApps: function(aCallback) {
    this._writeFile(this.appsFile, JSON.stringify(this.webapps, null, 2), function() {
      if (aCallback)
        aCallback();
    });
  },

  /**
    * Asynchronously reads a list of manifests
    */

  _manifestCache: {},

  _readManifests: function(aData, aFinalCallback, aIndex) {
    if (!aData.length) {
      aFinalCallback(aData);
      return;
    }

    let index = aIndex || 0;
    let id = aData[index].id;

    // Use the cached manifest instead of reading the file again from disk.
    if (id in this._manifestCache) {
      aData[index].manifest = this._manifestCache[id];
      if (index == aData.length - 1)
        aFinalCallback(aData);
      else
        this._readManifests(aData, aFinalCallback, index + 1);
      return;
    }

    // the manifest file used to be named manifest.json, so fallback on this.
    let baseDir = this.webapps[id].basePath == this.getCoreAppsBasePath()
                    ? "coreAppsDir" : DIRECTORY_NAME;
    let file = FileUtils.getFile(baseDir, ["webapps", id, "manifest.webapp"], true);
    if (!file.exists()) {
      file = FileUtils.getFile(baseDir, ["webapps", id, "update.webapp"], true);
    }
    if (!file.exists()) {
      file = FileUtils.getFile(baseDir, ["webapps", id, "manifest.json"], true);
    }

    this._loadJSONAsync(file, (function(aJSON) {
      aData[index].manifest = this._manifestCache[id] = aJSON;
      if (index == aData.length - 1)
        aFinalCallback(aData);
      else
        this._readManifests(aData, aFinalCallback, index + 1);
    }).bind(this));
  },

  downloadPackage: function(aManifest, aApp, aIsUpdate, aOnSuccess) {
    // Here are the steps when installing a package:
    // - create a temp directory where to store the app.
    // - download the zip in this directory.
    // - check the signature on the zip.
    // - extract the manifest from the zip and check it.
    // - ask confirmation to the user.
    // - add the new app to the registry.
    // If we fail at any step, we backout the previous ones and return an error.

    debug("downloadPackage " + JSON.stringify(aApp));

    let id = this._appIdForManifestURL(aApp.manifestURL);
    let app = this.webapps[id];

    let self = this;
    // Removes the directory we created, and sends an error to the DOM side.
    function cleanup(aError) {
      debug("Cleanup: " + aError);
      let dir = FileUtils.getDir("TmpD", ["webapps", id], true, true);
      try {
        dir.remove(true);
      } catch (e) { }

      // We avoid notifying the error to the DOM side if the app download
      // was cancelled via cancelDownload, which already sends its own
      // notification.
      if (app.isCanceling) {
        delete app.isCanceling;
        return;
      }

      let download = AppDownloadManager.get(aApp.manifestURL);
      app.downloading = false;

      // If there were not enough storage to download the package we
      // won't have a record of the download details, so we just set the
      // installState to 'pending' at first download and to 'installed' when
      // updating.
      app.installState = download ? download.previousState
                                  : aIsUpdate ? "installed"
                                  : "pending";

      if (app.staged) {
        delete app.staged;
      }

      self.broadcastMessage("Webapps:PackageEvent",
                            { type: "error",
                              manifestURL:  aApp.manifestURL,
                              error: aError,
                              app: app });
      self._saveApps();
      AppDownloadManager.remove(aApp.manifestURL);
    }

    function sendProgressEvent() {
      self.broadcastMessage("Webapps:PackageEvent",
                            { type: "progress",
                              manifestURL: aApp.manifestURL,
                              app: app });
    }

    function download() {
      debug("About to download " + aManifest.fullPackagePath());

      let requestChannel = NetUtil.newChannel(aManifest.fullPackagePath())
                                  .QueryInterface(Ci.nsIHttpChannel);
      requestChannel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
      if (app.packageEtag) {
        debug("Add If-None-Match header: " + app.packageEtag);
        requestChannel.setRequestHeader("If-None-Match", app.packageEtag, false);
      }

      AppDownloadManager.add(aApp.manifestURL,
        {
          channel: requestChannel,
          appId: id,
          previousState: aIsUpdate ? "installed" : "pending"
        }
      );

      let lastProgressTime = 0;

      requestChannel.notificationCallbacks = {
        QueryInterface: function notifQI(aIID) {
          if (aIID.equals(Ci.nsISupports)          ||
              aIID.equals(Ci.nsIProgressEventSink) ||
              aIID.equals(Ci.nsILoadContext))
            return this;

          throw Cr.NS_ERROR_NO_INTERFACE;
        },
        getInterface: function notifGI(aIID) {
          return this.QueryInterface(aIID);
        },
        onProgress: function notifProgress(aRequest, aContext,
                                           aProgress, aProgressMax) {
          app.progress = aProgress;
          let now = Date.now();
          if (now - lastProgressTime > MIN_PROGRESS_EVENT_DELAY) {
            debug("onProgress: " + aProgress + "/" + aProgressMax);
            sendProgressEvent();
            lastProgressTime = now;
            self._saveApps();
          }
        },
        onStatus: function notifStatus(aRequest, aContext, aStatus, aStatusArg) { },

        // nsILoadContext
        appId: app.installerAppId,
        isInBrowserElement: app.installerIsBrowser,
        usePrivateBrowsing: false,
        isContent: false,
        associatedWindow: null,
        topWindow : null,
        isAppOfType: function(appType) {
          throw Cr.NS_ERROR_NOT_IMPLEMENTED;
        }
      }

      // We set the 'downloading' flag to true right before starting the fetch.
      app.downloading = true;
      // We determine the app's 'installState' according to its previous
      // state. Cancelled download should remain as 'pending'. Successfully
      // installed apps should morph to 'updating'.
      app.installState = aIsUpdate ? "updating" : "pending";

      // initialize the progress to 0 right now
      app.progress = 0;

      // Staging the zip in TmpD until all the checks are done.
      let zipFile = FileUtils.getFile("TmpD",
                                      ["webapps", id, "application.zip"], true);

      // We need an output stream to write the channel content to the zip file.
      let outputStream = Cc["@mozilla.org/network/file-output-stream;1"]
                           .createInstance(Ci.nsIFileOutputStream);
      // write, create, truncate
      outputStream.init(zipFile, 0x02 | 0x08 | 0x20, parseInt("0664", 8), 0);
      let bufferedOutputStream = Cc['@mozilla.org/network/buffered-output-stream;1']
                                   .createInstance(Ci.nsIBufferedOutputStream);
      bufferedOutputStream.init(outputStream, 1024);

      // Create a listener that will give data to the file output stream.
      let listener = Cc["@mozilla.org/network/simple-stream-listener;1"]
                       .createInstance(Ci.nsISimpleStreamListener);
      listener.init(bufferedOutputStream, {
        onStartRequest: function(aRequest, aContext) {
          // Nothing to do there anymore.
        },

        onStopRequest: function(aRequest, aContext, aStatusCode) {
          debug("onStopRequest " + aStatusCode);
          bufferedOutputStream.close();
          outputStream.close();

          if (!Components.isSuccessCode(aStatusCode)) {
            cleanup("NETWORK_ERROR");
            return;
          }

          // If we get a 4XX or a 5XX http status, bail out like if we had a
          // network error.
          let responseStatus = requestChannel.responseStatus;
          if (responseStatus >= 400 && responseStatus <= 599) {
            // unrecoverable error, don't bug the user
            app.downloadAvailable = false;
            cleanup("NETWORK_ERROR");
            return;
          }

          self.computeFileHash(zipFile, function onHashComputed(aHash) {
            debug("packageHash=" + aHash);
            let newPackage = (responseStatus != 304) &&
                             (aHash != app.packageHash);

            if (!newPackage) {
              // The package's Etag or hash has not changed.
              // We send a "applied" event right away.
              app.downloading = false;
              app.downloadAvailable = false;
              app.downloadSize = 0;
              app.installState = "installed";
              app.readyToApplyDownload = false;
              self.broadcastMessage("Webapps:PackageEvent", {
                                      type: "downloaded",
                                      manifestURL: aApp.manifestURL,
                                      app: app })
              self.broadcastMessage("Webapps:PackageEvent", {
                                      type: "applied",
                                      manifestURL: aApp.manifestURL,
                                      app: app });
              // Save the updated registry, and cleanup the tmp directory.
              self._saveApps();
              let file = FileUtils.getFile("TmpD", ["webapps", id], false);
              if (file && file.exists()) {
                file.remove(true);
              }
              return;
            }

            let certdb;
            try {
              certdb = Cc["@mozilla.org/security/x509certdb;1"]
                         .getService(Ci.nsIX509CertDB);
            } catch (e) {
              // unrecoverable error, don't bug the user
              app.downloadAvailable = false;
              cleanup("CERTDB_ERROR");
              return;
            }

            certdb.openSignedJARFileAsync(zipFile, function(aRv, aZipReader) {
              let zipReader;
              try {
                let isSigned;
                if (Components.isSuccessCode(aRv)) {
                  isSigned = true;
                  zipReader = aZipReader;
                } else if (aRv == Cr.NS_ERROR_FILE_CORRUPTED) {
                  throw "APP_PACKAGE_CORRUPTED";
                } else if (aRv != Cr.NS_ERROR_SIGNED_JAR_NOT_SIGNED) {
                  throw "INVALID_SIGNATURE";
                } else {
                  isSigned = false;
                  zipReader = Cc["@mozilla.org/libjar/zip-reader;1"]
                                .createInstance(Ci.nsIZipReader);
                  zipReader.open(zipFile);
                }

                // XXX Security: You CANNOT safely add a new app store for
                // installing privileged apps just by modifying this pref and
                // adding the signing cert for that store to the cert trust
                // database. *Any* origin listed can install apps signed with
                // *any* certificate trusted; we don't try to maintain a strong
                // association between certificate with installOrign. The
                // expectation here is that in production builds the pref will
                // contain exactly one origin. However, in custom development
                // builds it may contain more than one origin so we can test
                // different stages (dev, staging, prod) of the same app store.
                //
                // Only allow signed apps to be installed from a whitelist of
                // domains, and require all packages installed from any of the
                // domains on the whitelist to be signed. This is a stopgap until
                // we have a real story for handling multiple app stores signing
                // apps.
                let signedAppOriginsStr =
                  Services.prefs.getCharPref(
                    "dom.mozApps.signed_apps_installable_from");
                let isSignedAppOrigin
                  = signedAppOriginsStr.split(",").indexOf(aApp.installOrigin) > -1;
                if (!isSigned && isSignedAppOrigin) {
                  // Packaged apps installed from these origins must be signed;
                  // if not, assume somebody stripped the signature.
                  throw "INVALID_SIGNATURE";
                } else if (isSigned && !isSignedAppOrigin) {
                  // Other origins are *prohibited* from installing signed apps.
                  // One reason is that our app revocation mechanism requires
                  // strong cooperation from the host of the mini-manifest, which
                  // we assume to be under the control of the install origin,
                  // even if it has a different origin.
                  throw "INSTALL_FROM_DENIED";
                }

                if (!zipReader.hasEntry("manifest.webapp")) {
                  throw "MISSING_MANIFEST";
                }

                let istream = zipReader.getInputStream("manifest.webapp");

                // Obtain a converter to read from a UTF-8 encoded input stream.
                let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                                  .createInstance(Ci.nsIScriptableUnicodeConverter);
                converter.charset = "UTF-8";

                let manifest = JSON.parse(converter.ConvertToUnicode(NetUtil.readInputStreamToString(istream,
                                                                     istream.available()) || ""));

                if (!AppsUtils.checkManifest(manifest, app)) {
                  throw "INVALID_MANIFEST";
                }

                // For app updates we don't forbid apps to rename themselves but
                // we still retain the old name of the app. In the future we
                // will use UI to allow updates to rename an app after we check
                // with the user that the rename is ok.
                if (aIsUpdate) {
                  // Call ensureSameAppName before compareManifests as `manifest`
                  // has been normalized to avoid app rename.
                  AppsUtils.ensureSameAppName(aManifest._manifest, manifest,
                                              app);
                }

                if (!AppsUtils.compareManifests(manifest,
                                                aManifest._manifest)) {
                  throw "MANIFEST_MISMATCH";
                }

                if (!AppsUtils.checkInstallAllowed(manifest, aApp.installOrigin)) {
                  throw "INSTALL_FROM_DENIED";
                }

                let maxStatus = isSigned ? Ci.nsIPrincipal.APP_STATUS_PRIVILEGED
                                         : Ci.nsIPrincipal.APP_STATUS_INSTALLED;

                if (AppsUtils.getAppManifestStatus(manifest) > maxStatus) {
                  throw "INVALID_SECURITY_LEVEL";
                }
                app.appStatus = AppsUtils.getAppManifestStatus(manifest);

                // Save the new Etag for the package.
                if (aIsUpdate) {
                  if (!app.staged) {
                    app.staged = { };
                  }
                  try {
                    app.staged.packageEtag =
                      requestChannel.getResponseHeader("Etag");
                  } catch(e) { }
                  app.staged.packageHash = aHash;
                  app.staged.appStatus =
                    AppsUtils.getAppManifestStatus(manifest);
                } else {
                  try {
                    app.packageEtag = requestChannel.getResponseHeader("Etag");
                  } catch(e) { }
                  app.packageHash = aHash;
                  app.appStatus = AppsUtils.getAppManifestStatus(manifest);
                }

                if (aOnSuccess) {
                  aOnSuccess(id, manifest);
                }
              } catch (e) {
                // Something bad happened when reading the package.
                // Unrecoverable error, don't bug the user.
                // Apps with installState 'pending' does not produce any
                // notification, so we are safe with its current
                // downladAvailable state.
                if (app.installState !== "pending") {
                  app.downloadAvailable = false;
                }
                if (typeof e == 'object') {
                  Cu.reportError("Error while reading package:" + e);
                  cleanup("INVALID_PACKAGE");
                } else {
                  cleanup(e);
                }
              } finally {
                AppDownloadManager.remove(aApp.manifestURL);
                if (zipReader)
                  zipReader.close();
              }
            });
          });
        }
      });

      requestChannel.asyncOpen(listener, null);

      // send a first progress event to correctly set the DOM object's properties
      sendProgressEvent();
    };

    let checkDownloadSize = function (freeBytes) {
       if (freeBytes) {
         debug("Free storage: " + freeBytes + ". Download size: " +
               aApp.downloadSize);
         if (freeBytes <=
             aApp.downloadSize + AppDownloadManager.MIN_REMAINING_FREESPACE) {
           cleanup("INSUFFICIENT_STORAGE");
           return;
         }
       }
       download();
    };

    let deviceStorage = Services.wm.getMostRecentWindow("navigator:browser")
                                .navigator.getDeviceStorage("apps");
    if (deviceStorage) {
      let req = deviceStorage.freeSpace();
      req.onsuccess = req.onerror = function statResult(e) {
        // Even if we could not retrieve the device storage free space, we try
        // to download the package.
        if (!e.target.result) {
          download();
          return;
        }

        let freeBytes = e.target.result;
        checkDownloadSize(freeBytes);
      }
    } else {
      // deviceStorage isn't available, so use FileUtils to find the size of available storage.
      let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps"], true, true);
      try {
        checkDownloadSize(dir.diskSpaceAvailable);
      } catch(ex) {
        // If disk space information isn't available, we'll end up here.
        // We should either proceed anyway, otherwise devices that support neither
        // deviceStorage nor diskSpaceAvailable will never be able to install packaged apps.
        download();
      }
    }
  },

  uninstall: function(aData, aMm) {
    debug("uninstall " + aData.origin);
    for (let id in this.webapps) {
      let app = this.webapps[id];
      if (app.origin != aData.origin) {
        continue;
      }

      dump("-- webapps.js uninstall " + app.manifestURL + "\n");

      if (!app.removable) {
        debug("Error: cannot unintall a non-removable app.");
        break;
      }

      // Check if we are downloading something for this app, and cancel the
      // download if needed.
      this.cancelDownload(app.manifestURL);

      // Clean up the deprecated manifest cache if needed.
      if (id in this._manifestCache) {
        delete this._manifestCache[id];
      }

      // Clear private data first.
      this._clearPrivateData(app.localId, false);

      // Then notify observers.
      Services.obs.notifyObservers(aMm, "webapps-uninstall", JSON.stringify(aData));

      let appNote = JSON.stringify(AppsUtils.cloneAppObject(app));
      appNote.id = id;

//@line 2493 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch (e) {}

      delete this.webapps[id];

      this._saveApps((function() {
        aData.manifestURL = app.manifestURL;
        this.broadcastMessage("Webapps:Uninstall:Broadcast:Return:OK", aData);
        aMm.sendAsyncMessage("Webapps:Uninstall:Return:OK", aData);
        Services.obs.notifyObservers(this, "webapps-sync-uninstall", appNote);
        this.broadcastMessage("Webapps:RemoveApp", { id: id });
      }).bind(this));

      return;
    }

    // Fall-through, fails to uninstall the desired app because:
    //   - we cannot find the app to be uninstalled.
    //   - the app to be uninstalled is not removable.
    aMm.sendAsyncMessage("Webapps:Uninstall:Return:KO", aData);
  },

  getSelf: function(aData, aMm) {
    aData.apps = [];

    if (aData.appId == Ci.nsIScriptSecurityManager.NO_APP_ID ||
        aData.appId == Ci.nsIScriptSecurityManager.UNKNOWN_APP_ID) {
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
      return;
    }

    let tmp = [];

    for (let id in this.webapps) {
      if (this.webapps[id].origin == aData.origin &&
          this.webapps[id].localId == aData.appId &&
          this._isLaunchable(this.webapps[id].origin)) {
        let app = AppsUtils.cloneAppObject(this.webapps[id]);
        aData.apps.push(app);
        tmp.push({ id: id });
        break;
      }
    }

    if (!aData.apps.length) {
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
      return;
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
    }).bind(this));
  },

  checkInstalled: function(aData, aMm) {
    aData.app = null;
    let tmp = [];

    for (let appId in this.webapps) {
      if (this.webapps[appId].manifestURL == aData.manifestURL) {
        aData.app = AppsUtils.cloneAppObject(this.webapps[appId]);
        tmp.push({ id: appId });
        break;
      }
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++) {
        aData.app.manifest = aResult[i].manifest;
        break;
      }
      aMm.sendAsyncMessage("Webapps:CheckInstalled:Return:OK", aData);
    }).bind(this));
  },

  getInstalled: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      if (this.webapps[id].installOrigin == aData.origin &&
          this._isLaunchable(this.webapps[id].origin)) {
        aData.apps.push(AppsUtils.cloneAppObject(this.webapps[id]));
        tmp.push({ id: id });
      }
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetInstalled:Return:OK", aData);
    }).bind(this));
  },

  getNotInstalled: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      if (!this._isLaunchable(this.webapps[id].origin)) {
        aData.apps.push(AppsUtils.cloneAppObject(this.webapps[id]));
        tmp.push({ id: id });
      }
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetNotInstalled:Return:OK", aData);
    }).bind(this));
  },

  getAll: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      let app = AppsUtils.cloneAppObject(this.webapps[id]);
      if (!this._isLaunchable(app.origin))
        continue;

      aData.apps.push(app);
      tmp.push({ id: id });
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetAll:Return:OK", aData);
    }).bind(this));
  },

  getManifestFor: function(aOrigin, aCallback) {
    if (!aCallback)
      return;

    let id = this._appId(aOrigin);
    let app = this.webapps[id];
    if (!id || (app.installState == "pending" && !app.retryingDownload)) {
      aCallback(null);
      return;
    }

    this._readManifests([{ id: id }], function(aResult) {
      aCallback(aResult[0].manifest);
    });
  },

  /** Added to support AITC and classic sync */
  itemExists: function(aId) {
    return !!this.webapps[aId];
  },

  getAppById: function(aId) {
    if (!this.webapps[aId])
      return null;

    let app = AppsUtils.cloneAppObject(this.webapps[aId]);
    return app;
  },

  getAppByManifestURL: function(aManifestURL) {
    return AppsUtils.getAppByManifestURL(this.webapps, aManifestURL);
  },

  getCSPByLocalId: function(aLocalId) {
    debug("getCSPByLocalId:" + aLocalId);
    return AppsUtils.getCSPByLocalId(this.webapps, aLocalId);
  },

  getAppByLocalId: function(aLocalId) {
    return AppsUtils.getAppByLocalId(this.webapps, aLocalId);
  },

  getManifestURLByLocalId: function(aLocalId) {
    return AppsUtils.getManifestURLByLocalId(this.webapps, aLocalId);
  },

  getAppLocalIdByManifestURL: function(aManifestURL) {
    return AppsUtils.getAppLocalIdByManifestURL(this.webapps, aManifestURL);
  },

  getAppFromObserverMessage: function(aMessage) {
    return AppsUtils.getAppFromObserverMessage(this.webapps, aMessage);
  },

  getCoreAppsBasePath: function() {
    return AppsUtils.getCoreAppsBasePath();
  },

  getWebAppsBasePath: function getWebAppsBasePath() {
    return FileUtils.getDir(DIRECTORY_NAME, ["webapps"], false).path;
  },

  getAllWithoutManifests: function(aCallback) {
    let result = {};
    for (let id in this.webapps) {
      let app = AppsUtils.cloneAppObject(this.webapps[id]);
      result[id] = app;
    }
    aCallback(result);
  },

  updateApps: function(aRecords, aCallback) {
    for (let i = 0; i < aRecords.length; i++) {
      let record = aRecords[i];
      if (record.hidden) {
        if (!this.webapps[record.id] || !this.webapps[record.id].removable)
          continue;

        // Clean up the deprecated manifest cache if needed.
        if (record.id in this._manifestCache) {
          delete this._manifestCache[record.id];
        }

        let origin = this.webapps[record.id].origin;
        let manifestURL = this.webapps[record.id].manifestURL;
        delete this.webapps[record.id];
        let dir = this._getAppDir(record.id);
        try {
          dir.remove(true);
        } catch (e) {
        }
        this.broadcastMessage("Webapps:Uninstall:Broadcast:Return:OK",
                              { origin: origin, manifestURL: manifestURL });
      } else {
        if (this.webapps[record.id]) {
          this.webapps[record.id] = record.value;
          delete this.webapps[record.id].manifest;
        } else {
          let data = { app: record.value };
          this.confirmInstall(data, true);
          this.broadcastMessage("Webapps:Install:Return:OK", data);
        }
      }
    }
    this._saveApps(aCallback);
  },

  getAllIDs: function() {
    let apps = {};
    for (let id in this.webapps) {
      // only sync http and https apps
      if (this.webapps[id].origin.indexOf("http") == 0)
        apps[id] = true;
    }
    return apps;
  },

  wipe: function(aCallback) {
    let ids = this.getAllIDs();
    for (let id in ids) {
      if (!this.webapps[id].removable) {
        continue;
      }

      delete this.webapps[id];
      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch (e) {
      }
    }

    // Clear the manifest cache.
    this._manifestCache = { };

    this._saveApps(aCallback);
  },

  _isLaunchable: function(aOrigin) {
    if (this.allAppsLaunchable)
      return true;

//@line 2773 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"
    let uninstallKey = Cc["@mozilla.org/windows-registry-key;1"]
                         .createInstance(Ci.nsIWindowsRegKey);
    try {
      uninstallKey.open(uninstallKey.ROOT_KEY_CURRENT_USER,
                        "SOFTWARE\\Microsoft\\Windows\\" +
                        "CurrentVersion\\Uninstall\\" +
                        aOrigin,
                        uninstallKey.ACCESS_READ);
      uninstallKey.close();
      return true;
    } catch (ex) {
      return false;
    }
//@line 2819 "c:\trees\official1.7\dom\apps\src\Webapps.jsm"

  },

  _notifyCategoryAndObservers: function(subject, topic, data) {
    const serviceMarker = "service,";

    // First create observers from the category manager.
    let cm =
      Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
    let enumerator = cm.enumerateCategory(topic);

    let observers = [];

    while (enumerator.hasMoreElements()) {
      let entry =
        enumerator.getNext().QueryInterface(Ci.nsISupportsCString).data;
      let contractID = cm.getCategoryEntry(topic, entry);

      let factoryFunction;
      if (contractID.substring(0, serviceMarker.length) == serviceMarker) {
        contractID = contractID.substring(serviceMarker.length);
        factoryFunction = "getService";
      }
      else {
        factoryFunction = "createInstance";
      }

      try {
        let handler = Cc[contractID][factoryFunction]();
        if (handler) {
          let observer = handler.QueryInterface(Ci.nsIObserver);
          observers.push(observer);
        }
      } catch(e) { }
    }

    // Next enumerate the registered observers.
    enumerator = Services.obs.enumerateObservers(topic);
    while (enumerator.hasMoreElements()) {
      try {
        let observer = enumerator.getNext().QueryInterface(Ci.nsIObserver);
        if (observers.indexOf(observer) == -1) {
          observers.push(observer);
        }
      } catch (e) { }
    }

    observers.forEach(function (observer) {
      try {
        observer.observe(subject, topic, data);
      } catch(e) { }
    });
  },

  registerBrowserElementParentForApp: function(bep, appId) {
    let mm = bep._mm;

    // Make a listener function that holds on to this appId.
    let listener = this.receiveAppMessage.bind(this, appId);

    this.frameMessages.forEach(function(msgName) {
      mm.addMessageListener(msgName, listener);
    });
  },

  receiveAppMessage: function(appId, message) {
    switch (message.name) {
      case "Webapps:ClearBrowserData":
        this._clearPrivateData(appId, true);
        break;
    }
  },

  _clearPrivateData: function(appId, browserOnly) {
    let subject = {
      appId: appId,
      browserOnly: browserOnly,
      QueryInterface: XPCOMUtils.generateQI([Ci.mozIApplicationClearPrivateDataParams])
    };
    this._notifyCategoryAndObservers(subject, "webapps-clear-data", null);
  }
};

/**
 * Appcache download observer
 */
let AppcacheObserver = function(aApp) {
  debug("Creating AppcacheObserver for " + aApp.origin +
        " - " + aApp.installState);
  this.app = aApp;
  this.startStatus = aApp.installState;
  this.lastProgressTime = 0;
  // send a first progress event to correctly set the DOM object's properties
  this._sendProgressEvent();
};

AppcacheObserver.prototype = {
  // nsIOfflineCacheUpdateObserver implementation
  _sendProgressEvent: function() {
    let app = this.app;
    DOMApplicationRegistry.broadcastMessage("Webapps:OfflineCache",
                                            { manifest: app.manifestURL,
                                              installState: app.installState,
                                              progress: app.progress });
  },

  updateStateChanged: function appObs_Update(aUpdate, aState) {
    let mustSave = false;
    let app = this.app;

    debug("Offline cache state change for " + app.origin + " : " + aState);

    var self = this;
    let setStatus = function appObs_setStatus(aStatus, aProgress) {
      debug("Offlinecache setStatus to " + aStatus + " with progress " +
          aProgress + " for " + app.origin);
      mustSave = (app.installState != aStatus);
      app.installState = aStatus;
      app.progress = aProgress;
      if (aStatus == "installed") {
        app.updateTime = Date.now();
        app.downloading = false;
        app.downloadAvailable = false;
      }
      self._sendProgressEvent();
    }

    let setError = function appObs_setError(aError) {
      debug("Offlinecache setError to " + aError);
      // If we are canceling the download, we already send a DOWNLOAD_CANCELED
      // error.
      if (!app.isCanceling) {
        DOMApplicationRegistry.broadcastMessage("Webapps:OfflineCache",
                                                { manifest: app.manifestURL,
                                                  error: aError });
      } else {
        delete app.isCanceling;
      }

      app.downloading = false;
      mustSave = true;
    }

    switch (aState) {
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ERROR:
        aUpdate.removeObserver(this);
        AppDownloadManager.remove(app.manifestURL);
        setError("APP_CACHE_DOWNLOAD_ERROR");
        break;
      case Ci.nsIOfflineCacheUpdateObserver.STATE_NOUPDATE:
      case Ci.nsIOfflineCacheUpdateObserver.STATE_FINISHED:
        aUpdate.removeObserver(this);
        AppDownloadManager.remove(app.manifestURL);
        setStatus("installed", aUpdate.byteProgress);
        break;
      case Ci.nsIOfflineCacheUpdateObserver.STATE_DOWNLOADING:
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ITEMSTARTED:
        setStatus(this.startStatus, aUpdate.byteProgress);
        break;
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ITEMPROGRESS:
        let now = Date.now();
        if (now - this.lastProgressTime > MIN_PROGRESS_EVENT_DELAY) {
          setStatus(this.startStatus, aUpdate.byteProgress);
          this.lastProgressTime = now;
        }
        break;
    }

    // Status changed, update the stored version.
    if (mustSave) {
      DOMApplicationRegistry._saveApps();
    }
  },

  applicationCacheAvailable: function appObs_CacheAvail(aApplicationCache) {
    // Nothing to do.
  }
};

DOMApplicationRegistry.init();
