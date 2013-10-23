/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ['ContactDB'];

const DEBUG = false;
function debug(s) { dump("-*- ContactDB component: " + s + "\n"); }

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/IndexedDBHelper.jsm");
Cu.import("resource://gre/modules/PhoneNumberUtils.jsm");
Cu.import("resource://gre/modules/Timer.jsm");

const DB_NAME = "contacts";
const DB_VERSION = 8;
const STORE_NAME = "contacts";
const SAVED_GETALL_STORE_NAME = "getallcache";
const CHUNK_SIZE = 20;

this.ContactDB = function ContactDB(aGlobal) {
  if (DEBUG) debug("Constructor");
  this._global = aGlobal;
}

ContactDB.prototype = {
  __proto__: IndexedDBHelper.prototype,

  upgradeSchema: function upgradeSchema(aTransaction, aDb, aOldVersion, aNewVersion) {
    if (DEBUG) debug("upgrade schema from: " + aOldVersion + " to " + aNewVersion + " called!");
    let db = aDb;
    let objectStore;
    for (let currVersion = aOldVersion; currVersion < aNewVersion; currVersion++) {
      if (currVersion == 0) {
        /**
         * Create the initial database schema.
         *
         * The schema of records stored is as follows:
         *
         * {id:            "...",       // UUID
         *  published:     Date(...),   // First published date.
         *  updated:       Date(...),   // Last updated date.
         *  properties:    {...}        // Object holding the ContactProperties
         * }
         */
        if (DEBUG) debug("create schema");
        objectStore = db.createObjectStore(STORE_NAME, {keyPath: "id"});

        // Properties indexes
        objectStore.createIndex("familyName", "properties.familyName", { multiEntry: true });
        objectStore.createIndex("givenName",  "properties.givenName",  { multiEntry: true });

        objectStore.createIndex("familyNameLowerCase", "search.familyName", { multiEntry: true });
        objectStore.createIndex("givenNameLowerCase",  "search.givenName",  { multiEntry: true });
        objectStore.createIndex("telLowerCase",        "search.tel",        { multiEntry: true });
        objectStore.createIndex("emailLowerCase",      "search.email",      { multiEntry: true });
      } else if (currVersion == 1) {
        if (DEBUG) debug("upgrade 1");

        // Create a new scheme for the tel field. We move from an array of tel-numbers to an array of
        // ContactTelephone.
        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }
        // Delete old tel index.
        if (objectStore.indexNames.contains("tel")) {
          objectStore.deleteIndex("tel");
        }

        // Upgrade existing tel field in the DB.
        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (DEBUG) debug("upgrade tel1: " + JSON.stringify(cursor.value));
            for (let number in cursor.value.properties.tel) {
              cursor.value.properties.tel[number] = {number: number};
            }
            cursor.update(cursor.value);
            if (DEBUG) debug("upgrade tel2: " + JSON.stringify(cursor.value));
            cursor.continue();
          }
        };

        // Create new searchable indexes.
        objectStore.createIndex("tel", "search.tel", { multiEntry: true });
        objectStore.createIndex("category", "properties.category", { multiEntry: true });
      } else if (currVersion == 2) {
        if (DEBUG) debug("upgrade 2");
        // Create a new scheme for the email field. We move from an array of emailaddresses to an array of
        // ContactEmail.
        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }

        // Delete old email index.
        if (objectStore.indexNames.contains("email")) {
          objectStore.deleteIndex("email");
        }

        // Upgrade existing email field in the DB.
        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (cursor.value.properties.email) {
              if (DEBUG) debug("upgrade email1: " + JSON.stringify(cursor.value));
              cursor.value.properties.email =
                cursor.value.properties.email.map(function(address) { return { address: address }; });
              cursor.update(cursor.value);
              if (DEBUG) debug("upgrade email2: " + JSON.stringify(cursor.value));
            }
            cursor.continue();
          }
        };

        // Create new searchable indexes.
        objectStore.createIndex("email", "search.email", { multiEntry: true });
      } else if (currVersion == 3) {
        if (DEBUG) debug("upgrade 3");

        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }

        // Upgrade existing impp field in the DB.
        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (cursor.value.properties.impp) {
              if (DEBUG) debug("upgrade impp1: " + JSON.stringify(cursor.value));
              cursor.value.properties.impp =
                cursor.value.properties.impp.map(function(value) { return { value: value }; });
              cursor.update(cursor.value);
              if (DEBUG) debug("upgrade impp2: " + JSON.stringify(cursor.value));
            }
            cursor.continue();
          }
        };
        // Upgrade existing url field in the DB.
        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (cursor.value.properties.url) {
              if (DEBUG) debug("upgrade url1: " + JSON.stringify(cursor.value));
              cursor.value.properties.url =
                cursor.value.properties.url.map(function(value) { return { value: value }; });
              cursor.update(cursor.value);
              if (DEBUG) debug("upgrade impp2: " + JSON.stringify(cursor.value));
            }
            cursor.continue();
          }
        };
      } else if (currVersion == 4) {
        if (DEBUG) debug("Add international phone numbers upgrade");
        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }

        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (cursor.value.properties.tel) {
              if (DEBUG) debug("upgrade : " + JSON.stringify(cursor.value));
              cursor.value.properties.tel.forEach(
                function(duple) {
                  let parsedNumber = PhoneNumberUtils.parse(duple.value.toString());
                  if (parsedNumber) {
                    if (DEBUG) {
                      debug("InternationalFormat: " + parsedNumber.internationalFormat);
                      debug("InternationalNumber: " + parsedNumber.internationalNumber);
                      debug("NationalNumber: " + parsedNumber.nationalNumber);
                      debug("NationalFormat: " + parsedNumber.nationalFormat);
                    }
                    if (duple.value.toString() !== parsedNumber.internationalNumber) {
                      cursor.value.search.tel.push(parsedNumber.internationalNumber);
                    }
                  } else {
                    dump("Warning: No international number found for " + duple.value + "\n");
                  }
                }
              )
              cursor.update(cursor.value);
            }
            if (DEBUG) debug("upgrade2 : " + JSON.stringify(cursor.value));
            cursor.continue();
          }
        };
      } else if (currVersion == 5) {
        if (DEBUG) debug("Add index for equals tel searches");
        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }

        // Delete old tel index (not on the right field).
        if (objectStore.indexNames.contains("tel")) {
          objectStore.deleteIndex("tel");
        }

        // Create new index for "equals" searches
        objectStore.createIndex("tel", "search.exactTel", { multiEntry: true });

        objectStore.openCursor().onsuccess = function(event) {
          let cursor = event.target.result;
          if (cursor) {
            if (cursor.value.properties.tel) {
              if (DEBUG) debug("upgrade : " + JSON.stringify(cursor.value));
              cursor.value.properties.tel.forEach(
                function(duple) {
                  let number = duple.value.toString();
                  let parsedNumber = PhoneNumberUtils.parse(number);

                  cursor.value.search.exactTel = [number];
                  if (parsedNumber &&
                      parsedNumber.internationalNumber &&
                      number !== parsedNumber.internationalNumber) {
                    cursor.value.search.exactTel.push(parsedNumber.internationalNumber);
                  }
                }
              )
              cursor.update(cursor.value);
            }
            if (DEBUG) debug("upgrade : " + JSON.stringify(cursor.value));
            cursor.continue();
          }
        };
      } else if (currVersion == 6) {
        if (!objectStore) {
          objectStore = aTransaction.objectStore(STORE_NAME);
        }
        let names = objectStore.indexNames;
        let blackList = ["tel", "familyName", "givenName",  "familyNameLowerCase",
                         "givenNameLowerCase", "telLowerCase", "category", "email",
                         "emailLowerCase"];
        for (var i = 0; i < names.length; i++) {
          if (blackList.indexOf(names[i]) < 0) {
            objectStore.deleteIndex(names[i]);
          }
        }
      } else if (currVersion == 7) {
        if (DEBUG) debug("Adding object store for cached searches");
        db.createObjectStore(SAVED_GETALL_STORE_NAME);
      }
    }
  },

  makeImport: function makeImport(aContact) {
    let contact = {};
    contact.properties = {
      name:            [],
      honorificPrefix: [],
      givenName:       [],
      additionalName:  [],
      familyName:      [],
      honorificSuffix: [],
      nickname:        [],
      email:           [],
      photo:           [],
      url:             [],
      category:        [],
      adr:             [],
      tel:             [],
      org:             [],
      jobTitle:        [],
      bday:            null,
      note:            [],
      impp:            [],
      anniversary:     null,
      sex:             null,
      genderIdentity:  null
    };

    contact.search = {
      givenName:       [],
      familyName:      [],
      email:           [],
      category:        [],
      tel:             [],
      exactTel:        []
    };

    for (let field in aContact.properties) {
      contact.properties[field] = aContact.properties[field];
      // Add search fields
      if (aContact.properties[field] && contact.search[field]) {
        for (let i = 0; i <= aContact.properties[field].length; i++) {
          if (aContact.properties[field][i]) {
            if (field == "tel") {
              // Special case telephone number.
              // "+1-234-567" should also be found with 1234, 234-56, 23456

              // Chop off the first characters
              let number = aContact.properties[field][i].value;
              contact.search.exactTel.push(number);
              let search = {};
              if (number) {
                for (let i = 0; i < number.length; i++) {
                  search[number.substring(i, number.length)] = 1;
                }
                // Store +1-234-567 as ["1234567", "234567"...]
                let digits = number.match(/\d/g);
                if (digits && number.length != digits.length) {
                  digits = digits.join('');
                  for(let i = 0; i < digits.length; i++) {
                    search[digits.substring(i, digits.length)] = 1;
                  }
                }
                if (DEBUG) debug("lookup: " + JSON.stringify(contact.search[field]));
                let parsedNumber = PhoneNumberUtils.parse(number.toString());
                if (parsedNumber) {
                  if (DEBUG) {
                    debug("InternationalFormat: " + parsedNumber.internationalFormat);
                    debug("InternationalNumber: " + parsedNumber.internationalNumber);
                    debug("NationalNumber: " + parsedNumber.nationalNumber);
                    debug("NationalFormat: " + parsedNumber.nationalFormat);
                  }
                  if (parsedNumber.internationalNumber &&
                      number.toString() !== parsedNumber.internationalNumber) {
                    contact.search.exactTel.push(parsedNumber.internationalNumber);
                    let digits = parsedNumber.internationalNumber.match(/\d/g);
                    if (digits) {
                      digits = digits.join('');
                      for(let i = 0; i < digits.length; i++) {
                        search[digits.substring(i, digits.length)] = 1;
                      }
                    }
                  }
                } else {
                  dump("Warning: No international number found for " + number + "\n");
                }
              }
              for (let num in search) {
                contact.search[field].push(num);
              }
            } else if (field == "impp" || field == "email") {
              let value = aContact.properties[field][i].value;
              if (value && typeof value == "string") {
                contact.search[field].push(value.toLowerCase());
              }
            } else {
              let val = aContact.properties[field][i];
              if (typeof val == "string") {
                contact.search[field].push(val.toLowerCase());
              }
            }
          }
        }
      }
    }
    if (DEBUG) debug("contact:" + JSON.stringify(contact));

    contact.updated = aContact.updated;
    contact.published = aContact.published;
    contact.id = aContact.id;

    return contact;
  },

  makeExport: function makeExport(aRecord) {
    let contact = {};
    contact.properties = aRecord.properties;

    for (let field in aRecord.properties)
      contact.properties[field] = aRecord.properties[field];

    contact.updated = aRecord.updated;
    contact.published = aRecord.published;
    contact.id = aRecord.id;
    return contact;
  },

  updateRecordMetadata: function updateRecordMetadata(record) {
    if (!record.id) {
      Cu.reportError("Contact without ID");
    }
    if (!record.published) {
      record.published = new Date();
    }
    record.updated = new Date();
  },

  removeObjectFromCache: function CDB_removeObjectFromCache(aObjectId, aCallback) {
    if (DEBUG) debug("removeObjectFromCache: " + aObjectId);
    if (!aObjectId) {
      if (DEBUG) debug("No object ID passed");
      return;
    }
    this.newTxn("readwrite", SAVED_GETALL_STORE_NAME, function(txn, store) {
      store.openCursor().onsuccess = function(e) {
        let cursor = e.target.result;
        if (cursor) {
          for (let i = 0; i < cursor.value.length; ++i) {
            if (cursor.value[i] == aObjectId) {
              if (DEBUG) debug("id matches cache");
              cursor.value.splice(i, 1);
              cursor.update(cursor.value);
              break;
            }
          }
          cursor.continue();
        } else {
          aCallback();
        }
      }.bind(this);
    }.bind(this));
  },

  // Invalidate the entire cache. It will be incrementally regenerated on demand
  // See getCacheForQuery
  invalidateCache: function CDB_invalidateCache() {
    if (DEBUG) debug("invalidate cache");
    this.newTxn("readwrite", SAVED_GETALL_STORE_NAME, function (txn, store) {
      store.clear();
    });
  },

  saveContact: function saveContact(aContact, successCb, errorCb) {
    let contact = this.makeImport(aContact);
    this.newTxn("readwrite", STORE_NAME, function (txn, store) {
      if (DEBUG) debug("Going to update" + JSON.stringify(contact));

      // Look up the existing record and compare the update timestamp.
      // If no record exists, just add the new entry.
      let newRequest = store.get(contact.id);
      newRequest.onsuccess = function (event) {
        if (!event.target.result) {
          if (DEBUG) debug("new record!")
          this.updateRecordMetadata(contact);
          store.put(contact);
        } else {
          if (DEBUG) debug("old record!")
          if (new Date(typeof contact.updated === "undefined" ? 0 : contact.updated) < new Date(event.target.result.updated)) {
            if (DEBUG) debug("rev check fail!");
            txn.abort();
            return;
          } else {
            if (DEBUG) debug("rev check OK");
            contact.published = event.target.result.published;
            contact.updated = new Date();
            store.put(contact);
          }
        }
        this.invalidateCache();
      }.bind(this);
    }.bind(this), successCb, errorCb);
  },

  removeContact: function removeContact(aId, aSuccessCb, aErrorCb) {
    if (DEBUG) debug("removeContact: " + aId);
    this.removeObjectFromCache(aId, function() {
      this.newTxn("readwrite", STORE_NAME, function(txn, store) {
        store.delete(aId).onsuccess = function() {
          aSuccessCb();
        };
      }, null, aErrorCb);
    }.bind(this));
  },

  clear: function clear(aSuccessCb, aErrorCb) {
    this.newTxn("readwrite", STORE_NAME, function (txn, store) {
      if (DEBUG) debug("Going to clear all!");
      store.clear();
    }, aSuccessCb, aErrorCb);
  },

  createCacheForQuery: function CDB_createCacheForQuery(aQuery, aSuccessCb, aFailureCb) {
    this.find(function (aContacts) {
      if (aContacts) {
        let contactsArray = [];
        for (let i in aContacts) {
          contactsArray.push(aContacts[i]);
        }

        // save contact ids in cache
        this.newTxn("readwrite", SAVED_GETALL_STORE_NAME, function(txn, store) {
          store.put(contactsArray.map(function(el) el.id), aQuery);
        });

        // send full contacts
        aSuccessCb(contactsArray, true);
      } else {
        aSuccessCb([], true);
      }
    }.bind(this),
    function (aErrorMsg) { aFailureCb(aErrorMsg); },
    JSON.parse(aQuery));
  },

  getCacheForQuery: function CDB_getCacheForQuery(aQuery, aSuccessCb) {
    if (DEBUG) debug("getCacheForQuery");
    // Here we try to get the cached results for query `aQuery'. If they don't
    // exist, it means the cache was invalidated and needs to be recreated, so
    // we do that. Otherwise, we just return the existing cache.
    this.newTxn("readonly", SAVED_GETALL_STORE_NAME, function(txn, store) {
      let req = store.get(aQuery);
      req.onsuccess = function(e) {
        if (e.target.result) {
          if (DEBUG) debug("cache exists");
          aSuccessCb(e.target.result, false);
        } else {
          if (DEBUG) debug("creating cache for query " + aQuery);
          this.createCacheForQuery(aQuery, aSuccessCb);
        }
      }.bind(this);
      req.onerror = function() {

      };
    }.bind(this));
  },

  getAll: function CDB_getAll(aSuccessCb, aFailureCb, aOptions) {
    if (DEBUG) debug("getAll")
    let optionStr = JSON.stringify(aOptions);
    this.getCacheForQuery(optionStr, function(aCachedResults, aFullContacts) {
      // aFullContacts is true if the cache didn't exist and had to be created.
      // In that case, we receive the full contacts since we already have them
      // in memory to create the cache anyway. This allows us to avoid accessing
      // the main object store again.
      if (aCachedResults && aCachedResults.length > 0) {
        if (DEBUG) debug("query returned " + aCachedResults.length + " contacts");
        if (aFullContacts) {
          if (DEBUG) debug("full contacts: " + aCachedResults.length);
          while(aCachedResults.length) {
            aSuccessCb(aCachedResults.splice(0, CHUNK_SIZE));
          }
          aSuccessCb(null);
        } else {
          let count = 0;
          let sendChunk = function(start) {
            let chunk = [];
            this.newTxn("readonly", STORE_NAME, function(txn, store) {
              for (let i = start; i < Math.min(start+CHUNK_SIZE, aCachedResults.length); ++i) {
                store.get(aCachedResults[i]).onsuccess = function(e) {
                  chunk.push(e.target.result);
                  count++;
                  if (count == aCachedResults.length) {
                    aSuccessCb(chunk);
                    aSuccessCb(null);
                  } else if (chunk.length == CHUNK_SIZE) {
                    aSuccessCb(chunk);
                    chunk.length = 0;
                    setTimeout(sendChunk.bind(this, start+CHUNK_SIZE), 0);
                  }
                };
              }
            });
          }.bind(this);
          sendChunk(0);
        }
      } else { // no contacts
        if (DEBUG) debug("query returned no contacts");
        aSuccessCb(null);
      }
    }.bind(this));
  },

  /*
   * Sorting the contacts by sortBy field. aSortBy can either be familyName or givenName.
   * If 2 entries have the same sortyBy field or no sortBy field is present, we continue
   * sorting with the other sortyBy field.
   */
  sortResults: function CDB_sortResults(aResults, aFindOptions) {
    if (!aFindOptions)
      return;
    if (aFindOptions.sortBy != "undefined") {
      aResults.sort(function (a, b) {
        let x, y;
        let result = 0;
        let sortOrder = aFindOptions.sortOrder;
        let sortBy = aFindOptions.sortBy == "familyName" ? [ "familyName", "givenName" ] : [ "givenName" , "familyName" ];
        let xIndex = 0;
        let yIndex = 0;

        do {
          while (xIndex < sortBy.length && !x) {
            x = a.properties[sortBy[xIndex]] ? a.properties[sortBy[xIndex]][0].toLowerCase() : null;
            xIndex++;
          }
          if (!x) {
            return sortOrder == 'ascending' ? 1 : -1;
          }
          while (yIndex < sortBy.length && !y) {
            y = b.properties[sortBy[yIndex]] ? b.properties[sortBy[yIndex]][0].toLowerCase() : null;
            yIndex++;
          }
          if (!y) {
            return sortOrder == 'ascending' ? 1 : -1;
          }

          result = x.localeCompare(y);
          x = null;
          y = null;
        } while (result == 0);

        return sortOrder == 'ascending' ? result : -result;
      });
    }
    if (aFindOptions.filterLimit && aFindOptions.filterLimit != 0) {
      if (DEBUG) debug("filterLimit is set: " + aFindOptions.filterLimit);
      aResults.splice(aFindOptions.filterLimit, aResults.length);
    }
  },

  /**
   * @param successCb
   *        Callback function to invoke with result array.
   * @param failureCb [optional]
   *        Callback function to invoke when there was an error.
   * @param options [optional]
   *        Object specifying search options. Possible attributes:
   *        - filterBy
   *        - filterOp
   *        - filterValue
   *        - count
   */
  find: function find(aSuccessCb, aFailureCb, aOptions) {
    if (DEBUG) debug("ContactDB:find val:" + aOptions.filterValue + " by: " + aOptions.filterBy + " op: " + aOptions.filterOp);
    let self = this;
    this.newTxn("readonly", STORE_NAME, function (txn, store) {
      if (aOptions && (aOptions.filterOp == "equals" || aOptions.filterOp == "contains")) {
        self._findWithIndex(txn, store, aOptions);
      } else {
        self._findAll(txn, store, aOptions);
      }
    }, aSuccessCb, aFailureCb);
  },

  _findWithIndex: function _findWithIndex(txn, store, options) {
    if (DEBUG) debug("_findWithIndex: " + options.filterValue +" " + options.filterOp + " " + options.filterBy + " ");
    let fields = options.filterBy;
    for (let key in fields) {
      if (DEBUG) debug("key: " + fields[key]);
      if (!store.indexNames.contains(fields[key]) && fields[key] != "id") {
        if (DEBUG) debug("Key not valid!" + fields[key] + ", " + store.indexNames);
        txn.abort();
        return;
      }
    }

    // lookup for all keys
    if (options.filterBy.length == 0) {
      if (DEBUG) debug("search in all fields!" + JSON.stringify(store.indexNames));
      for(let myIndex = 0; myIndex < store.indexNames.length; myIndex++) {
        fields = Array.concat(fields, store.indexNames[myIndex])
      }
    }

    // Sorting functions takes care of limit if set.
    let limit = options.sortBy === 'undefined' ? options.filterLimit : null;

    let filter_keys = fields.slice();
    for (let key = filter_keys.shift(); key; key = filter_keys.shift()) {
      let request;
      if (key == "id") {
        // store.get would return an object and not an array
        request = store.mozGetAll(options.filterValue);
      } else if (key == "category") {
        let index = store.index(key);
        request = index.mozGetAll(options.filterValue, limit);
      } else if (options.filterOp == "equals") {
        if (DEBUG) debug("Getting index: " + key);
        // case sensitive
        let index = store.index(key);
        request = index.mozGetAll(options.filterValue, limit);
      } else {
        // not case sensitive
        let tmp = typeof options.filterValue == "string"
                  ? options.filterValue.toLowerCase()
                  : options.filterValue.toString().toLowerCase();
        if (key === 'tel') {
          let digits = tmp.match(/\d/g);
          if (digits) {
            tmp = digits.join('');
          }
        }
        let range = this._global.IDBKeyRange.bound(tmp, tmp + "\uFFFF");
        let index = store.index(key + "LowerCase");
        request = index.mozGetAll(range, limit);
      }
      if (!txn.result)
        txn.result = {};

      request.onsuccess = function (event) {
        if (DEBUG) debug("Request successful. Record count: " + event.target.result.length);
        this.sortResults(event.target.result, options);
        for (let i in event.target.result)
          txn.result[event.target.result[i].id] = this.makeExport(event.target.result[i]);
      }.bind(this);
    }
  },

  _findAll: function _findAll(txn, store, options) {
    if (DEBUG) debug("ContactDB:_findAll:  " + JSON.stringify(options));
    if (!txn.result)
      txn.result = {};
    // Sorting functions takes care of limit if set.
    let limit = options.sortBy === 'undefined' ? options.filterLimit : null;
    store.mozGetAll(null, limit).onsuccess = function (event) {
      if (DEBUG) debug("Request successful. Record count:" + event.target.result.length);
      this.sortResults(event.target.result, options);
      for (let i in event.target.result) {
        txn.result[event.target.result[i].id] = this.makeExport(event.target.result[i]);
      }
    }.bind(this);
  },

  init: function init(aGlobal) {
      this.initDBHelper(DB_NAME, DB_VERSION, [STORE_NAME, SAVED_GETALL_STORE_NAME], aGlobal);
  }
};
