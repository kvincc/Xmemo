import { handleAuth } from './auth.js';
import { handleSync } from './sync.js';
import { corsHeaders, handleCORS, verifyJWT, rateLimit } from './middleware.js';

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Auth routes (no JWT required)
      if (path === '/api/auth/google' && request.method === 'POST') {
        const rlResult = rateLimit(env, request, 'auth', 10, 60);
        if (rlResult) return rlResult;
        return await handleAuth(request, env, 'google');
      }

      if (path === '/api/auth/refresh' && request.method === 'POST') {
        const rlResult = rateLimit(env, request, 'auth', 10, 60);
        if (rlResult) return rlResult;
        return await handleAuth(request, env, 'refresh');
      }

      // Protected routes - require JWT
      const authResult = await verifyJWT(request, env);
      if (authResult.error) {
        return jsonResponse({ error: authResult.error }, authResult.status, env);
      }
      const userId = authResult.userId;

      // Sync routes
      if (path === '/api/sync' && request.method === 'GET') {
        const rlResult = rateLimit(env, request, `sync:${userId}`, 30, 60);
        if (rlResult) return rlResult;
        return await handleSync(request, env, userId, 'pull');
      }

      if (path === '/api/sync' && request.method === 'PUT') {
        const rlResult = rateLimit(env, request, `sync:${userId}`, 30, 60);
        if (rlResult) return rlResult;
        return await handleSync(request, env, userId, 'push');
      }

      // User management
      if (path === '/api/user' && request.method === 'DELETE') {
        const rlResult = rateLimit(env, request, `delete:${userId}`, 3, 3600);
        if (rlResult) return rlResult;
        return await handleDeleteUser(env, userId);
      }

      return jsonResponse({ error: 'Not found' }, 404, env);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500, env);
    }
  }
};

async function handleDeleteUser(env, userId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_data WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
  return jsonResponse({ ok: true }, 200, env);
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
