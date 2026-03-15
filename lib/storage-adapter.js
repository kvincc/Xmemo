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
      // Mark dirty for sync if logged in
      if (_isLoggedIn) {
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
  };
})();

// Make available globally
if (typeof globalThis !== 'undefined') {
  globalThis.storageAdapter = storageAdapter;
}
