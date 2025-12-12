// server.js (clean, deploy-safe)

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { simpleParser } from "mailparser";
import { Redis as UpstashRedis } from "@upstash/redis";

/* -------------------- Upstash Redis (REST) -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

const rGet = async (k) => await redis.get(k);
const rSetEX = async (k, v, ex) => await redis.set(k, v, { ex });
const rLPush = async (k, v) => await redis.lpush(k, v);
const rLTrim = async (k, s, e) => await redis.ltrim(k, s, e);
const rLRange = async (k, s, e) => await redis.lrange(k, s, e);
const rExpire = async (k, sec) => await redis.expire(k, sec);
const rDel = async (k) => await redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* -------------------- Middleware -------------------- */
app.use(helmet());

app.use(
  cors({
    origin: (origin, cb) => {
      const allow = (process.env.FRONTEND_ORIGIN || "*")
        .split(",")
        .map((s) => s.trim());
      if (!origin || allow.includes("*") || allow.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked for origin: " + origin));
    },
  })
);

// JSON + urlencoded (για mailgun/incoming)
app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      req.path === "/" || req.path === "/healthz" || req.path.startsWith("/_debug"),
  })
);

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL = Number(process.env.MSG_TTL || 600);
const DOMAIN = process.env.DOMAIN || "temp-mail.gr";
const API_KEY = process.env.API_KEY || "";

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

async function storeMessage({ id, to, from, subject, text, html, raw, headers, received_at }) {
  const msgId = id || Math.random().toString(36).slice(2);
  const toLc = (to || "").toLowerCase();
  const local = toLc.split("@")[0];

  const msg = {
    id: msgId,
    to: toLc,
    from: from || "",
    subject: subject || "",
    text: text || "",
    html: html || "",
    raw: raw || "",
    headers: headers || {},
    received_at: received_at || nowISO(),
  };

  await rSetEX(messageKey(msgId), JSON.stringify(msg), MSG_TTL);

  const mbox = mailboxKeyFromLocal(local);
  await rLPush(mbox, msgId);
  await rLTrim(mbox, 0, 199);
  await rExpire(mbox, INBOX_TTL);

  return { msgId, local };
}

/* -------------------- Health / Debug -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

app.get("/_debug/ping", (_req, res) =>
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: process.env.DOMAIN || null,
    allowedList: (process.env.FRONTEND_ORIGIN || "*").split(",").map((s) => s.trim()),
  })
);

app.get("/_debug/redis", (_req, res) => res.json({ ok: true, hasUrl: !!redisUrl, hasToken: !!redisToken }));

app.get("/_debug/apikey", (_req, res) => {
  const k = process.env.API_KEY || "";
  res.json({ hasKey: !!k, len: k.length, head: k.slice(0, 4), tail: k.slice(-4) });
});

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

/* -------------------- Core API -------------------- */
app.post("/create", async (_req, res) => {
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
});

app.get("/inbox/:local", async (req, res) => {
  try {
    const local = req.params.local;
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const ids = await rLRange(mailboxKeyFromLocal(local), 0, 49);
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
        preview: (m.text || m.raw || "").slice(0, 160),
        received_at: m.received_at || m.date || nowISO(),
      });
    }

    return res.json({ ok: true, messages });
  } catch (e) {
    console.error("[inbox] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "inbox_failed" });
  }
});

app.get("/message/:id", async (req, res) => {
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
      to: m.to || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      raw: m.raw || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {},
    });
  } catch (e) {
    console.error("[message] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
});

// aliases
app.post("/api/create", (req, res) => app._router.handle(req, res, () => {}));
app.get("/api/inbox/:local", (req, res) => app._router.handle(req, res, () => {}));
app.get("/api/message/:id", (req, res) => app._router.handle(req, res, () => {}));

/* -------------------- Incoming from Worker (JSON) -------------------- */
app.post("/incoming-email", async (req, res) => {
  try {
    if (API_KEY) {
      const sent = req.headers["x-api-key"];
      if (!sent || sent !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { id, to, from, subject, text, html, received_at, headers } = req.body || {};
    if (!to || !from) return res.status(400).json({ ok: false, error: "missing_to_or_from" });

    await storeMessage({ id, to, from, subject, text, html, headers, received_at });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[incoming-email] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "incoming_failed" });
  }
});

/* -------------------- Incoming RAW email (HTTP body) -------------------- */
app.post("/cloudflare/inbound", express.raw({ type: () => true, limit: "25mb" }), async (req, res) => {
  try {
    const mail = await simpleParser(req.body);

    const to = (mail.to?.value?.[0]?.address || "").toLowerCase();
    if (!to.includes("@")) return res.status(400).json({ ok: false, error: "missing_to" });

    await storeMessage({
      to,
      from: mail.from?.text || "",
      subject: mail.subject || "",
      text: mail.text || "",
      html: mail.html || "",
      raw: req.body.toString("utf8"),
      headers: Object.fromEntries(mail.headerLines?.map((h) => [h.key, h.line]) || []),
      received_at: nowISO(),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[cloudflare/inbound] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "inbound_failed" });
  }
});

/* -------------------- PUSH (multipart/form-data) -------------------- */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/push", upload.single("raw"), async (req, res) => {
  try {
    // accept api_key either as field OR header (για να μη παιδεύεσαι)
    const keyFromBody = req.body?.api_key || "";
    const keyFromHeader = req.headers["x-api-key"] || "";
    const sentKey = keyFromBody || keyFromHeader;

    if (API_KEY && sentKey !== API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const to = (req.body.to || "").toLowerCase();
    if (!to.includes("@")) return res.status(400).json({ ok: false, error: "invalid_to" });

    const rawBuf = req.file?.buffer || null;
    const raw = rawBuf ? rawBuf.toString("utf8") : (req.body.raw || "");

    await storeMessage({
      to,
      from: req.body.from || "",
      subject: req.body.subject || "",
      raw,
      received_at: nowISO(),
      headers: {},
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[push] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "push_failed" });
  }
});

app.post("/_debug/pushcheck", upload.single("raw"), (req, res) => {
  res.json({
    ok: true,
    body_api_key: req.body?.api_key || null,
    header_x_api_key: req.headers["x-api-key"] || null,
    content_type: req.headers["content-type"] || null,
    has_file: !!req.file,
    file_size: req.file?.size || 0,
    body_keys: Object.keys(req.body || {}),
  });
});

/* -------------------- Mailgun inbound (x-www-form-urlencoded) -------------------- */
app.post("/mailgun/inbound", async (req, res) => {
  try {
    const data = req.body || {};

    const to = (data.recipient || "").toLowerCase();
    if (!to.includes("@")) return res.status(400).json({ ok: false, error: "missing_recipient" });

    await storeMessage({
      to,
      from: data.sender || "",
      subject: data.subject || "",
      text: data["body-plain"] || "",
      html: data["body-html"] || "",
      received_at: nowISO(),
      headers: {},
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[mailgun] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "mailgun_failed" });
  }
});

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
