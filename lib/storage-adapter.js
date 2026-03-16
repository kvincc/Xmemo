/**
 * StorageAdapter: Abstraction layer over chrome.storage.
 * - Not logged in → chrome.storage.sync (existing behavior, unchanged)
 * - Logged in → chrome.storage.local (no 100KB limit)
 *
 * Drop-in replacement: storageAdapter.get / .set / .remove / .getBytesInUse
 */

const storageAdapter = (() => {
  // Cache login state to avoid async lookup on every call
  let _isLoggedIn = false;
  let _initialized = false;

  function _getStorage() {
    return _isLoggedIn ? chrome.storage.local : chrome.storage.sync;
  }

  /**
   * Initialize by checking login state from chrome.storage.local.
   * Call once at startup; also called when login state changes.
   */
  function init(callback) {
    chrome.storage.local.get([XNOTE_SYNC.KEY_LOGGED_IN], (result) => {
      _isLoggedIn = !!result[XNOTE_SYNC.KEY_LOGGED_IN];
      _initialized = true;
      if (callback) callback(_isLoggedIn);
    });
  }

  /**
   * Update login state (called after login/logout).
   */
  function setLoggedIn(loggedIn) {
    _isLoggedIn = loggedIn;
    chrome.storage.local.set({ [XNOTE_SYNC.KEY_LOGGED_IN]: loggedIn });
  }

  function isLoggedIn() {
    return _isLoggedIn;
  }

  /**
   * Get values from the active storage backend.
   * @param {string|string[]|object|null} keys
   * @param {function} callback - (result) => {}
   */
  function get(keys, callback) {
    _getStorage().get(keys, callback);
  }

  /**
   * Set values in the active storage backend.
   * If logged in, also marks data as dirty for sync.
   * @param {object} data
   * @param {function} [callback]
   */
  function set(data, callback) {
    _getStorage().set(data, () => {
      if (chrome.runtime.lastError) {
        if (callback) callback();
        return;
      }
      // Track per-note updatedAt metadata for sync
      if (_isLoggedIn) {
        _updateNoteMeta(data);
        _markDirty();
      }
      if (callback) callback();
    });
  }

  /**
   * Remove keys from the active storage backend.
   * @param {string|string[]} keys
   * @param {function} [callback]
   */
  function remove(keys, callback) {
    _getStorage().remove(keys, () => {
      if (_isLoggedIn) {
        _tombstoneNotes(keys);
        _markDirty();
      }
      if (callback) callback();
    });
  }

  /**
   * Get bytes in use.
   * @param {string|string[]|null} keys
   * @param {function} callback - (bytesInUse) => {}
   */
  function getBytesInUse(keys, callback) {
    _getStorage().getBytesInUse(keys, callback);
  }

  /**
   * Update per-note metadata (updatedAt) when notes are saved.
   */
  function _updateNoteMeta(data) {
    const noteKeys = Object.keys(data).filter(k =>
      k.startsWith('xNote_@') || (k.startsWith('xNote_') && !k.startsWith('xNote_sync_')
        && !k.startsWith('xNoteTags_') && k !== 'xNote_GlobalTags'
        && k !== 'xNote_detectedTheme' && k !== 'xNote_language'
        && k !== 'xNote_updateAvailable' && k !== 'xNote_dismissedVersion'
        && k !== XNOTE_SYNC.KEY_TRASH_META)
    );
    if (noteKeys.length === 0) return;

    chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
      const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
      const now = Date.now();
      noteKeys.forEach(k => {
        const username = k.replace('xNote_', '');
        meta[username] = { updatedAt: now };
      });
      chrome.storage.local.set({ [XNOTE_SYNC.KEY_NOTE_META]: meta });
    });
  }

  /**
   * Mark deleted notes as tombstones in metadata.
   */
  function _tombstoneNotes(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const noteKeys = arr.filter(k => k.startsWith('xNote_') && !k.startsWith('xNoteTags_')
      && !k.startsWith('xNote_sync_') && k !== 'xNote_GlobalTags'
      && k !== 'xNote_detectedTheme' && k !== 'xNote_language'
      && k !== 'xNote_updateAvailable' && k !== 'xNote_dismissedVersion'
      && k !== XNOTE_SYNC.KEY_TRASH_META);
    if (noteKeys.length === 0) return;

    chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
      const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
      const now = Date.now();
      noteKeys.forEach(k => {
        const username = k.replace('xNote_', '');
        meta[username] = { updatedAt: now, deleted: true };
      });
      chrome.storage.local.set({ [XNOTE_SYNC.KEY_NOTE_META]: meta });
    });
  }

  /**
   * Mark data as dirty and schedule a push via background alarm.
   */
  function _markDirty() {
    chrome.storage.local.set({ [XNOTE_SYNC.KEY_SYNC_DIRTY]: true });
    // Send message to background to schedule push alarm
    try {
      chrome.runtime.sendMessage({ action: 'xnote-schedule-push' });
    } catch (e) {
      // Context may be invalidated
    }
  }

  /**
   * Listen for storage changes to keep the indicator cache in sync.
   * Returns a listener that works with the active backend.
   */
  function onChanged(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const expectedArea = _isLoggedIn ? 'local' : 'sync';
      if (areaName === expectedArea) {
        callback(changes, areaName);
      }
    });
  }

  /**
   * Get the maximum storage quota.
   * sync = 102400 bytes (100KB), local = effectively unlimited (~5MB)
   */
  function getQuota() {
    return _isLoggedIn ? 5 * 1024 * 1024 : 102400;
  }

  /**
   * Move notes to trash (mark as trashed, don't delete data).
   * @param {string|string[]} keys - xNote_@username keys
   * @param {function} [callback]
   */
  function trashNote(keys, callback) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const noteKeys = arr.filter(k => k.startsWith('xNote_@') || (k.startsWith('xNote_') && !k.startsWith('xNote_sync_')
      && !k.startsWith('xNoteTags_') && k !== 'xNote_GlobalTags'
      && k !== 'xNote_detectedTheme' && k !== 'xNote_language'
      && k !== 'xNote_updateAvailable' && k !== 'xNote_dismissedVersion'
      && k !== XNOTE_SYNC.KEY_TRASH_META));
    if (noteKeys.length === 0) { if (callback) callback(); return; }

    const now = Date.now();
    if (_isLoggedIn) {
      // Logged in: use noteMeta in chrome.storage.local
      chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
        const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
        noteKeys.forEach(k => {
          const username = k.replace('xNote_', '');
          meta[username] = { updatedAt: now, trashed: true, trashedAt: now };
        });
        chrome.storage.local.set({ [XNOTE_SYNC.KEY_NOTE_META]: meta }, () => {
          _markDirty();
          if (callback) callback();
        });
      });
    } else {
      // Not logged in: use separate trashMeta in chrome.storage.sync
      _getStorage().get([XNOTE_SYNC.KEY_TRASH_META], (result) => {
        const meta = result[XNOTE_SYNC.KEY_TRASH_META] || {};
        noteKeys.forEach(k => {
          const username = k.replace('xNote_', '');
          meta[username] = { trashedAt: now, trashed: true };
        });
        _getStorage().set({ [XNOTE_SYNC.KEY_TRASH_META]: meta }, () => {
          if (callback) callback();
        });
      });
    }
  }

  /**
   * Restore notes from trash.
   * @param {string|string[]} keys - xNote_@username keys
   * @param {function} [callback]
   */
  function restoreNote(keys, callback) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const noteKeys = arr.filter(k => k.startsWith('xNote_'));
    if (noteKeys.length === 0) { if (callback) callback(); return; }

    const now = Date.now();
    if (_isLoggedIn) {
      chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
        const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
        noteKeys.forEach(k => {
          const username = k.replace('xNote_', '');
          if (meta[username]) {
            delete meta[username].trashed;
            delete meta[username].trashedAt;
            meta[username].updatedAt = now;
          }
        });
        chrome.storage.local.set({ [XNOTE_SYNC.KEY_NOTE_META]: meta }, () => {
          _markDirty();
          if (callback) callback();
        });
      });
    } else {
      _getStorage().get([XNOTE_SYNC.KEY_TRASH_META], (result) => {
        const meta = result[XNOTE_SYNC.KEY_TRASH_META] || {};
        noteKeys.forEach(k => {
          const username = k.replace('xNote_', '');
          delete meta[username];
        });
        _getStorage().set({ [XNOTE_SYNC.KEY_TRASH_META]: meta }, () => {
          if (callback) callback();
        });
      });
    }
  }

  /**
   * Permanently delete notes (remove data + set tombstone).
   * @param {string|string[]} keys - xNote_@username keys
   * @param {function} [callback]
   */
  function permanentDelete(keys, callback) {
    const arr = Array.isArray(keys) ? keys : [keys];
    // Also collect associated tag keys
    const keysToRemove = [];
    arr.forEach(k => {
      keysToRemove.push(k);
      const username = k.replace('xNote_', '');
      keysToRemove.push(`xNoteTags_${username}`);
    });

    _getStorage().remove(keysToRemove, () => {
      if (_isLoggedIn) {
        // Set tombstone in noteMeta
        chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
          const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
          const now = Date.now();
          arr.forEach(k => {
            const username = k.replace('xNote_', '');
            meta[username] = { updatedAt: now, deleted: true };
          });
          chrome.storage.local.set({ [XNOTE_SYNC.KEY_NOTE_META]: meta }, () => {
            _markDirty();
            if (callback) callback();
          });
        });
      } else {
        // Remove from trashMeta
        _getStorage().get([XNOTE_SYNC.KEY_TRASH_META], (result) => {
          const meta = result[XNOTE_SYNC.KEY_TRASH_META] || {};
          arr.forEach(k => {
            const username = k.replace('xNote_', '');
            delete meta[username];
          });
          _getStorage().set({ [XNOTE_SYNC.KEY_TRASH_META]: meta }, () => {
            if (callback) callback();
          });
        });
      }
    });
  }

  /**
   * Get all trashed note entries.
   * @param {function} callback - ({ username, trashedAt }[]) => {}
   */
  function getTrashMeta(callback) {
    if (_isLoggedIn) {
      chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (result) => {
        const meta = result[XNOTE_SYNC.KEY_NOTE_META] || {};
        const trashed = {};
        Object.entries(meta).forEach(([username, m]) => {
          if (m.trashed) trashed[username] = m;
        });
        callback(trashed);
      });
    } else {
      _getStorage().get([XNOTE_SYNC.KEY_TRASH_META], (result) => {
        callback(result[XNOTE_SYNC.KEY_TRASH_META] || {});
      });
    }
  }

  return {
    init,
    setLoggedIn,
    isLoggedIn,
    get,
    set,
    remove,
    getBytesInUse,
    onChanged,
    getQuota,
    trashNote,
    restoreNote,
    permanentDelete,
    getTrashMeta,
  };
})();

// Make available globally
if (typeof globalThis !== 'undefined') {
  globalThis.storageAdapter = storageAdapter;
}
