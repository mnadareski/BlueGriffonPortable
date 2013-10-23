/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is BlueGriffon.
 *
 * The Initial Developer of the Original Code is
 * Disruptive Innovations SARL.
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Daniel Glazman <daniel.glazman@disruptive-innovations.com>, Original author
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

Components.utils.import("resource://app/modules/editorHelper.jsm");

var EXPORTED_SYMBOLS = ["PromptUtils"];

var PromptUtils = {

  /********** ATTRIBUTES **********/

  mPromptService: null,

  /********** PRIVATE **********/

  _getPromptService: function()
  {
    if (!this.mPromptService)
    {
      try {
        this.mPromptService =
          Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                    .getService(Components.interfaces.nsIPromptService);
      }
      catch(e) { }
    }
    return this.mPromptService;
  },

  /********** PUBLIC **********/

  alertWithTitle: function (aTitle, aMsg, aParentWindow)
  {
    var parentWindow = aParentWindow ? aParentWindow : EditorUtils.getCurrentEditorWindow();

    if (this._getPromptService())
    {
      if (!aTitle)
        aTitle = L10NUtils.getString("Alert");

      this.mPromptService.alert(parentWindow, aTitle, aMsg);
    }
  },

  confirmWithTitle: function (aTitle, aMsg, aOkBtnText, aCancelBtnText, aExtraButtonText)
  {
    const nsIPromptService = Components.interfaces.nsIPromptService;

    var promptService = this._getPromptService();
    if (promptService)
    {
      var okFlag = aOkBtnText ? nsIPromptService.BUTTON_TITLE_IS_STRING
                              : nsIPromptService.BUTTON_TITLE_OK;
      var cancelFlag = aCancelBtnText ? nsIPromptService.BUTTON_TITLE_IS_STRING
                                      : nsIPromptService.BUTTON_TITLE_CANCEL;
      var extraFlag = aExtraButtonText ? nsIPromptService.BUTTON_TITLE_IS_STRING : 0;
      return promptService.confirmEx(EditorUtils.getCurrentEditorWindow(),
                                     aTitle,
                                     aMsg,
                                     (okFlag * nsIPromptService.BUTTON_POS_0) +
                                       (cancelFlag * nsIPromptService.BUTTON_POS_1) +
                                       (extraFlag  * nsIPromptService.BUTTON_POS_2) +
                                       nsIPromptService.BUTTON_POS_0_DEFAULT,
                                     aOkBtnText,
                                     aCancelBtnText,
                                     aExtraButtonText,
                                     null,
                                     {value:0});
    }
    return false;
  },

  confirm: function(aTitle, aMsg, aWindow)
  {
    var promptService = this._getPromptService();
    if (promptService)
    {
      return promptService.confirm(aWindow ? aWindow : EditorUtils.getCurrentEditorWindow(),
                                   aTitle,
                                   aMsg)
    }
    return false;
  },

  prompt: function(window, captionStr, msgStr, result)
  {
    return this._getPromptService().prompt(window, captionStr, msgStr, result, null, {value:0});
  }
};
