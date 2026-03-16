// XStickies Background Service Worker
// Handles: extension icon click, sync message routing, alarms, API proxying

const XNOTE_REMOTE_LOG = true;
function remoteLog(level, ...args) {
  if (!XNOTE_REMOTE_LOG) return;
  fetch('http://localhost:9234', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, source: 'background', args }),
  }).catch(() => {});
}

// --- Import constants (inline since service workers can't use content_scripts) ---
const SYNC_CONFIG = {
  API_URL: 'https://xnote-sync.sqxdzjd.workers.dev',
  KEY_JWT: 'xNote_sync_jwt',
  KEY_USER: 'xNote_sync_user',
  KEY_SYNC_VERSION: 'xNote_sync_version',
  KEY_SYNC_DIRTY: 'xNote_sync_dirty',
  KEY_LAST_PULL: 'xNote_sync_lastPull',
  KEY_LOGGED_IN: 'xNote_sync_loggedIn',
  KEY_SYNC_STATUS: 'xNote_sync_status',
  KEY_NOTE_META: 'xNote_sync_noteMeta',
  TOMBSTONE_MAX_AGE: 30 * 24 * 60 * 60 * 1000,
  TRASH_MAX_AGE: 14 * 24 * 60 * 60 * 1000,
  KEY_TRASH_META: 'xNote_trashMeta',
  ALARM_PUSH: 'xnote-sync-push',
  ALARM_REFRESH: 'xnote-sync-refresh',
  ALARM_TRASH_CLEANUP: 'xnote-trash-cleanup',
  DEBOUNCE_SECONDS: 30,
};

// --- Existing functionality ---

function sendCleanupToXTabs() {
  chrome.tabs.query({ url: ["*://*.x.com/*", "*://*.twitter.com/*"] }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'cleanup' }).catch(() => {});
    });
  });
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(sendCleanupToXTabs);
chrome.runtime.onInstalled.addListener(sendCleanupToXTabs);

// --- Version update detection ---
chrome.runtime.onUpdateAvailable.addListener((details) => {
  chrome.storage.local.set({ xNote_updateAvailable: details.version });
});

// --- Message handler for auth/sync operations ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'cleanup') {
    return false;
  }

  if (message.action === 'xnote-auth-google') {
    handleAuthGoogle(message.idToken).then(sendResponse);
    return true; // async response
  }

  if (message.action === 'xnote-auth-refresh') {
    handleAuthRefresh().then(sendResponse);
    return true;
  }

  if (message.action === 'xnote-sync-pull') {
    handleSyncPull(message.version).then(sendResponse);
    return true;
  }

  if (message.action === 'xnote-sync-push') {
    handleSyncPush(message.data, message.expectedVersion).then(sendResponse);
    return true;
  }

  if (message.action === 'xnote-delete-user') {
    handleDeleteUser().then(sendResponse);
    return true;
  }

  if (message.action === 'xnote-schedule-push') {
    schedulePushAlarm();
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'xnote-load-locale') {
    (async () => {
      try {
        const url = chrome.runtime.getURL(`_locales/${message.lang}/messages.json`);
        const resp = await fetch(url);
        const data = await resp.json();
        sendResponse({ data });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async response
  }

  return false;
});

// --- Alarm handler ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_CONFIG.ALARM_PUSH) {
    await executePush();
  }
  if (alarm.name === SYNC_CONFIG.ALARM_REFRESH) {
    await handleAuthRefresh();
  }
  if (alarm.name === SYNC_CONFIG.ALARM_TRASH_CLEANUP) {
    await executeTrashCleanup();
  }
});

// Schedule trash cleanup alarm (every 6 hours)
chrome.alarms.create(SYNC_CONFIG.ALARM_TRASH_CLEANUP, {
  periodInMinutes: 360,
  delayInMinutes: 1,
});

function schedulePushAlarm() {
  // MV3 alarms minimum period is 30 seconds (0.5 minutes)
  chrome.alarms.create(SYNC_CONFIG.ALARM_PUSH, {
    delayInMinutes: SYNC_CONFIG.DEBOUNCE_SECONDS / 60,
  });
}

// --- API helper ---

async function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SYNC_CONFIG.KEY_JWT], (result) => {
      resolve(result[SYNC_CONFIG.KEY_JWT] || null);
    });
  });
}

async function apiRequest(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(`${SYNC_CONFIG.API_URL}${path}`, options);

  if (resp.status === 304) {
    return { status: 304 };
  }

  const data = await resp.json();
  if (!resp.ok) {
    return { error: data.error || `HTTP ${resp.status}`, status: resp.status, ...data };
  }
  return data;
}

