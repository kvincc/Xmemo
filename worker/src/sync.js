import { corsHeaders } from './middleware.js';

export async function handleSync(request, env, userId, action) {
  if (action === 'pull') {
    return handlePull(request, env, userId);
  }
  if (action === 'push') {
    return handlePush(request, env, userId);
  }
  return jsonResponse({ error: 'Unknown sync action' }, 400, env);
}

async function handlePull(request, env, userId) {
  const url = new URL(request.url);
  const clientVersion = parseInt(url.searchParams.get('version') || '0');

  const row = await env.DB.prepare(
    'SELECT data, version, data_hash, updated_at FROM user_data WHERE user_id = ?'
  ).bind(userId).first();

  if (!row) {
    // No data on server yet
    return jsonResponse({ version: 0, data: null }, 200, env);
  }

  // If client is up to date, return 304
  if (clientVersion === row.version) {
    return new Response(null, {
      status: 304,
      headers: corsHeaders(env),
    });
  }

  // Decompress gzip data
  const dataBlob = row.data;
  let jsonData;

  if (dataBlob instanceof ArrayBuffer || dataBlob instanceof Uint8Array) {
    const ds = new DecompressionStream('gzip');
    const blob = new Blob([dataBlob]);
    const decompressedStream = blob.stream().pipeThrough(ds);
    const decompressedBlob = await new Response(decompressedStream).text();
    jsonData = JSON.parse(decompressedBlob);
  } else if (typeof dataBlob === 'string') {
    // Might be stored as plain string in some edge cases
    jsonData = JSON.parse(dataBlob);
  } else {
    // D1 may return ArrayBuffer-like
    const bytes = new Uint8Array(dataBlob);
    const ds = new DecompressionStream('gzip');
    const blob = new Blob([bytes]);
    const decompressedStream = blob.stream().pipeThrough(ds);
    const decompressedBlob = await new Response(decompressedStream).text();
    jsonData = JSON.parse(decompressedBlob);
  }

  // Update last_sync_at
  await env.DB.prepare(
    'UPDATE users SET last_sync_at = datetime(\'now\') WHERE id = ?'
  ).bind(userId).run();

  return jsonResponse({
    version: row.version,
    data: jsonData,
    dataHash: row.data_hash,
    updatedAt: row.updated_at,
  }, 200, env);
}

async function handlePush(request, env, userId) {
  const body = await request.json();
  const { data, expectedVersion } = body;

  if (!data) {
    return jsonResponse({ error: 'Missing data' }, 400, env);
  }

  // Compress data with gzip
  const jsonStr = JSON.stringify(data);
  const cs = new CompressionStream('gzip');
  const blob = new Blob([jsonStr]);
  const compressedStream = blob.stream().pipeThrough(cs);
  const compressedBlob = await new Response(compressedStream).blob();
  const compressedBuffer = await compressedBlob.arrayBuffer();

  // Compute hash for integrity check
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonStr));
  const hashArray = new Uint8Array(hashBuffer);
  const dataHash = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

  // Check size limit (500KB compressed per user)
  if (compressedBuffer.byteLength > 500 * 1024) {
    return jsonResponse({ error: 'Data too large' }, 413, env);
  }

  // Get current server version
  const current = await env.DB.prepare(
    'SELECT version, data, data_hash FROM user_data WHERE user_id = ?'
  ).bind(userId).first();

  const serverVersion = current ? current.version : 0;

  // Optimistic lock check
  if (expectedVersion !== undefined && expectedVersion !== serverVersion) {
    // Conflict: return server data for client-side merge
    let serverData = null;
    if (current && current.data) {
      try {
        const dataBlob = current.data;
        const ds = new DecompressionStream('gzip');
        const sBlob = new Blob([dataBlob instanceof Uint8Array ? dataBlob : new Uint8Array(dataBlob)]);
        const decompressedStream = sBlob.stream().pipeThrough(ds);
        serverData = JSON.parse(await new Response(decompressedStream).text());
      } catch (e) {
        console.error('Failed to decompress server data for conflict response:', e);
      }
    }

    return jsonResponse({
      error: 'Version conflict',
      serverVersion,
      serverData,
      serverDataHash: current?.data_hash,
    }, 409, env);
  }

  const newVersion = serverVersion + 1;
  const now = new Date().toISOString();

  if (current) {
    // Update existing
    await env.DB.prepare(`
      UPDATE user_data
      SET data = ?, version = ?, data_hash = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(compressedBuffer, newVersion, dataHash, now, userId).run();
  } else {
    // Insert new
    await env.DB.prepare(`
      INSERT INTO user_data (user_id, data, version, data_hash, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, compressedBuffer, newVersion, dataHash, now).run();
  }

  // Update last_sync_at
  await env.DB.prepare(
    "UPDATE users SET last_sync_at = datetime('now') WHERE id = ?"
  ).bind(userId).run();

  return jsonResponse({
    version: newVersion,
    dataHash,
    updatedAt: now,
  }, 200, env);
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
