// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* =======================
   Env & constants
======================= */
const {
  PORT,
  REDIS_URL,
  DEV_MODE = "0",
  DOMAIN = "temp-mail.gr",
  INBOX_TTL = "600",
  MSG_TTL = "600",
} = process.env;

const WEB_PORT = PORT || 10000;
const INBOX_TTL_S = Number(INBOX_TTL);
const MSG_TTL_S = Number(MSG_TTL);

const ALLOWED_ORIGINS = [
  "https://temp-mail.gr",
  "https://www.temp-mail.gr",
  "https://api.temp-mail.gr",
  "https://temp-mail-api-2.onrender.com", // Render URL (για δοκιμές)
];

/* =======================
   Redis (singleton)
======================= */
const redisUrl = REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  reconnectOnError: (err) => {
    const msg = err?.message || "";
    // Retry σε transient σφάλματα δικτύου
    return /READONLY|ECONNRESET|EPIPE|NR_CLOSED/i.test(msg);
  },
  retryStrategy(times) {
    // Backoff
    return Math.min(200 + times * 200, 5000);
  },
});
redis.on("connect", () => console.log("[redis] connected"));
redis.on("reconnecting", (ms) => console.log("[redis] reconnecting in", ms, "ms"));
redis.on("error", (e) => console.log("[redis] transient issue:", e?.code || e?.message));

/* =======================
   Express
======================= */
const app = express();

// Render/Proxies ⇒ για σωστό client IP στο rate-limit
app.set("trust proxy", 1);

// Helmet (light)
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl / no-origin
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(bodyParser.json({ limit: "1mb" }));

// Rate-limit (λεπτάκι, 120 req/IP)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
  })
);

/* =======================
   Helpers
======================= */
const rnd = (len = 10) =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => "abcdefghijklmnopqrstuvwxyz0123456789".charAt(b % 36))
    .join("");

/** Μετατρέπει message object -> summary για inbox λίστα */
function toSummary(msg) {
  return {
    id: msg.id,
    from: msg.from || "",
    subject: msg.subject || "",
    preview: msg.text?.slice(0, 200) || "",
    received_at: msg.date || new Date().toISOString(),
  };
}

/* =======================
   API routes
======================= */
// Health
app.get(["/", "/healthz", "/_debug/ping"], (_req, res) =>
  res.json({ ok: true, t: Date.now(), dev: DEV_MODE === "1", domain: DOMAIN })
);

// Create temp address
async function createHandler(_req, res) {
  try {
    const local = rnd(8);
    const email = `${local}@${DOMAIN}`;
    // Κενό inbox list για το local με TTL
    await redis.expire(`inbox:${local}`, INBOX_TTL_S);
    res.json({ ok: true, local, email, expires_in: INBOX_TTL_S });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "create_failed" });
  }
}
app.post(["/create", "/api/create"], createHandler);

// Fetch inbox (by local)
async function inboxHandler(req, res) {
  try {
    const local = req.params.local.toLowerCase();
    const key = `inbox:${local}`;
    const ids = await redis.lrange(key, 0, 49);
    const pipe = redis.pipeline();
    ids.forEach((id) => pipe.hgetall(`msg:${id}`));
    const rows = (await pipe.exec()).map(([, v]) => v).filter(Boolean);
    res.json({ ok: true, messages: rows.map(toSummary) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "inbox_failed" });
  }
}
app.get(["/inbox/:local", "/api/inbox/:local"], inboxHandler);

// Fetch single message (by id)
async function messageHandler(req, res) {
  try {
    const id = req.params.id;
    const msg = await redis.hgetall(`msg:${id}`);
    if (!msg || !msg.id) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({
      ok: true,
      id: msg.id,
      from: msg.from || "",
      subject: msg.subject || "",
      body_plain: msg.text || "",
      body_html: msg.html || "",
      received_at: msg.date || new Date().toISOString(),
      headers: msg.headers ? JSON.parse(msg.headers) : {},
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "message_failed" });
  }
}
app.get(["/message/:id", "/api/message/:id"], messageHandler);

/* =======================
   Test endpoints (DEV)
======================= */
// Push a test “email” (sync)
app.get("/_test/push_sync", async (req, res) => {
  try {
    const to = String(req.query.to || "").toLowerCase();
    const subject = String(req.query.subject || "Hello");
    const text = String(req.query.text || "Hi there");
    if (!to.includes("@")) return res.status(400).json({ ok: false, error: "bad_to" });
    const local = to.split("@")[0];

    const id = rnd(12);
    const msgKey = `msg:${id}`;
    const inboxKey = `inbox:${local}`;
    const record = {
      id,
      to,
      from: "tester@local",
      subject,
      text,
      html: `<p>${text}</p>`,
      date: new Date().toISOString(),
      headers: JSON.stringify({ "x-source": "test_sync" }),
    };

    await redis.hmset(msgKey, record);
    await redis.expire(msgKey, MSG_TTL_S);
    await redis.lpush(inboxKey, id);
    await redis.ltrim(inboxKey, 0, 199);
    await redis.expire(inboxKey, INBOX_TTL_S);

    res.json({ ok: true, accepted: true, id, to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "push_failed" });
  }
});

// Push via POST (JSON)
app.post("/_test/push", async (req, res) => {
  try {
    const { to, subject = "Hello", text = "Hi" } = req.body || {};
    if (!to || !String(to).includes("@")) return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
    const local = String(to).toLowerCase().split("@")[0];

    const id = rnd(12);
    const msgKey = `msg:${id}`;
    const inboxKey = `inbox:${local}`;
    const record = {
      id,
      to,
      from: "tester@local",
      subject,
      text,
      html: `<p>${text}</p>`,
      date: new Date().toISOString(),
      headers: JSON.stringify({ "x-source": "test_post" }),
    };

    await redis.hmset(msgKey, record);
    await redis.expire(msgKey, MSG_TTL_S);
    await redis.lpush(inboxKey, id);
    await redis.ltrim(inboxKey, 0, 199);
    await redis.expire(inboxKey, INBOX_TTL_S);

    res.json({ ok: true, accepted: true, id, to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "push_failed" });
  }
});

/* =======================
   HTTP server start
======================= */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});

/* =======================
   SMTP (optional, internal testing)
======================= */
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"],
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const toAddr = (mail.to?.value?.[0]?.address || "unknown").toLowerCase();
          const local = toAddr.split("@")[0];
          const id = rnd(12);
          const record = {
            id,
            to: toAddr,
            from: mail.from?.text || "",
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            date: mail.date?.toISOString?.() || new Date().toISOString(),
            headers: JSON.stringify(Object.fromEntries(mail.headerLines?.map(h => [h.key, h.line]) || [])),
          };
          await redis.hmset(`msg:${id}`, record);
          await redis.expire(`msg:${id}`, MSG_TTL_S);
          await redis.lpush(`inbox:${local}`, id);
          await redis.ltrim(`inbox:${local}`, 0, 199);
          await redis.expire(`inbox:${local}`, INBOX_TTL_S);
          console.log(`[smtp] stored message -> ${toAddr} (${id})`);
          callback();
        } catch (e) {
          console.error("[smtp] store error:", e);
          callback(e);
        }
      })
      .catch((err) => {
        console.error("[smtp] parse error:", err);
        callback(err);
      });
  },
});
smtp.listen(SMTP_PORT, "0.0.0.0", () => console.log(`[smtp] listening on :${SMTP_PORT}`));