// --- Auth handlers ---

async function handleAuthGoogle(idToken) {
  try {
    const result = await apiRequest('POST', '/api/auth/google', { idToken });
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleAuthRefresh() {
  try {
    const token = await getToken();
    if (!token) return { error: 'No token' };

    const resp = await fetch(`${SYNC_CONFIG.API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    const data = await resp.json();
    if (resp.ok && data.token) {
      await new Promise(r => chrome.storage.local.set({
        [SYNC_CONFIG.KEY_JWT]: data.token,
        [SYNC_CONFIG.KEY_USER]: data.user,
      }, r));
    }
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

// --- Sync handlers ---

async function handleSyncPull(clientVersion) {
  try {
    const token = await getToken();
    if (!token) return { error: 'Not logged in' };

    const v = clientVersion || 0;
    const result = await apiRequest('GET', `/api/sync?version=${v}`, null, token);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSyncPush(data, expectedVersion) {
  try {
    const token = await getToken();
    if (!token) return { error: 'Not logged in' };

    const result = await apiRequest('PUT', '/api/sync', { data, expectedVersion }, token);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleDeleteUser() {
  try {
    const token = await getToken();
    if (!token) return { error: 'Not logged in' };

    const result = await apiRequest('DELETE', '/api/user', null, token);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Execute push: collect data from local storage and push to server.
 * Called by alarm handler.
 */
async function executePush() {
  const isLoggedIn = await new Promise(r =>
    chrome.storage.local.get([SYNC_CONFIG.KEY_LOGGED_IN, SYNC_CONFIG.KEY_SYNC_DIRTY], (result) => {
      r({ loggedIn: result[SYNC_CONFIG.KEY_LOGGED_IN], dirty: result[SYNC_CONFIG.KEY_SYNC_DIRTY] });
    })
  );

  if (!isLoggedIn.loggedIn || !isLoggedIn.dirty) return;

  const token = await getToken();
  if (!token) return;

  // Collect data from local storage (with per-note updatedAt + tombstones)
  const localData = await new Promise((resolve) => {
    chrome.storage.local.get(null, (result) => {
      const noteMeta = result[SYNC_CONFIG.KEY_NOTE_META] || {};
      const blob = {
        notes: {},
        globalTags: result['xNote_GlobalTags'] || {},
        schemaVersion: 1,
      };

      Object.keys(result).forEach(key => {
        if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
            && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
            && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion'
            && key !== SYNC_CONFIG.KEY_TRASH_META) {
          const username = key.replace('xNote_', '');
          const tagKey = `xNoteTags_${username}`;
          const meta = noteMeta[username];
          const noteObj = {
            text: result[key] || '',
            tags: result[tagKey] || [],
            updatedAt: (meta && meta.updatedAt) || Date.now(),
          };
          if (meta && meta.trashed) {
            noteObj.trashed = true;
            noteObj.trashedAt = meta.trashedAt;
          }
          blob.notes[username] = noteObj;
        }
      });

      // Include tombstones for deleted notes
      Object.entries(noteMeta).forEach(([username, meta]) => {
        if (meta.deleted && !blob.notes[username]) {
          const age = Date.now() - (meta.updatedAt || 0);
          if (age <= SYNC_CONFIG.TOMBSTONE_MAX_AGE) {
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

  const version = await new Promise(r =>
    chrome.storage.local.get([SYNC_CONFIG.KEY_SYNC_VERSION], (result) =>
      r(result[SYNC_CONFIG.KEY_SYNC_VERSION] || 0)
    )
  );

  try {
    await chrome.storage.local.set({ [SYNC_CONFIG.KEY_SYNC_STATUS]: 'syncing' });

    const pushResult = await apiRequest('PUT', '/api/sync', {
      data: localData,
      expectedVersion: version,
    }, token);

    if (pushResult.error === 'Version conflict') {
      // Simple conflict: pull latest, merge, push again
      const pullResult = await apiRequest('GET', `/api/sync?version=0`, null, token);
      if (pullResult.data) {
        const merged = mergeBlobs(localData, pullResult.data);
        const retryResult = await apiRequest('PUT', '/api/sync', {
          data: merged,
          expectedVersion: pullResult.version,
        }, token);
        if (!retryResult.error) {
          await chrome.storage.local.set({
            [SYNC_CONFIG.KEY_SYNC_VERSION]: retryResult.version,
            [SYNC_CONFIG.KEY_SYNC_DIRTY]: false,
            [SYNC_CONFIG.KEY_SYNC_STATUS]: 'synced',
          });
          return;
        }
      }
      await chrome.storage.local.set({ [SYNC_CONFIG.KEY_SYNC_STATUS]: 'error' });
      return;
    }

    if (pushResult.error) {
      await chrome.storage.local.set({ [SYNC_CONFIG.KEY_SYNC_STATUS]: 'error' });
      return;
    }

    await chrome.storage.local.set({
      [SYNC_CONFIG.KEY_SYNC_VERSION]: pushResult.version,
      [SYNC_CONFIG.KEY_SYNC_DIRTY]: false,
      [SYNC_CONFIG.KEY_SYNC_STATUS]: 'synced',
    });
  } catch (e) {
    console.error('XStickies background push error:', e);
    await chrome.storage.local.set({ [SYNC_CONFIG.KEY_SYNC_STATUS]: 'offline' });
  }
}

function mergeBlobs(local, server) {
  const merged = { notes: {}, schemaVersion: 1 };
  const allUsers = new Set([
    ...Object.keys(local.notes || {}),
    ...Object.keys(server.notes || {}),
  ]);

  for (const u of allUsers) {
    const l = local.notes?.[u];
    const s = server.notes?.[u];
    if (!l) merged.notes[u] = s;
    else if (!s) merged.notes[u] = l;
    else merged.notes[u] = (l.updatedAt || 0) >= (s.updatedAt || 0) ? l : s;
  }

  // Rebuild globalTags
  const tags = {};
  Object.values(merged.notes).forEach(note => {
    if (note.deleted || note.trashed) return;
    (note.tags || []).forEach(tag => {
      tags[tag] = (tags[tag] || 0) + 1;
    });
  });
  merged.globalTags = tags;

  return merged;
}

/**
 * Clean up expired trash items (trashedAt + TRASH_MAX_AGE).
 * Converts expired trashed notes to tombstones (logged in) or deletes them (not logged in).
 */
async function executeTrashCleanup() {
  const isLoggedIn = await new Promise(r =>
    chrome.storage.local.get([SYNC_CONFIG.KEY_LOGGED_IN], (result) => r(!!result[SYNC_CONFIG.KEY_LOGGED_IN]))
  );

  const now = Date.now();

  if (isLoggedIn) {
    // Logged in: check noteMeta for trashed items
    const result = await new Promise(r => chrome.storage.local.get([SYNC_CONFIG.KEY_NOTE_META], r));
    const meta = result[SYNC_CONFIG.KEY_NOTE_META] || {};
    const expiredKeys = [];

    Object.entries(meta).forEach(([username, m]) => {
      if (m.trashed && m.trashedAt && (now - m.trashedAt) > SYNC_CONFIG.TRASH_MAX_AGE) {
        expiredKeys.push(username);
      }
    });

    if (expiredKeys.length === 0) return;

    // Remove note data and convert to tombstones
    const storageKeysToRemove = [];
    expiredKeys.forEach(username => {
      storageKeysToRemove.push(`xNote_${username}`);
      storageKeysToRemove.push(`xNoteTags_${username}`);
      meta[username] = { updatedAt: now, deleted: true };
    });

    await new Promise(r => chrome.storage.local.remove(storageKeysToRemove, r));
    await new Promise(r => chrome.storage.local.set({
      [SYNC_CONFIG.KEY_NOTE_META]: meta,
      [SYNC_CONFIG.KEY_SYNC_DIRTY]: true,
    }, r));

    // Schedule a push to sync the tombstones
    schedulePushAlarm();
  } else {
    // Not logged in: check trashMeta in sync storage
    const result = await new Promise(r => chrome.storage.sync.get([SYNC_CONFIG.KEY_TRASH_META], r));
    const trashMeta = result[SYNC_CONFIG.KEY_TRASH_META] || {};
    const expiredKeys = [];

    Object.entries(trashMeta).forEach(([username, m]) => {
      if (m.trashedAt && (now - m.trashedAt) > SYNC_CONFIG.TRASH_MAX_AGE) {
        expiredKeys.push(username);
      }
    });

    if (expiredKeys.length === 0) return;

    // Remove note data and trashMeta entries
    const storageKeysToRemove = [];
    expiredKeys.forEach(username => {
      storageKeysToRemove.push(`xNote_${username}`);
      storageKeysToRemove.push(`xNoteTags_${username}`);
      delete trashMeta[username];
    });

    await new Promise(r => chrome.storage.sync.remove(storageKeysToRemove, r));
    await new Promise(r => chrome.storage.sync.set({ [SYNC_CONFIG.KEY_TRASH_META]: trashMeta }, r));
  }
}
