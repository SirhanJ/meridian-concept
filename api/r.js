/**
 * Proof-link click redirect.
 *
 * Emails use a plain-text URL like:
 *   https://kestrel-concept.vercel.app/r/a8kx2m9q
 *
 * This handler logs the token (no pixel, no HTML in the email) and 302s to /.
 *
 * Storage (first match wins):
 *   1. Upstash Redis / Vercel KV — KV_REST_API_URL + KV_REST_API_TOKEN
 *   2. Vercel Blob — BLOB_READ_WRITE_TOKEN
 *   3. In-memory ring buffer (best-effort across warm isolates only)
 */

const TOKEN_RE = /^[a-z0-9]{8}$/;
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

async function logClick(event) {
  // Always keep a warm-isolate buffer so /api/clicks works before KV is wired.
  const mem = memoryStore();
  mem.unshift(event);
  if (mem.length > 500) mem.length = 500;

  const redis = redisCreds();
  if (redis) {
    const body = JSON.stringify(event);
    const res = await fetch(
      `${redis.url}/lpush/proof_clicks/${encodeURIComponent(body)}`,
      { headers: { Authorization: `Bearer ${redis.token}` } }
    );
    if (!res.ok) {
      console.error("redis log failed", res.status, await res.text());
    }
    await fetch(`${redis.url}/ltrim/proof_clicks/0/4999`, {
      headers: { Authorization: `Bearer ${redis.token}` },
    });
    return "redis";
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    const pathname = `proof-clicks/${event.token}/${event.ts}.json`;
    const res = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${blobToken}`,
        "Content-Type": "application/json",
        "x-vercel-blob-access": "private",
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      console.error("blob log failed", res.status, await res.text());
      return "blob-error";
    }
    return "blob";
  }

  console.log("proof_click", JSON.stringify(event));
  return "memory";
}

function hashIp(ip) {
  if (!ip) return null;
  let h = 0;
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

module.exports = async function handler(req, res) {
  const token = String(req.query.token || "")
    .trim()
    .toLowerCase();

  if (!TOKEN_RE.test(token)) {
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const fwd = req.headers["x-forwarded-for"];
  const ip = Array.isArray(fwd) ? fwd[0] : String(fwd || "").split(",")[0].trim();

  const event = {
    token,
    ts: Date.now(),
    ua: String(req.headers["user-agent"] || "").slice(0, 300),
    referer: String(req.headers["referer"] || req.headers["referrer"] || "").slice(0, 300),
    ip_hash: hashIp(ip),
  };

  try {
    await logClick(event);
  } catch (err) {
    console.error("proof_click_error", err);
  }

  res.writeHead(302, {
    Location: "/",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end();
};
