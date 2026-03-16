// XStickies Cloud Sync Constants
const XNOTE_SYNC = {
  // API base URL - update this after deploying Worker
  API_URL: 'https://xnote-sync.sqxdzjd.workers.dev',

  // Google OAuth Client ID - update after creating GCP project
  GOOGLE_CLIENT_ID: '593523812920-8rggd22p787s0emmnhq6v2i6ioinj8u0.apps.googleusercontent.com',

  // Sync timing
  DEBOUNCE_SECONDS: 30,        // Delay before pushing after a save
  PULL_INTERVAL_MINUTES: 30,   // Min interval between auto-pulls
  JWT_REFRESH_DAYS_BEFORE: 2,  // Refresh JWT when < this many days left

  // Storage keys (in chrome.storage.local)
  KEY_JWT: 'xNote_sync_jwt',
  KEY_USER: 'xNote_sync_user',
  KEY_SYNC_VERSION: 'xNote_sync_version',
  KEY_SYNC_DIRTY: 'xNote_sync_dirty',
  KEY_LAST_PULL: 'xNote_sync_lastPull',
  KEY_LOGGED_IN: 'xNote_sync_loggedIn',
  KEY_SYNC_STATUS: 'xNote_sync_status',  // 'synced' | 'syncing' | 'pending' | 'offline' | 'error'
  KEY_NOTE_META: 'xNote_sync_noteMeta',  // { username: { updatedAt, deleted? } }

  // Alarm names
  ALARM_PUSH: 'xnote-sync-push',
  ALARM_REFRESH: 'xnote-sync-refresh',

  // Tombstone retention (ms)
  TOMBSTONE_MAX_AGE: 30 * 24 * 60 * 60 * 1000,  // 30 days

  // Trash bin
  TRASH_MAX_AGE: 14 * 24 * 60 * 60 * 1000,  // 14 days
  KEY_TRASH_META: 'xNote_trashMeta',          // Non-logged-in users' trash metadata
  ALARM_TRASH_CLEANUP: 'xnote-trash-cleanup',

  // Schema version for blob format
  SCHEMA_VERSION: 1,

  // Max push retries on conflict
  MAX_CONFLICT_RETRIES: 3,
};

// Make available in different contexts
if (typeof globalThis !== 'undefined') {
  globalThis.XNOTE_SYNC = XNOTE_SYNC;
}
