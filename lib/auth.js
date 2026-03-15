/**
 * X-note Auth Module
 * Handles Google OAuth via chrome.identity.launchWebAuthFlow + JWT management.
 * All network requests are proxied through the background service worker.
 */

const xnoteAuth = (() => {
  /**
   * Start Google OAuth login flow.
   * Must be called from a user gesture context (e.g., button click).
   * Returns { token, user } on success, { error } on failure.
   */
  async function login() {
    try {
      // Step 1: Get Google ID token via launchWebAuthFlow
      const idToken = await getGoogleIdToken();
      if (!idToken) {
        return { error: (typeof xnoteI18n !== 'undefined' ? xnoteI18n.t('auth_login_cancelled') : null) || 'Google sign-in was cancelled or failed' };
      }

      // Step 2: Exchange ID token for our JWT via background worker
      const result = await sendMessage({
        action: 'xnote-auth-google',
        idToken,
      });

      if (result.error) {
        return { error: result.error };
      }

      // Step 3: Store JWT and user info
      await setStorageData({
        [XNOTE_SYNC.KEY_JWT]: result.token,
        [XNOTE_SYNC.KEY_USER]: result.user,
        [XNOTE_SYNC.KEY_LOGGED_IN]: true,
      });

      // Update storage adapter state
      storageAdapter.setLoggedIn(true);

      return { token: result.token, user: result.user };
    } catch (e) {
      console.error('X-note auth login error:', e);
      return { error: e.message || (typeof xnoteI18n !== 'undefined' ? xnoteI18n.t('auth_login_failed') : null) || 'Sign-in failed' };
    }
  }

  /**
   * Logout: clear all auth data, switch storage back to sync.
   */
  async function logout() {
    try {
      await removeStorageData([
        XNOTE_SYNC.KEY_JWT,
        XNOTE_SYNC.KEY_USER,
        XNOTE_SYNC.KEY_LOGGED_IN,
        XNOTE_SYNC.KEY_SYNC_VERSION,
        XNOTE_SYNC.KEY_SYNC_DIRTY,
        XNOTE_SYNC.KEY_LAST_PULL,
        XNOTE_SYNC.KEY_SYNC_STATUS,
      ]);
      storageAdapter.setLoggedIn(false);
      return { ok: true };
    } catch (e) {
      console.error('X-note auth logout error:', e);
      return { error: e.message };
    }
  }

  /**
   * Get current user info from storage.
   */
  async function getUser() {
    return new Promise((resolve) => {
      chrome.storage.local.get([XNOTE_SYNC.KEY_USER, XNOTE_SYNC.KEY_LOGGED_IN], (result) => {
        if (result[XNOTE_SYNC.KEY_LOGGED_IN] && result[XNOTE_SYNC.KEY_USER]) {
          resolve(result[XNOTE_SYNC.KEY_USER]);
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Get current JWT token.
   */
  async function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get([XNOTE_SYNC.KEY_JWT], (result) => {
        resolve(result[XNOTE_SYNC.KEY_JWT] || null);
      });
    });
  }

  /**
   * Check if JWT needs refresh (< 2 days remaining).
   */
  async function checkTokenRefresh() {
    const token = await getToken();
    if (!token) return;

    try {
      const payload = parseJWT(token);
      if (!payload || !payload.exp) return;

      const daysLeft = (payload.exp - Date.now() / 1000) / 86400;
      if (daysLeft < XNOTE_SYNC.JWT_REFRESH_DAYS_BEFORE) {
        // Request refresh via background
        const result = await sendMessage({ action: 'xnote-auth-refresh' });
        if (result.token) {
          await setStorageData({
            [XNOTE_SYNC.KEY_JWT]: result.token,
            [XNOTE_SYNC.KEY_USER]: result.user,
          });
        }
      }
    } catch (e) {
      // Token parse failed, ignore
    }
  }

  /**
   * Delete user account (GDPR).
   */
  async function deleteAccount() {
    const result = await sendMessage({ action: 'xnote-delete-user' });
    if (result.ok) {
      await logout();
    }
    return result;
  }

  // --- Internal helpers ---

  function getGoogleIdToken() {
    return new Promise((resolve, reject) => {
      const clientId = XNOTE_SYNC.GOOGLE_CLIENT_ID;
      const redirectUri = chrome.identity.getRedirectURL();
      const nonce = crypto.randomUUID();

      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: clientId,
          response_type: 'id_token',
          redirect_uri: redirectUri,
          scope: 'openid email profile',
          nonce: nonce,
        }).toString();

      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            resolve(null);
            return;
          }

          // Extract id_token from URL fragment
          const url = new URL(responseUrl);
          const params = new URLSearchParams(url.hash.substring(1));
          const idToken = params.get('id_token');
          resolve(idToken);
        }
      );
    });
  }

  function parseJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload;
    } catch (e) {
      return null;
    }
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

  function setStorageData(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }

  function removeStorageData(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });
  }

  return {
    login,
    logout,
    getUser,
    getToken,
    checkTokenRefresh,
    deleteAccount,
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.xnoteAuth = xnoteAuth;
}
