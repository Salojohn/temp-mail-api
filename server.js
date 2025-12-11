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

const rGet    = async (k)      => await redis.get(k);
const rSetEX  = async (k, v, ex) => await redis.set(k, v, { ex });
const rLPush  = async (k, v)   => await redis.lpush(k, v);
const rLTrim  = async (k, s, e)=> await redis.ltrim(k, s, e);
const rLRange = async (k, s, e)=> await redis.lrange(k, s, e);
const rExpire = async (k, sec) => await redis.expire(k, sec);
const rDel    = async (k)      => await redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* --- Health/debug ΠΡΙΝ το rate-limit --- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/_debug/ping", (_req, res) =>
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: process.env.DOMAIN || null,
    allowedList: (process.env.FRONTEND_ORIGIN || "*").split(",").map(s => s.trim()),
  })
);
app.get("/_debug/redis", (_req, res) =>
  res.json({ ok: true, hasUrl: !!redisUrl, hasToken: !!redisToken })
);

/* --- Self-test για Upstash --- */
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
    console.error("[selftest] error:", e);
    res.status(500).json({ ok: false, error: e.message, stack: String(e.stack || "") });
  }
});

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allow = (process.env.FRONTEND_ORIGIN || "*")
      .split(",").map(s => s.trim());
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
const API_KEY   = process.env.API_KEY || "";

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
    await rDel(key);
    await rLPush(key, "__init__");
    await rLTrim(key, 1, -1);
    await rExpire(key, INBOX_TTL);

    return res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("[create] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "create_failed" });
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
        preview: (m.text || "").slice(0, 160),
        received_at: m.received_at || m.date || nowISO(),
      });
    }
    return res.json({ ok: true, messages });
  } catch (e) {
    console.error("inbox error:", e);
    return res.status(500).json({ ok: false, error: e.message || "inbox_failed" });
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
    return res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {}
    });
  } catch (e) {
    console.error("message error:", e);
    return res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
}

/* ---- Routes (και /api/* aliases) ---- */
app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);

app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);

/* -------------------- Εισερχόμενα από Cloudflare Worker -------------------- */
app.post("/incoming-email", async (req, res) => {
  try {
    if (API_KEY) {
      const sent = req.headers["x-api-key"];
      if (!sent || sent !== API_KEY) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const {
      id,
      to,
      from,
      subject = "",
      text = "",
      html = "",
      received_at,
      headers = {},
    } = req.body || {};

    if (!to || !from) {
      return res.status(400).json({ ok: false, error: "missing_to_or_from" });
    }

    const msgId = id || Math.random().toString(36).slice(2);
    const local = to.toLowerCase().split("@")[0];

    const msg = {
      id: msgId,
      from,
      to,
      subject,
      text,
      html,
      received_at: received_at || nowISO(),
      headers,
    };

    await rSetEX(messageKey(msgId), JSON.stringify(msg), MSG_TTL);
    const mbox = mailboxKeyFromLocal(local);
    await rLPush(mbox, msgId);
    await rLTrim(mbox, 0, 199);
    await rExpire(mbox, INBOX_TTL);

    console.log(`[incoming-email] stored for ${to}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[incoming-email] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "incoming_failed" });
  }
});

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});


/* -------------------- Mailgun inbound webhook -------------------- */

app.post(
  "/mailgun/inbound",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const data = req.body;

      const to = (data.recipient || "").toLowerCase();
      const from = data.sender || "";
      const subject = data.subject || "";
      const text = data["body-plain"] || "";
      const html = data["body-html"] || "";

      const local = to.split("@")[0];
      const id = Date.now().toString(36);

      const msg = {
        id,
        from,
        to,
        subject,
        text,
        html,
        received_at: new Date().toISOString(),
      };

      await rSetEX(`msg:${id}`, JSON.stringify(msg), MSG_TTL);
      await rLPush(`inbox:${local}`, id);
      await rLTrim(`inbox:${local}`, 0, 199);
      await rExpire(`inbox:${local}`, INBOX_TTL);

      return res.json({ ok: true });
    } catch (e) {
      console.error("Mailgun inbound error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);
