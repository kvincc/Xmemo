import { decodeJWT } from './auth.js';

// In-memory rate limit store (best-effort, resets on Worker restart)
const rateLimitMap = new Map();

export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export function handleCORS(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env),
  });
}

export async function verifyJWT(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Missing or invalid Authorization header', status: 401 };
  }

  const token = authHeader.slice(7);
  const payload = await decodeJWT(token, env);

  if (!payload) {
    return { error: 'Invalid or expired token', status: 401 };
  }

  // Check user not revoked
  const user = await env.DB.prepare('SELECT revoked_at FROM users WHERE id = ?')
    .bind(payload.sub).first();

  if (!user) {
    return { error: 'User not found', status: 401 };
  }

  if (user.revoked_at) {
    return { error: 'User access revoked', status: 403 };
  }

  return { userId: payload.sub };
}

/**
 * Simple in-memory rate limiter (best-effort, not shared across isolates).
 * Returns a Response if rate limited, null otherwise.
 */
export function rateLimit(env, request, key, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  let entry = rateLimitMap.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(key, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    return new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil((entry.windowStart + windowMs - now) / 1000)),
        ...corsHeaders(env),
      },
    });
  }

  // Clean up old entries periodically
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > windowMs * 2) {
        rateLimitMap.delete(k);
      }
    }
  }

  return null;
}
