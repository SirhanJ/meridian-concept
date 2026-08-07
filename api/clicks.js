/**
 * Authenticated click export for `valkyra clicks --sync`.
 *
 * GET /api/clicks?secret=TRACK_SECRET
 */

const MEM_KEY = "__valkyra_proof_clicks";

function memoryStore() {
  const g = globalThis;
  if (!g[MEM_KEY]) g[MEM_KEY] = [];
  return g[MEM_KEY];
}

function redisCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function loadFromRedis() {
  const redis = redisCreds();
  if (!redis) return null;
  const res = await fetch(`${redis.url}/lrange/proof_clicks/0/4999`, {
    headers: { Authorization: `Bearer ${redis.token}` },
  });
  if (!res.ok) {
    throw new Error(`redis ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : [];
  const clicks = [];
  for (const row of rows) {
    try {
      clicks.push(typeof row === "string" ? JSON.parse(row) : row);
    } catch {
      /* skip bad row */
    }
  }
  return clicks;
}

async function loadFromBlob() {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return null;
  const res = await fetch("https://blob.vercel-storage.com?prefix=proof-clicks/", {
    headers: { Authorization: `Bearer ${blobToken}` },
  });
  if (!res.ok) {
    throw new Error(`blob list ${res.status}: ${await res.text()}`);
  }
  const listed = await res.json();
  const blobs = listed.blobs || listed || [];
  const clicks = [];
  for (const b of blobs.slice(0, 2000)) {
    const url = b.url || b.downloadUrl;
    if (!url) continue;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${blobToken}` },
      });
      if (r.ok) clicks.push(await r.json());
    } catch {
      /* skip */
    }
  }
  return clicks;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const expected = process.env.TRACK_SECRET || "";
  const got = String(req.query.secret || "");
  if (!expected || got !== expected) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  try {
    let clicks = await loadFromRedis();
    if (clicks == null) clicks = await loadFromBlob();
    if (clicks == null) clicks = memoryStore().slice();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ clicks, count: clicks.length }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
};
