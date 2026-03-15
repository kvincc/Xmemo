/**
 * X-note Sync Manager
 * Handles Pull/Push/Conflict merge with the cloud API.
 * All network requests go through background service worker messages.
 */

const syncManager = (() => {

  /**
   * Pull latest data from server.
   * Called on page load (if >5min since last pull), options page open, manual sync.
   */
  async function pull() {
    const token = await xnoteAuth.getToken();
    if (!token) return { skipped: true, reason: 'not logged in' };

    await setSyncStatus('syncing');

    try {
      const localVersion = await getLocalVersion();
      const result = await sendMessage({
        action: 'xnote-sync-pull',
        version: localVersion,
      });

      if (result.error) {
        await setSyncStatus('error');
        return { error: result.error };
      }

      if (result.status === 304) {
        // Already up to date
        await setStorageData({ [XNOTE_SYNC.KEY_LAST_PULL]: Date.now() });
        await setSyncStatus('synced');
        return { upToDate: true };
      }

      if (result.data) {
        // Write server data to local storage
        await applyServerData(result.data);
        await setStorageData({
          [XNOTE_SYNC.KEY_SYNC_VERSION]: result.version,
          [XNOTE_SYNC.KEY_LAST_PULL]: Date.now(),
        });
      }

      await setSyncStatus('synced');
      return { ok: true, version: result.version };
    } catch (e) {
      console.error('X-note sync pull error:', e);
      await setSyncStatus('offline');
      return { error: e.message };
    }
  }

  /**
   * Push local data to server.
   * Called after debounce timer or manual sync.
   */
  async function push(retryCount = 0) {
    const token = await xnoteAuth.getToken();
    if (!token) return { skipped: true, reason: 'not logged in' };

    await setSyncStatus('syncing');

    try {
      const localData = await collectLocalData();
      const localVersion = await getLocalVersion();

      const result = await sendMessage({
        action: 'xnote-sync-push',
        data: localData,
        expectedVersion: localVersion,
      });

      if (result.error === 'Version conflict' && retryCount < XNOTE_SYNC.MAX_CONFLICT_RETRIES) {
        // Merge and retry
        const merged = mergeData(localData, result.serverData);
        // Write merged data locally
        await applyServerData(merged);
        // Update local version to server version for next push
        await setStorageData({ [XNOTE_SYNC.KEY_SYNC_VERSION]: result.serverVersion });
        // Retry push with merged data
        return push(retryCount + 1);
      }

      if (result.error) {
        await setSyncStatus('error');
        return { error: result.error };
      }

      // Success
      await setStorageData({
        [XNOTE_SYNC.KEY_SYNC_VERSION]: result.version,
        [XNOTE_SYNC.KEY_SYNC_DIRTY]: false,
      });
      await setSyncStatus('synced');
      return { ok: true, version: result.version };
    } catch (e) {
      console.error('X-note sync push error:', e);
      await setSyncStatus('offline');
      return { error: e.message };
    }
  }

  /**
   * Full sync: pull then push if dirty.
   */
  async function fullSync() {
    const pullResult = await pull();
    if (pullResult.error) return pullResult;

    const isDirty = await getStorageValue(XNOTE_SYNC.KEY_SYNC_DIRTY);
    if (isDirty) {
      return push();
    }
    return pullResult;
  }

  /**
   * Check if enough time has passed since last pull.
   */
  async function shouldAutoPull() {
    const lastPull = await getStorageValue(XNOTE_SYNC.KEY_LAST_PULL);
    if (!lastPull) return true;
    const elapsed = Date.now() - lastPull;
    return elapsed > XNOTE_SYNC.PULL_INTERVAL_MINUTES * 60 * 1000;
  }

  /**
   * Collect all xNote data from local storage into the blob format.
   */
  async function collectLocalData() {
    return new Promise((resolve) => {
      storageAdapter.get(null, (result) => {
        const blob = {
          notes: {},
          globalTags: result['xNote_GlobalTags'] || {},
          schemaVersion: XNOTE_SYNC.SCHEMA_VERSION,
        };

        Object.keys(result).forEach(key => {
          if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
              && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme') {
            const username = key.replace('xNote_', '');
            const tagKey = `xNoteTags_${username}`;
            blob.notes[username] = {
              text: result[key] || '',
              tags: result[tagKey] || [],
              updatedAt: Date.now(),
            };
          }
        });

        resolve(blob);
      });
    });
  }

  /**
   * Apply server blob data to local storage.
   * Converts from blob format back to individual xNote_@user keys.
   */
  async function applyServerData(blob) {
    if (!blob || !blob.notes) return;

    return new Promise((resolve) => {
      const data = {};

      Object.entries(blob.notes).forEach(([username, noteData]) => {
        // Skip tombstoned notes older than retention period
        if (noteData.deleted) {
          const age = Date.now() - (noteData.updatedAt || 0);
          if (age > XNOTE_SYNC.TOMBSTONE_MAX_AGE) return;
          // Store tombstone as empty string (will be cleaned up)
          data[`xNote_${username}`] = '';
          data[`xNoteTags_${username}`] = [];
          return;
        }

        data[`xNote_${username}`] = noteData.text || '';
        if (noteData.tags && noteData.tags.length > 0) {
          data[`xNoteTags_${username}`] = noteData.tags;
        }
      });

      // Rebuild global tags from merged notes
      if (blob.globalTags) {
        data['xNote_GlobalTags'] = blob.globalTags;
      }

      // Use the underlying storage directly (don't trigger dirty)
      const storage = storageAdapter.isLoggedIn() ? chrome.storage.local : chrome.storage.sync;
      storage.set(data, resolve);
    });
  }

  /**
   * Merge local and server data blobs.
   * Per-note last-write-wins based on updatedAt.
   */
  function mergeData(local, server) {
    if (!server) return local;
    if (!local) return server;

    const merged = {
      notes: {},
      schemaVersion: XNOTE_SYNC.SCHEMA_VERSION,
    };

    const allUsers = new Set([
      ...Object.keys(local.notes || {}),
      ...Object.keys(server.notes || {}),
    ]);

    for (const u of allUsers) {
      const l = local.notes?.[u];
      const s = server.notes?.[u];

      if (!l) {
        merged.notes[u] = s;
      } else if (!s) {
        merged.notes[u] = l;
      } else {
        // Last-write-wins
        merged.notes[u] = (l.updatedAt || 0) >= (s.updatedAt || 0) ? l : s;
      }
    }

    // Rebuild globalTags from merged notes
    merged.globalTags = rebuildGlobalTags(merged.notes);

    return merged;
  }

  /**
   * Rebuild global tag counts from notes blob.
   */
  function rebuildGlobalTags(notes) {
    const tags = {};
    Object.values(notes).forEach(note => {
      if (note.deleted) return;
      (note.tags || []).forEach(tag => {
        tags[tag] = (tags[tag] || 0) + 1;
      });
    });
    return tags;
  }

  /**
   * Get current sync status.
   */
  async function getSyncStatus() {
    return getStorageValue(XNOTE_SYNC.KEY_SYNC_STATUS) || 'synced';
  }

  // --- Helpers ---

  async function getLocalVersion() {
    return (await getStorageValue(XNOTE_SYNC.KEY_SYNC_VERSION)) || 0;
  }

  async function setSyncStatus(status) {
    await setStorageData({ [XNOTE_SYNC.KEY_SYNC_STATUS]: status });
  }

  function getStorageValue(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key]);
      });
    });
  }

  function setStorageData(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { error: 'No response' });
        }
      });
    });
  }

  return {
    pull,
    push,
    fullSync,
    shouldAutoPull,
    collectLocalData,
    applyServerData,
    mergeData,
    getSyncStatus,
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.syncManager = syncManager;
}
