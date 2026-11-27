// Superharness APNs Push Relay (Cloudflare Worker)
// Holds the APNs AuthKey (.p8) as a Worker secret so desktop hosts can push task-completion,
// input-needed, and silent background-sync notifications to the iOS companion app without
// shipping the .p8 key on every host.

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
const CLOCK_SKEW = 90; // seconds
const KEEP_TTL = 45 * 86400; // 45 days

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (status, error) => json({ ok: false, error }, status);

const enc = new TextEncoder();
const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0)
  );
};
const sha256 = (data) =>
  crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data);

async function hmacHex(keyBytes, text) {
  const k = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verify(req, url, body, keyBytes) {
  const t = req.headers.get("x-sh-time");
  const nonce = req.headers.get("x-sh-nonce");
  const sig = req.headers.get("x-sh-sig");
  if (!t || !nonce || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > CLOCK_SKEW) return false;
  const msg = `${req.method}\n${url.pathname}${url.search}\n${t}\n${nonce}\n${hex(await sha256(body))}`;
  return sameText(await hmacHex(keyBytes, msg), sig.toLowerCase());
}

let jwtCache = { token: null, iat: 0 };

async function apnsJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache.token && now - jwtCache.iat < 2700) return jwtCache.token;
  const shared = await env.DEVICES.get("_jwt", "json");
  if (shared && now - shared.iat < 2400) return (jwtCache = shared).token;
  const pem = env.APNS_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    unb64url(pem.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const head = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(`${head}.${claims}`)
  );
  jwtCache = { token: `${head}.${claims}.${b64url(sig)}`, iat: now };
  await env.DEVICES.put("_jwt", JSON.stringify(jwtCache), { expirationTtl: 3600 });
  return jwtCache.token;
}

async function apnsSend(env, apnsEnv, token, payload, topic, pushType, priority) {
  try {
    const r = await fetch(`${HOSTS[apnsEnv] || HOSTS.production}/3/device/${token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await apnsJwt(env)}`,
        "apns-topic": topic,
        "apns-push-type": pushType,
        "apns-priority": String(priority),
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let reason = "";
    try {
      reason = text ? JSON.parse(text).reason || "" : "";
    } catch {
      reason = text.slice(0, 120);
    }
    return [r.status, reason];
  } catch (e) {
    return [0, `${e.name}: ${e.message}`];
  }
}

function buildApnsPayload(body) {
  const kind = String(body.kind || "task_completed");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 128) : "";
  const harness = typeof body.harness === "string" ? body.harness.slice(0, 32) : "";

  if (kind === "background_sync") {
    return {
      pushType: "background",
      priority: 5,
      payload: {
        aps: { "content-available": 1 },
        sh_kind: kind,
        sessionId,
      },
    };
  }

  const title = String(body.title || "Superharness").slice(0, 120);
  const alertBody = String(body.body || "Update from Superharness").slice(0, 240);
  const interruption = kind === "input_needed" ? "time-sensitive" : "active";
  const aps = {
    alert: { title, body: alertBody },
    sound: "default",
    "thread-id": sessionId || "super-harness",
    "interruption-level": interruption,
    "mutable-content": 1,
  };
  if (typeof body.badge === "number" && Number.isFinite(body.badge) && body.badge >= 0) {
    aps.badge = Math.floor(body.badge);
  }

  return {
    pushType: "alert",
    priority: 10,
    payload: {
      aps,
      sh_kind: kind,
      sessionId,
      harness,
    },
  };
}

export default {
  async fetch(req, env) {
    if (env.PAUSED) return fail(503, "relay paused");
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, bundleId: env.BUNDLE_ID });
    }

    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > 8192) return fail(413, "body too large");

    const devMatch = url.pathname.match(/^\/v1\/devices\/([0-9a-f]{32})$/);
    if (devMatch && req.method === "PUT") {
      const rid = devMatch[1];
      let b;
      try {
        b = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return fail(400, "bad JSON");
      }
      let rec = await env.DEVICES.get(`d:${rid}`, "json");
      let keyBytes;
      if (!rec) {
        if (typeof b.key !== "string") return fail(404, "not registered");
        keyBytes = unb64url(b.key);
        if (keyBytes.length !== 32 || hex(await sha256(keyBytes)).slice(0, 32) !== rid) {
          return fail(400, "key mismatch");
        }
        rec = { key: b.key, tokens: {} };
      } else {
        keyBytes = unb64url(rec.key);
      }
      if (!(await verify(req, url, body, keyBytes))) return fail(401, "bad signature");
      const token = typeof b.device === "string" ? b.device.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{32,256}$/.test(token)) return fail(400, "invalid device token");
      const apnsEnv = b.env === "sandbox" ? "sandbox" : "production";
      rec.tokens = rec.tokens || {};
      rec.tokens[token] = { env: apnsEnv, updatedAt: Date.now() };
      // Keep at most 4 devices per pairing rid
      const entries = Object.entries(rec.tokens).sort((a, z) => z[1].updatedAt - a[1].updatedAt).slice(0, 4);
      rec.tokens = Object.fromEntries(entries);
      await env.DEVICES.put(`d:${rid}`, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
      return json({ ok: true, rid, count: entries.length });
    }

    const pushMatch = url.pathname.match(/^\/v1\/push\/([0-9a-f]{32})$/);
    if (pushMatch && req.method === "POST") {
      const rid = pushMatch[1];
      const rec = await env.DEVICES.get(`d:${rid}`, "json");
      if (!rec) return fail(404, "unknown device");
      if (!(await verify(req, url, body, unb64url(rec.key)))) return fail(401, "bad signature");
      let b;
      try {
        b = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return fail(400, "bad JSON");
      }

      const { pushType, priority, payload } = buildApnsPayload(b);
      const tokens = rec.tokens || {};
      const tokenEntries = Object.entries(tokens);
      if (tokenEntries.length === 0) return fail(410, "NoToken");

      let changed = false;
      let lastStatus = 200;
      let lastReason = "";
      for (const [tok, meta] of tokenEntries) {
        const primaryEnv = meta.env === "sandbox" ? "sandbox" : "production";
        let [status, reason] = await apnsSend(env, primaryEnv, tok, payload, env.BUNDLE_ID, pushType, priority);
        if (status === 400 && reason === "BadDeviceToken") {
          const otherEnv = primaryEnv === "sandbox" ? "production" : "sandbox";
          const [s2, r2] = await apnsSend(env, otherEnv, tok, payload, env.BUNDLE_ID, pushType, priority);
          status = s2;
          reason = r2;
          if (status === 200) {
            rec.tokens[tok] = { env: otherEnv, updatedAt: Date.now() };
            changed = true;
          }
        }
        if (status === 410 || (status === 400 && reason === "BadDeviceToken")) {
          delete rec.tokens[tok];
          changed = true;
        }
        lastStatus = status;
        lastReason = reason;
      }
      if (changed) {
        await env.DEVICES.put(`d:${rid}`, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
      }
      return json({ ok: lastStatus === 200, status: lastStatus, reason: lastReason }, lastStatus === 200 ? 200 : 502);
    }

    return fail(404, "not found");
  },
};
