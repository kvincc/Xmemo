// X-note Background Service Worker
// Handles: extension icon click, sync message routing, alarms, API proxying

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
  ALARM_PUSH: 'xnote-sync-push',
  ALARM_REFRESH: 'xnote-sync-refresh',
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

  // Collect data from local storage
  const localData = await new Promise((resolve) => {
    chrome.storage.local.get(null, (result) => {
      const blob = {
        notes: {},
        globalTags: result['xNote_GlobalTags'] || {},
        schemaVersion: 1,
      };

      Object.keys(result).forEach(key => {
        if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
            && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
            && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion') {
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
    console.error('X-note background push error:', e);
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
    if (note.deleted) return;
    (note.tags || []).forEach(tag => {
      tags[tag] = (tags[tag] || 0) + 1;
    });
  });
  merged.globalTags = tags;

  return merged;
}
