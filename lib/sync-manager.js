/**
 * XStickies Sync Manager
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
      let localVersion = await getLocalVersion();

      // Fix #1: If version > 0 but local storage has no actual notes, reset version
      // to force a full pull (e.g. after extension reinstall or storage clear)
      if (localVersion > 0) {
        const hasNotes = await hasLocalNotes();
        if (!hasNotes) {
          localVersion = 0;
          await setStorageData({ [XNOTE_SYNC.KEY_SYNC_VERSION]: 0 });
        }
      }

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
        // Fix #3 & #5: Full replace — remove local notes not in server data
        await applyServerData(result.data, true);
        await setStorageData({
          [XNOTE_SYNC.KEY_SYNC_VERSION]: result.version,
          [XNOTE_SYNC.KEY_LAST_PULL]: Date.now(),
        });
      }

      await setSyncStatus('synced');
      return { ok: true, version: result.version };
    } catch (e) {
      console.error('XStickies sync pull error:', e);
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
      console.error('XStickies sync push error:', e);
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
      // Read both the active storage and note metadata
      chrome.storage.local.get([XNOTE_SYNC.KEY_NOTE_META], (metaResult) => {
        const noteMeta = metaResult[XNOTE_SYNC.KEY_NOTE_META] || {};

        storageAdapter.get(null, (result) => {
          const blob = {
            notes: {},
            globalTags: result['xNote_GlobalTags'] || {},
            schemaVersion: XNOTE_SYNC.SCHEMA_VERSION,
          };

          // Collect existing notes with their stored updatedAt
          Object.keys(result).forEach(key => {
            if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
                && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
                && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion'
                && key !== XNOTE_SYNC.KEY_TRASH_META) {
              const username = key.replace('xNote_', '');
              const tagKey = `xNoteTags_${username}`;
              const meta = noteMeta[username];
              const noteObj = {
                text: result[key] || '',
                tags: result[tagKey] || [],
                updatedAt: (meta && meta.updatedAt) || Date.now(),
              };
              // Include trashed state
              if (meta && meta.trashed) {
                noteObj.trashed = true;
                noteObj.trashedAt = meta.trashedAt;
              }
              blob.notes[username] = noteObj;
            }
          });

          // Fix #2: Include tombstones for deleted notes
          Object.entries(noteMeta).forEach(([username, meta]) => {
            if (meta.deleted && !blob.notes[username]) {
              const age = Date.now() - (meta.updatedAt || 0);
              if (age <= XNOTE_SYNC.TOMBSTONE_MAX_AGE) {
                blob.notes[username] = {
                  text: '',
                  tags: [],
                  updatedAt: meta.updatedAt,
                  deleted: true,
                };
              }
            }
          });

          resolve(blob);
        });
      });
    });
  }

  /**
   * Apply server blob data to local storage.
   * Converts from blob format back to individual xNote_@user keys.
   */
  async function applyServerData(blob, fullReplace = false) {
    if (!blob || !blob.notes) return;

    const storage = storageAdapter.isLoggedIn() ? chrome.storage.local : chrome.storage.sync;

    // Fix #3: If fullReplace, remove local notes that are not in server data
    if (fullReplace) {
      await new Promise((resolve) => {
        storage.get(null, (result) => {
          const keysToRemove = Object.keys(result).filter(k =>
            (k.startsWith('xNote_') || k.startsWith('xNoteTags_'))
            && k !== 'xNote_GlobalTags'
            && !k.startsWith('xNote_sync_')
            && k !== 'xNote_detectedTheme'
            && k !== 'xNote_language'
            && k !== 'xNote_updateAvailable'
            && k !== 'xNote_dismissedVersion'
            && k !== XNOTE_SYNC.KEY_TRASH_META
          );
          if (keysToRemove.length > 0) {
            storage.remove(keysToRemove, resolve);
          } else {
            resolve();
          }
        });
      });
    }

    return new Promise((resolve) => {
      const data = {};
      const meta = {};

      Object.entries(blob.notes).forEach(([username, noteData]) => {
        // Skip tombstoned notes — don't write them to local storage
        if (noteData.deleted) {
          // Keep tombstone in metadata so it propagates on next push
          const age = Date.now() - (noteData.updatedAt || 0);
          if (age <= XNOTE_SYNC.TOMBSTONE_MAX_AGE) {
            meta[username] = { updatedAt: noteData.updatedAt, deleted: true };
          }
          return;
        }

        // Write note data (even if trashed — data stays for restore)
        data[`xNote_${username}`] = noteData.text || '';
        if (noteData.tags && noteData.tags.length > 0) {
          data[`xNoteTags_${username}`] = noteData.tags;
        }

        if (noteData.trashed) {
          meta[username] = { updatedAt: noteData.updatedAt || Date.now(), trashed: true, trashedAt: noteData.trashedAt || Date.now() };
        } else {
          meta[username] = { updatedAt: noteData.updatedAt || Date.now() };
        }
      });

      // Rebuild global tags from non-deleted notes
      if (blob.globalTags) {
        data['xNote_GlobalTags'] = blob.globalTags;
      }

      // Update note metadata
      data[XNOTE_SYNC.KEY_NOTE_META] = meta;

      // Use the underlying storage directly (don't trigger dirty)
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
      if (note.deleted || note.trashed) return;
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

  function hasLocalNotes() {
    return new Promise((resolve) => {
      storageAdapter.get(null, (result) => {
        const hasAny = Object.keys(result).some(k =>
          k.startsWith('xNote_') && !k.startsWith('xNote_sync_')
          && !k.startsWith('xNoteTags_') && k !== 'xNote_GlobalTags'
          && k !== 'xNote_detectedTheme' && k !== 'xNote_language'
          && k !== 'xNote_updateAvailable' && k !== 'xNote_dismissedVersion'
          && k !== XNOTE_SYNC.KEY_TRASH_META
        );
        resolve(hasAny);
      });
    });
  }

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
