import { corsHeaders } from './middleware.js';

// Google JWKS cache
let googleKeysCache = null;
let googleKeysCacheExpiry = 0;

export async function handleAuth(request, env, action) {
  if (action === 'google') {
    return handleGoogleAuth(request, env);
  }
  if (action === 'refresh') {
    return handleRefresh(request, env);
  }
  return jsonResponse({ error: 'Unknown auth action' }, 400, env);
}

async function handleGoogleAuth(request, env) {
  const { idToken } = await request.json();
  if (!idToken) {
    return jsonResponse({ error: 'Missing idToken' }, 400, env);
  }

  // Verify Google ID token
  const payload = await verifyGoogleIdToken(idToken, env);
  if (!payload) {
    return jsonResponse({ error: 'Invalid Google ID token' }, 401, env);
  }

  const { sub, email, name, picture } = payload;

  // Upsert user
  await env.DB.prepare(`
    INSERT INTO users (id, email, name, picture)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      picture = excluded.picture,
      revoked_at = NULL
  `).bind(sub, email, name || '', picture || '').run();

  // Sign JWT
  const jwt = await signJWT({ sub, email }, env);

  return jsonResponse({
    token: jwt,
    user: { id: sub, email, name, picture },
  }, 200, env);
}

async function handleRefresh(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing token' }, 401, env);
  }

  const token = authHeader.slice(7);
  const payload = await decodeJWT(token, env, { allowExpired: true });

  if (!payload) {
    return jsonResponse({ error: 'Invalid token' }, 401, env);
  }

  // Check grace period: allow refresh within JWT_REFRESH_GRACE_DAYS after expiry
  const graceDays = parseInt(env.JWT_REFRESH_GRACE_DAYS || '7');
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  const now = Date.now() / 1000;

  if (payload.exp && (now - payload.exp) > graceMs / 1000) {
    return jsonResponse({ error: 'Token expired beyond grace period, re-login required' }, 401, env);
  }

  // Check user still exists and not revoked
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND revoked_at IS NULL')
    .bind(payload.sub).first();

  if (!user) {
    return jsonResponse({ error: 'User not found or revoked' }, 401, env);
  }

  // Issue new JWT
  const jwt = await signJWT({ sub: payload.sub, email: payload.email }, env);

  return jsonResponse({
    token: jwt,
    user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
  }, 200, env);
}

// --- Google ID Token Verification ---

async function getGooglePublicKeys() {
  const now = Date.now();
  if (googleKeysCache && now < googleKeysCacheExpiry) {
    return googleKeysCache;
  }

  const resp = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await resp.json();

  // Cache for 6 hours
  googleKeysCache = data.keys;
  googleKeysCacheExpiry = now + 6 * 60 * 60 * 1000;

  return data.keys;
}

async function verifyGoogleIdToken(idToken, env) {
  try {
    // Decode header to get kid
    const [headerB64] = idToken.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));

    const keys = await getGooglePublicKeys();
    const key = keys.find(k => k.kid === header.kid);
    if (!key) return null;

    // Import the RSA public key
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Verify signature
    const [, payloadB64, signatureB64] = idToken.split('.');
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      signedData
    );

    if (!valid) return null;

    // Decode and validate payload
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    // Check issuer
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      return null;
    }

    // Check audience (Google Client ID)
    if (payload.aud !== env.GOOGLE_CLIENT_ID) {
      return null;
    }

    // Check expiry
    if (payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch (e) {
    console.error('Google ID token verification failed:', e);
    return null;
  }
}

// --- JWT Signing/Verification (HMAC-SHA256) ---

export async function signJWT(payload, env) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const expiryDays = parseInt(env.JWT_EXPIRY_DAYS || '7');
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiryDays * 24 * 60 * 60,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getHMACKey(env);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput)
  );

  const signatureB64 = base64urlEncodeBuffer(signature);
  return `${signingInput}.${signatureB64}`;
}

export async function decodeJWT(token, env, options = {}) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const key = await getHMACKey(env);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64urlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(signingInput)
    );

    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    // Check expiry (unless allowExpired)
    if (!options.allowExpired && payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch (e) {
    return null;
  }
}

async function getHMACKey(env) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// --- Base64url helpers ---

function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    },
  });
}
