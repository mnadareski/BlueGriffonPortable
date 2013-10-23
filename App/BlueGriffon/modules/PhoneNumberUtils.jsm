/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

"use strict";

this.EXPORTED_SYMBOLS = ["PhoneNumberUtils"];

const DEBUG = false;
function debug(s) { if(DEBUG) dump("-*- PhoneNumberutils: " + s + "\n"); }

const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import("resource://gre/modules/PhoneNumber.jsm");
Cu.import("resource://gre/modules/mcc_iso3166_table.jsm");

//@line 23 "c:\trees\official1.7\dom\phonenumberutils\PhoneNumberUtils.jsm"

this.PhoneNumberUtils = {
  //  1. See whether we have a network mcc
  //  2. If we don't have that, look for the simcard mcc
  //  3. TODO: If we don't have that or its 0 (not activated), pick up the last used mcc
  //  4. If we don't have, default to some mcc

  // mcc for Brasil
  _mcc: '724',

  _getCountryName: function() {
    let mcc;
    let countryName;

//@line 59 "c:\trees\official1.7\dom\phonenumberutils\PhoneNumberUtils.jsm"
    mcc = this._mcc;
//@line 61 "c:\trees\official1.7\dom\phonenumberutils\PhoneNumberUtils.jsm"

    countryName = MCC_ISO3166_TABLE[mcc];
    if (DEBUG) debug("MCC: " + mcc + "countryName: " + countryName);
    return countryName;
  },

  parse: function(aNumber) {
    if (DEBUG) debug("call parse: " + aNumber);
    let result = PhoneNumber.Parse(aNumber, this._getCountryName());
    if (DEBUG) {
      if (result) {
        debug("InternationalFormat: " + result.internationalFormat);
        debug("InternationalNumber: " + result.internationalNumber);
        debug("NationalNumber: " + result.nationalNumber);
        debug("NationalFormat: " + result.nationalFormat);
      } else {
        debug("No result!\n");
      }
    }
    return result;
  },

  parseWithMCC: function(aNumber, aMCC) {
    let countryName = MCC_ISO3166_TABLE[aMCC];
    if (DEBUG) debug("found country name: " + countryName);
    return PhoneNumber.Parse(aNumber, countryName);
  },

  isPlainPhoneNumber: function isPlainPhoneNumber(aNumber) {
    var isPlain = PhoneNumber.IsPlain(aNumber);
    if (DEBUG) debug("isPlain(" + aNumber + ") " + isPlain);
    return isPlain;
  },

  normalize: function Normalize(aNumber) {
    var normalized = PhoneNumber.Normalize(aNumber);
    if (DEBUG) debug("normalize(" + aNumber + "): " + normalized);
    return normalized;
  }
};
