// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Redis as UpstashRedis } from "@upstash/redis";
import multer from "multer";
import { simpleParser } from "mailparser";

/* -------------------- Upstash Redis (REST) -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

const rGet    = async (k) => await redis.get(k);
const rSetEX  = async (k, v, ex) => await redis.set(k, v, { ex });
const rLPush  = async (k, v) => await redis.lpush(k, v);
const rLTrim  = async (k, s, e) => await redis.ltrim(k, s, e);
const rLRange = async (k, s, e) => await redis.lrange(k, s, e);
const rExpire = async (k, sec) => await redis.expire(k, sec);
const rDel    = async (k) => await redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL   = Number(process.env.MSG_TTL   || 600);
const DOMAIN    = process.env.DOMAIN || "temp-mail.gr";
const API_KEY   = process.env.API_KEY || "";

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

function requireApiKey(req, res) {
  if (!API_KEY) return true; // αν δεν έχεις βάλει API_KEY, το αφήνει open (δεν το προτείνω)
  const sent = req.headers["x-api-key"];
  if (!sent || sent !== API_KEY) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

/* -------------------- Raw inbound route FIRST (πριν json/urlencoded) -------------------- */
/**
 * Cloudflare Email Worker → POST raw MIME στο /cloudflare/inbound
 * Content-Type: message/rfc822 (ή οτιδήποτε, το πιάνουμε με */*)
 * Header: x-api-key: <API_KEY>
 */
app.post(
  "/cloudflare/inbound",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    try {
      if (!requireApiKey(req, res)) return;

      const rawBuf = req.body; // Buffer
      const mail = await simpleParser(rawBuf);

      const to = (mail.to?.value?.[0]?.address || "").toLowerCase();
      if (!to.includes("@")) return res.status(400).json({ ok: false, error: "missing_to" });

      const local = to.split("@")[0];
      const id = Math.random().toString(36).slice(2);

      const msg = {
        id,
        from: mail.from?.text || "",
        to,
        subject: mail.subject || "",
        text: mail.text || "",
        html: mail.html || "",
        raw: rawBuf.toString("utf8"),
        received_at: nowISO(),
        headers: Object.fromEntries(mail.headerLines?.map(h => [h.key, h.line]) || []),
      };

      await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
      const mbox = mailboxKeyFromLocal(local);
      await rLPush(mbox, id);
      await rLTrim(mbox, 0, 199);
      await rExpire(mbox, INBOX_TTL);

      return res.json({ ok: true, stored: true, id, to });
    } catch (e) {
      console.error("[cloudflare inbound] error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* -------------------- Security / middleware -------------------- */
app.use(helmet());

app.use(cors({
  origin: (origin, cb) => {
    const allow = (process.env.FRONTEND_ORIGIN || "*")
      .split(",").map(s => s.trim());
    if (!origin || allow.includes("*") || allow.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  }
}));

app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/" || req.path === "/healthz" || req.path.startsWith("/_debug")
}));

/* -------------------- Health / Debug -------------------- */
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
        preview: (m.text || m.raw || "").slice(0, 160),
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
      to: m.to || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      raw: m.raw || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {},
    });
  } catch (e) {
    console.error("message error:", e);
    return res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
}

/* Routes + /api aliases */
app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);

app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);

/* -------------------- PUSH endpoint (multipart/form-data) -------------------- */
const upload = multer();

/**
 * POST /push
 * multipart/form-data:
 *  - raw: (file) mail.eml
 *  - to, from, subject
 * Header: x-api-key: <API_KEY>
 */
app.post("/push", upload.single("raw"), async (req, res) => {
  try {
    if (!requireApiKey(req, res)) return;

    const to = (req.body.to || "").toLowerCase();
    if (!to.includes("@")) return res.status(400).json({ ok: false, error: "invalid_to" });

    const local = to.split("@")[0];
    const id = Date.now().toString(36);

    const rawStr = req.file?.buffer?.toString("utf8") || "";
    // Προαιρετικό parsing για να έχεις html/text έτοιμα
    let parsed = null;
    try {
      if (rawStr) parsed = await simpleParser(Buffer.from(rawStr, "utf8"));
    } catch { /* ignore parse errors */ }

    const msg = {
      id,
      to,
      from: req.body.from || "",
      subject: req.body.subject || "",
      text: parsed?.text || "",
      html: parsed?.html || "",
      raw: rawStr,
      received_at: nowISO(),
      headers: parsed
        ? Object.fromEntries(parsed.headerLines?.map(h => [h.key, h.line]) || [])
        : {},
    };

    await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
    const mbox = mailboxKeyFromLocal(local);
    await rLPush(mbox, id);
    await rLTrim(mbox, 0, 199);
    await rExpire(mbox, INBOX_TTL);

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("PUSH ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
