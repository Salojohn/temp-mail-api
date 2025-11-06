// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Redis as UpstashRedis } from "@upstash/redis";

/* -------------------- Upstash Redis (REST) -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

// Tiny helpers (wrap Upstash SDK)
const rGet    = (k)          => redis.get(k);
const rSetEX  = (k, v, ex)   => redis.set(k, v, { ex });
const rLPush  = (k, v)       => redis.lpush(k, v);
const rLTrim  = (k, s, e)    => redis.ltrim(k, s, e);
const rLRange = (k, s, e)    => redis.lrange(k, s, e);
const rExpire = (k, sec)     => redis.expire(k, sec);
const rDel    = (k)          => redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);            // για Render/Proxy & σωστό rate-limit
app.disable("x-powered-by");

/* --- Health/Debug ΠΡΙΝ το rate-limit --- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/_debug/ping", (_req, res) =>
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: process.env.DOMAIN || null,
    allowedList: (process.env.FRONTEND_ORIGIN || "*").split(",").map(s => s.trim()),
    hasUpstash: !!redisUrl && !!redisToken
  })
);
app.get("/_debug/selftest", async (_req, res) => {
  try {
    const key = `selftest:${Date.now()}`;
    await rSetEX(key, JSON.stringify({ ok: true }), 30);
    const got = await rGet(key);

    const lkey = `selflist:${Date.now()}`;
    await rLPush(lkey, "a");
    await rLPush(lkey, "b");
    await rExpire(lkey, 30);
    const lr = await rLRange(lkey, 0, 9);

    res.json({ ok: true, setexValue: got, list: lr });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allow = (process.env.FRONTEND_ORIGIN || "*").split(",").map(s => s.trim());
    if (!origin || allow.includes("*") || allow.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  }
}));
app.use(bodyParser.json({ limit: "1mb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/" ||
    req.path === "/healthz" ||
    req.path.startsWith("/_debug")
}));

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL   = Number(process.env.MSG_TTL   || 600);
const DOMAIN    = process.env.DOMAIN || "temp-mail.gr";

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

/* -------------------- Core API -------------------- */

// POST /create -> { ok, email, local, expires_in }
async function handleCreate(_req, res) {
  const local = Math.random().toString(36).slice(2, 10);
  const email = `${local}@${DOMAIN}`;
  const key = mailboxKeyFromLocal(local);

  try {
    // Δημιούργησε "κενή" λίστα με TTL που δεν πέφτει
    await rDel(key);
    await rLPush(key, "__init__");
    await rLTrim(key, 1, -1);
    await rExpire(key, INBOX_TTL);

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("[create] error:", e);
    res.status(500).json({ ok: false, error: e.message || "create_failed" });
  }
}

// GET /inbox/:local -> { ok, messages: [...] }
async function handleInbox(req, res) {
  try {
    const local = req.params.local;
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const key = mailboxKeyFromLocal(local);
    const ids = await rLRange(key, 0, 49);
    const messages = [];

    for (const id of ids) {
      if (id === "__init__") continue;
      const raw = await rGet(messageKey(id));
      if (!raw) continue;
      const m = typeof raw === "string" ? JSON.parse(raw) : raw;

      messages.push({
        id: m.id,
        from: m.from || "",
        subject: m.subject || "",
        preview: (m.text || "").slice(0, 200),
        received_at: m.received_at || m.date || nowISO(),
        has_html: !!m.html
      });
    }

    res.json({ ok: true, messages });
  } catch (e) {
    console.error("inbox error:", e);
    res.status(500).json({ ok: false, error: e.message || "inbox_failed" });
  }
}

// GET /message/:id -> full body
async function handleMessage(req, res) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await rGet(messageKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof raw === "string" ? JSON.parse(raw) : raw;
    res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",   // Αν υπάρχει το δείχνουμε σε iframe (sandboxed)
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {}
    });
  } catch (e) {
    console.error("message error:", e);
    res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
}

/* -------------------- Ingest endpoint από Worker/MTA -------------------- */
// POST /push  (με x-api-key)
// Body JSON: { to, from, subject, text, html, headers }
app.post("/push", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!process.env.INGEST_API_KEY || apiKey !== process.env.INGEST_API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { to, from = "", subject = "", text = "", html = "", headers = {} } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "missing_to" });

    const id = Math.random().toString(36).slice(2, 12);
    const msg = {
      id,
      to: String(to).toLowerCase(),
      from,
      subject,
      text: String(text || ""),
      html: String(html || ""),
      received_at: nowISO(),
      headers: headers && typeof headers === "object" ? headers : {}
    };

    // βάλε στο Redis
    const local = msg.to.split("@")[0];
    await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
    const box = mailboxKeyFromLocal(local);
    await rLPush(box, id);
    await rLTrim(box, 0, 199);
    await rExpire(box, INBOX_TTL);

    res.json({ ok: true, stored: true, id, to: msg.to });
  } catch (e) {
    console.error("[push] error:", e);
    res.status(500).json({ ok: false, error: e.message || "push_failed" });
  }
});

/* -------------------- DEV helpers (προαιρετικό) -------------------- */
if (process.env.DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const toAddress = String(req.query.to || "").toLowerCase();
      const subject   = String(req.query.subject || "(no subject)");
      const text      = String(req.query.text || "");
      const html      = `<p>${text}</p>`;

      if (!/^[^@]+@[^@]+\.[^@]+$/.test(toAddress)) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const id = Math.random().toString(36).slice(2);
      const msg = {
        id,
        from: "tester@example.com",
        to: toAddress,
        subject,
        text,
        html,
        received_at: nowISO(),
      };
      const local = toAddress.split("@")[0];

      await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
      const mbox = mailboxKeyFromLocal(local);
      await rLPush(mbox, id);
      await rLTrim(mbox, 0, 199);
      await rExpire(mbox, INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to: toAddress });
    } catch (e) {
      console.error("[_test/push] error:", e);
      res.status(500).json({ ok: false, error: e.message || "push_failed" });
    }
  });
}

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
