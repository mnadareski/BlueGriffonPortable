/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

this.EXPORTED_SYMBOLS = ["WebappsInstaller"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/osfile.jsm");

this.WebappsInstaller = {
  /**
   * Creates a native installation of the web app in the OS
   *
   * @param aData the manifest data provided by the web app
   *
   * @returns bool true on success, false if an error was thrown
   */
  install: function(aData) {

    try {
      if (Services.prefs.getBoolPref("browser.mozApps.installer.dry_run")) {
        return true;
      }
    } catch (ex) {}

//@line 34 "c:\trees\official1.7\toolkit\webapps\WebappsInstaller.jsm"
    let shell = new WinNativeApp(aData);
//@line 42 "c:\trees\official1.7\toolkit\webapps\WebappsInstaller.jsm"

    try {
      shell.install();
    } catch (ex) {
      Cu.reportError("Error installing app: " + ex);
      return null;
    }

    let data = {
      "installDir": shell.installDir.path,
      "app": aData.app
    };
    Services.obs.notifyObservers(null, "webapp-installed", JSON.stringify(data));

    return shell;
  }
}

/**
 * This function implements the common constructor for
 * the Windows, Mac and Linux native app shells. It reads and parses
 * the data from the app manifest and stores it in the NativeApp
 * object. It's meant to be called as NativeApp.call(this, aData)
 * from the platform-specific constructor.
 *
 * @param aData the data object provided by the web app with
 *              all the app settings and specifications.
 *
 */
function NativeApp(aData) {
  let app = this.app = aData.app;

  let origin = Services.io.newURI(app.origin, null, null);

  if (app.manifest.launch_path) {
    this.launchURI = Services.io.newURI(origin.resolve(app.manifest.launch_path),
                                        null, null);
  } else {
    this.launchURI = origin.clone();
  }

  let biggestIcon = getBiggestIconURL(app.manifest.icons);
  try {
    let iconURI = Services.io.newURI(biggestIcon, null, null);
    if (iconURI.scheme == "data") {
      this.iconURI = iconURI;
    }
  } catch (ex) {}

  if (!this.iconURI) {
    try {
      this.iconURI = Services.io.newURI(origin.resolve(biggestIcon), null, null);
    }
    catch (ex) {}
  }

  this.appName = sanitize(app.manifest.name);
  this.appNameAsFilename = stripStringForFilename(this.appName);

  if(app.manifest.developer && app.manifest.developer.name) {
    let devName = app.manifest.developer.name.substr(0, 128);
    devName = sanitize(devName);
    if (devName) {
      this.developerName = devName;
    }
  }

  let shortDesc = this.appName;
  if (app.manifest.description) {
    let firstLine = app.manifest.description.split("\n")[0];
    shortDesc = firstLine.length <= 256
                ? firstLine
                : firstLine.substr(0, 253) + "...";
  }
  this.shortDescription = sanitize(shortDesc);

  // The app registry is the Firefox profile from which the app
  // was installed.
  this.registryFolder = Services.dirsvc.get("ProfD", Ci.nsIFile);

  this.webappJson = {
    "registryDir": this.registryFolder.path,
    "app": app
  };

  this.runtimeFolder = Services.dirsvc.get("GreD", Ci.nsIFile);
}

//@line 131 "c:\trees\official1.7\toolkit\webapps\WebappsInstaller.jsm"
/*************************************
 * Windows app installer
 *
 * The Windows installation process will generate the following files:
 *
 * ${FolderName} = protocol;app-origin[;port]
 *                 e.g.: subdomain.example.com;http;85
 *
 * %APPDATA%/${FolderName}
 *   - webapp.ini
 *   - webapp.json
 *   - ${AppName}.exe
 *   - ${AppName}.lnk
 *   / uninstall
 *     - webapp-uninstaller.exe
 *     - shortcuts_log.ini
 *     - uninstall.log
 *   / chrome/icons/default/
 *     - default.ico
 *
 * After the app runs for the first time, a profiles/ folder will also be
 * created which will host the user profile for this app.
 */

/**
 * Constructor for the Windows native app shell
 *
 * @param aData the data object provided by the web app with
 *              all the app settings and specifications.
 */
function WinNativeApp(aData) {
  NativeApp.call(this, aData);
  this._init();
}

WinNativeApp.prototype = {
  /**
   * Install the app in the system by creating the folder structure,
   *
   */
  install: function() {
    // Remove previously installed app (for update purposes)
    this._removeInstallation(true);

    try {
      this._createDirectoryStructure();
      this._copyPrebuiltFiles();
      this._createConfigFiles();
      this._createShortcutFiles();
      this._writeSystemKeys();
      this._createAppProfile();
    } catch (ex) {
      this._removeInstallation(false);
      throw(ex);
    }

    getIconForApp(this, function() {});
  },

  /**
   * Initializes properties that will be used during the installation process,
   * such as paths and filenames.
   */
  _init: function() {
    let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");

    this.appNameAsFilename = this.appNameAsFilename.replace(filenameRE, "");
    if (this.appNameAsFilename == "") {
      this.appNameAsFilename = "webapp";
    }

    // The ${InstallDir} format is as follows:
    //  protocol
    //  + ";" + host of the app origin
    //  + ";" + port (only if port is not default)
    this.installDir = Services.dirsvc.get("AppData", Ci.nsIFile);
    let installDirLeaf = this.launchURI.scheme
                       + ";"
                       + this.launchURI.host;
    if (this.launchURI.port != -1) {
      installDirLeaf += ";" + this.launchURI.port;
    }
    this.installDir.append(installDirLeaf);

    this.webapprt = this.installDir.clone();
    this.webapprt.append(this.appNameAsFilename + ".exe");

    this.configJson = this.installDir.clone();
    this.configJson.append("webapp.json");

    this.webappINI = this.installDir.clone();
    this.webappINI.append("webapp.ini");

    this.uninstallDir = this.installDir.clone();
    this.uninstallDir.append("uninstall");

    this.uninstallerFile = this.uninstallDir.clone();
    this.uninstallerFile.append("webapp-uninstaller.exe");

    this.iconFile = this.installDir.clone();
    this.iconFile.append("chrome");
    this.iconFile.append("icons");
    this.iconFile.append("default");
    this.iconFile.append("default.ico");

    this.uninstallSubkeyStr = this.launchURI.scheme + "://" +
                              this.launchURI.hostPort;
  },

  /**
   * Remove the current installation
   */
  _removeInstallation : function(keepProfile) {
    let uninstallKey;
    try {
      uninstallKey = Cc["@mozilla.org/windows-registry-key;1"]
                     .createInstance(Ci.nsIWindowsRegKey);
      uninstallKey.open(uninstallKey.ROOT_KEY_CURRENT_USER,
                        "SOFTWARE\\Microsoft\\Windows\\" +
                        "CurrentVersion\\Uninstall",
                        uninstallKey.ACCESS_WRITE);
      if(uninstallKey.hasChild(this.uninstallSubkeyStr)) {
        uninstallKey.removeChild(this.uninstallSubkeyStr);
      }
    } catch (e) {
    } finally {
      if(uninstallKey)
        uninstallKey.close();
    }

    let desktopShortcut = Services.dirsvc.get("Desk", Ci.nsILocalFile);
    desktopShortcut.append(this.appNameAsFilename + ".lnk");

    let startMenuShortcut = Services.dirsvc.get("Progs", Ci.nsILocalFile);
    startMenuShortcut.append(this.appNameAsFilename + ".lnk");

    let filesToRemove = [desktopShortcut, startMenuShortcut];

    if (keepProfile) {
      filesToRemove.push(this.iconFile);
      filesToRemove.push(this.webapprt);
      filesToRemove.push(this.configJson);
      filesToRemove.push(this.webappINI);
      filesToRemove.push(this.uninstallDir);
    } else {
      filesToRemove.push(this.installDir);
    }

    removeFiles(filesToRemove);
  },

  /**
   * Creates the main directory structure.
   */
  _createDirectoryStructure: function() {
    if (!this.installDir.exists())
      this.installDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.uninstallDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
  },

  /**
   * Creates the profile to be used for this app.
   */
  _createAppProfile: function() {
    let profSvc = Cc["@mozilla.org/toolkit/profile-service;1"]
                    .getService(Ci.nsIToolkitProfileService);

    try {
      this.appProfile = profSvc.createDefaultProfileForApp(this.installDir.leafName,
                                                           null, null);
    } catch (ex if ex.result == Cr.NS_ERROR_ALREADY_INITIALIZED) {}
  },

  /**
   * Copy the pre-built files into their destination folders.
   */
  _copyPrebuiltFiles: function() {
    let webapprtPre = this.runtimeFolder.clone();
    webapprtPre.append("webapprt-stub.exe");
    webapprtPre.copyTo(this.installDir, this.webapprt.leafName);

    let uninstaller = this.runtimeFolder.clone();
    uninstaller.append("webapp-uninstaller.exe");
    uninstaller.copyTo(this.uninstallDir, this.uninstallerFile.leafName);
  },

  /**
   * Creates the configuration files into their destination folders.
   */
  _createConfigFiles: function() {
    // ${InstallDir}/webapp.json
    writeToFile(this.configJson, JSON.stringify(this.webappJson));

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"]
                    .getService(Ci.nsIINIParserFactory);

    // ${InstallDir}/webapp.ini
    let writer = factory.createINIParser(this.webappINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appName);
    writer.setString("Webapp", "Profile", this.installDir.leafName);
    writer.setString("Webapp", "Executable", this.appNameAsFilename);
    writer.setString("WebappRT", "InstallDir", this.runtimeFolder.path);
    writer.writeFile(null, Ci.nsIINIParserWriter.WRITE_UTF16);

    // ${UninstallDir}/shortcuts_log.ini
    let shortcutLogsINI = this.uninstallDir.clone().QueryInterface(Ci.nsILocalFile);
    shortcutLogsINI.append("shortcuts_log.ini");

    writer = factory.createINIParser(shortcutLogsINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("STARTMENU", "Shortcut0", this.appNameAsFilename + ".lnk");
    writer.setString("DESKTOP", "Shortcut0", this.appNameAsFilename + ".lnk");
    writer.setString("TASKBAR", "Migrated", "true");
    writer.writeFile(null, Ci.nsIINIParserWriter.WRITE_UTF16);

    // ${UninstallDir}/uninstall.log
    let uninstallContent = 
      "File: \\webapp.ini\r\n" +
      "File: \\webapp.json\r\n" +
      "File: \\webapprt.old\r\n" +
      "File: \\chrome\\icons\\default\\default.ico";
    let uninstallLog = this.uninstallDir.clone();
    uninstallLog.append("uninstall.log");
    writeToFile(uninstallLog, uninstallContent);
  },

  /**
   * Writes the keys to the system registry that are necessary for the app operation
   * and uninstall process.
   */
  _writeSystemKeys: function() {
    let parentKey;
    let uninstallKey;
    let subKey;

    try {
      parentKey = Cc["@mozilla.org/windows-registry-key;1"]
                  .createInstance(Ci.nsIWindowsRegKey);
      parentKey.open(parentKey.ROOT_KEY_CURRENT_USER,
                     "SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
                     parentKey.ACCESS_WRITE);
      uninstallKey = parentKey.createChild("Uninstall", parentKey.ACCESS_WRITE)
      subKey = uninstallKey.createChild(this.uninstallSubkeyStr, uninstallKey.ACCESS_WRITE);

      subKey.writeStringValue("DisplayName", this.appName);

      subKey.writeStringValue("UninstallString", this.uninstallerFile.path);
      subKey.writeStringValue("InstallLocation", this.installDir.path);
      subKey.writeStringValue("AppFilename", this.appNameAsFilename);

      if(this.iconFile) {
        subKey.writeStringValue("DisplayIcon", this.iconFile.path);
      }

      subKey.writeIntValue("NoModify", 1);
      subKey.writeIntValue("NoRepair", 1);
    } catch(ex) {
      throw(ex);
    } finally {
      if(subKey) subKey.close();
      if(uninstallKey) uninstallKey.close();
      if(parentKey) parentKey.close();
    }
  },

  /**
   * Creates a shortcut file inside the app installation folder and makes
   * two copies of it: one into the desktop and one into the start menu.
   */
  _createShortcutFiles: function() {
    let shortcut = this.installDir.clone().QueryInterface(Ci.nsILocalFileWin);
    shortcut.append(this.appNameAsFilename + ".lnk");

    let target = this.installDir.clone();
    target.append(this.webapprt.leafName);

    /* function nsILocalFileWin.setShortcut(targetFile, workingDir, args,
                                            description, iconFile, iconIndex) */

    shortcut.setShortcut(target, this.installDir.clone(), null,
                         this.shortDescription, this.iconFile, 0);

    let desktop = Services.dirsvc.get("Desk", Ci.nsILocalFile);
    let startMenu = Services.dirsvc.get("Progs", Ci.nsILocalFile);

    shortcut.copyTo(desktop, this.appNameAsFilename + ".lnk");
    shortcut.copyTo(startMenu, this.appNameAsFilename + ".lnk");

    shortcut.followLinks = false;
    shortcut.remove(false);
  },

  /**
   * This variable specifies if the icon retrieval process should
   * use a temporary file in the system or a binary stream. This
   * is accessed by a common function in WebappsIconHelpers.js and
   * is different for each platform.
   */
  useTmpForIcon: false,

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp(). This will save the icon to the
   * topwindow.ico file.
   *
   * @param aMimeType     ahe icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aCallback     a callback function to be called
   *                      after the process finishes
   */
  processIcon: function(aMimeType, aImageStream, aCallback) {
    let iconStream;
    try {
      let imgTools = Cc["@mozilla.org/image/tools;1"]
                       .createInstance(Ci.imgITools);
      let imgContainer = { value: null };

      imgTools.decodeImageData(aImageStream, aMimeType, imgContainer);
      iconStream = imgTools.encodeImage(imgContainer.value,
                                        "image/vnd.microsoft.icon",
                                        "format=bmp;bpp=32");
    } catch (e) {
      throw("processIcon - Failure converting icon (" + e + ")");
    }

    if (!this.iconFile.parent.exists())
      this.iconFile.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    let outputStream = FileUtils.openSafeFileOutputStream(this.iconFile);
    NetUtil.asyncCopy(iconStream, outputStream);
  }
}

//@line 876 "c:\trees\official1.7\toolkit\webapps\WebappsInstaller.jsm"

/* Helper Functions */

/**
 * Async write a data string into a file
 *
 * @param aFile     the nsIFile to write to
 * @param aData     a string with the data to be written
 */
function writeToFile(aFile, aData) {
  let path = aFile.path;
  let data = new TextEncoder().encode(aData);
  return OS.File.writeAtomic(path, data, { tmpPath: path + ".tmp" });
}

/**
 * Removes unprintable characters from a string.
 */
function sanitize(aStr) {
  let unprintableRE = new RegExp("[\\x00-\\x1F\\x7F]" ,"gi");
  return aStr.replace(unprintableRE, "");
}

/**
 * Strips all non-word characters from the beginning and end of a string
 */
function stripStringForFilename(aPossiblyBadFilenameString) {
  //strip everything from the front up to the first [0-9a-zA-Z]

  let stripFrontRE = new RegExp("^\\W*","gi");
  let stripBackRE = new RegExp("\\s*$","gi");

  let stripped = aPossiblyBadFilenameString.replace(stripFrontRE, "");
  stripped = stripped.replace(stripBackRE, "");
  return stripped;
}

/**
 * Finds a unique name available in a folder (i.e., non-existent file)
 *
 * @param aFolder nsIFile that represents the directory where we want to write
 * @param aName   string with the filename (minus the extension) desired
 * @param aExtension string with the file extension, including the dot

 * @return nsILocalFile or null if folder is unwritable or unique name
 *         was not available
 */
function getAvailableFile(aFolder, aName, aExtension) {
  let folder = aFolder.QueryInterface(Ci.nsILocalFile);
  folder.followLinks = false;
  if (!folder.isDirectory() || !folder.isWritable()) {
    return null;
  }

  let file = folder.clone();
  file.append(aName + aExtension);

  if (!file.exists()) {
    return file;
  }

  for (let i = 2; i < 10; i++) {
    file.leafName = aName + " (" + i + ")" + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  for (let i = 10; i < 100; i++) {
    file.leafName = aName + "-" + i + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  return null;
}

/**
 * Attempts to remove files or directories.
 *
 * @param aFiles An array with nsIFile objects to be removed
 */
function removeFiles(aFiles) {
  for (let file of aFiles) {
    try {
      if (file.exists()) {
        file.followLinks = false;
        file.remove(true);
      }
    } catch(ex) {}
  }
}

function escapeXML(aStr) {
  return aStr.toString()
             .replace(/&/g, "&amp;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&apos;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
}

/* More helpers for handling the app icon */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This function receives a list of icon sizes
 * and URLs and returns the url string for the biggest icon.
 *
 * @param aIcons An object where the keys are the icon sizes
 *               and the values are URL strings. E.g.:
 *               aIcons = {
 *                 "16": "http://www.example.org/icon16.png",
 *                 "32": "http://www.example.org/icon32.png"
 *               };
 *
 * @returns the URL string for the largest specified icon
 */
function getBiggestIconURL(aIcons) {
  if (!aIcons) {
    return "chrome://browser/skin/webapps-64.png";
  }

  let iconSizes = Object.keys(aIcons);
  if (iconSizes.length == 0) {
    return "chrome://browser/skin/webapps-64.png";
  }
  iconSizes.sort(function(a, b) a - b);
  return aIcons[iconSizes.pop()];
}

/**
 * This function retrieves the icon for an app as specified
 * in the iconURI on the shell object.
 * Upon completion it will call aShell.processIcon()
 *
 * @param aShell The shell that specifies the properties
 *               of the native app. Three properties from this
 *               shell will be used in this function:
 *                 - iconURI
 *                 - useTmpForIcon
 *                 - processIcon()
 */
function getIconForApp(aShell, callback) {
  let iconURI = aShell.iconURI;
  let mimeService = Cc["@mozilla.org/mime;1"]
                      .getService(Ci.nsIMIMEService);

  let mimeType;
  try {
    let tIndex = iconURI.path.indexOf(";");
    if("data" == iconURI.scheme && tIndex != -1) {
      mimeType = iconURI.path.substring(0, tIndex);
    } else {
      mimeType = mimeService.getTypeFromURI(iconURI);
    }
  } catch(e) {
    throw("getIconFromURI - Failed to determine MIME type");
  }

  try {
    let listener;
    if(aShell.useTmpForIcon) {
      let downloadObserver = {
        onDownloadComplete: function(downloader, request, cx, aStatus, file) {
          // pass downloader just to keep reference around
          onIconDownloaded(aShell, mimeType, aStatus, file, callback, downloader);
        }
      };

      let tmpIcon = Services.dirsvc.get("TmpD", Ci.nsIFile);
      tmpIcon.append("tmpicon." + mimeService.getPrimaryExtension(mimeType, ""));
      tmpIcon.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0666);

      listener = Cc["@mozilla.org/network/downloader;1"]
                   .createInstance(Ci.nsIDownloader);
      listener.init(downloadObserver, tmpIcon);
    } else {
      let pipe = Cc["@mozilla.org/pipe;1"]
                   .createInstance(Ci.nsIPipe);
      pipe.init(true, true, 0, 0xffffffff, null);

      listener = Cc["@mozilla.org/network/simple-stream-listener;1"]
                   .createInstance(Ci.nsISimpleStreamListener);
      listener.init(pipe.outputStream, {
          onStartRequest: function() {},
          onStopRequest: function(aRequest, aContext, aStatusCode) {
            pipe.outputStream.close();
            onIconDownloaded(aShell, mimeType, aStatusCode, pipe.inputStream, callback);
         }
      });
    }

    let channel = NetUtil.newChannel(iconURI);
    let CertUtils = { };
    Cu.import("resource://gre/modules/CertUtils.jsm", CertUtils);
    // Pass true to avoid optional redirect-cert-checking behavior.
    channel.notificationCallbacks = new CertUtils.BadCertHandler(true);

    channel.asyncOpen(listener, null);
  } catch(e) {
    throw("getIconFromURI - Failure getting icon (" + e + ")");
  }
}

function onIconDownloaded(aShell, aMimeType, aStatusCode, aIcon, aCallback) {
  if (Components.isSuccessCode(aStatusCode)) {
    aShell.processIcon(aMimeType, aIcon, aCallback);
  } else {
    aCallback.call(aShell);
  }
}
