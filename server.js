// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* ======================= Redis (Upstash-friendly) ======================= */
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),
  // avoid crashing with MaxRetriesPerRequestError in serverless setups
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times) {
    return Math.min(times * 200, 2000); // backoff up to 2s
  },
  reconnectOnError(err) {
    const msg = err?.message || "";
    return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE|ECONNREFUSED|Connection is closed/i.test(msg);
  },
  keepAlive: 10000,
  connectTimeout: 10000,
});

redis.on("connect", () => console.log("[redis] connected"));
redis.on("reconnecting", (ms) => console.log(`[redis] reconnecting in ${ms}ms`));
redis.on("error", (e) => console.log("[redis] transient issue:", e?.code || e?.message));

/* ======================= Express app ======================= */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(helmet());

// CORS: comma-separated list in FRONTEND_ORIGIN (e.g. "https://temp-mail.gr,https://www.temp-mail.gr")
const allowed = (process.env.FRONTEND_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowed.includes("*") || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ======================= Helpers ======================= */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL = Number(process.env.MSG_TTL || 600);
const DOMAIN = process.env.DOMAIN || "temp-mail.gr";

const nowISO = () => new Date().toISOString();
const inboxKey = (local) => `inbox:${local}`;
const msgKey = (id) => `msg:${id}`;

/* ======================= Debug/Health ======================= */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/_debug/ping", (_req, res) => {
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: DOMAIN,
    allowedList: allowed,
  });
});

app.get("/_debug/redis", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, pong, url: redisUrl.slice(0, 32) + "…" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
  }
});

/* ======================= Core API ======================= */
// POST /create -> { email, local, expires_in }
async function handleCreate(_req, res) {
  try {
    const local = Math.random().toString(36).slice(2, 10);
    const email = `${local}@${DOMAIN}`;
    const key = inboxKey(local);

    // start/refresh inbox TTL
    await redis.del(key);
    await redis.expire(key, INBOX_TTL);

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("create error:", e);
    res.status(500).json({ ok: false, error: "create_failed" });
  }
}

// GET /inbox/:local -> { messages: [...] }
async function handleInbox(req, res) {
  try {
    const local = (req.params.local || "").trim();
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const ids = await redis.lrange(inboxKey(local), 0, 49);
    const out = [];
    for (const id of ids) {
      const raw = await redis.get(msgKey(id));
      if (!raw) continue;
      const m = JSON.parse(raw);
      out.push({
        id: m.id,
        from: m.from || "",
        subject: m.subject || "",
        preview: (m.text || "").slice(0, 160),
        received_at: m.received_at || m.date || nowISO(),
      });
    }
    res.json({ ok: true, messages: out });
  } catch (e) {
    console.error("inbox error:", e);
    res.status(500).json({ ok: false, error: "inbox_failed" });
  }
}

// GET /message/:id -> full message
async function handleMessage(req, res) {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await redis.get(msgKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = JSON.parse(raw);
    res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {},
    });
  } catch (e) {
    console.error("message error:", e);
    res.status(500).json({ ok: false, error: "message_failed" });
  }
}

/* Routes χωρίς /api */
app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);

/* Aliases με /api/* (για συμβατότητα με frontend που καλεί /api/...) */
app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);

/* ======================= DEV helper: push fake mail ======================= */
if (process.env.DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const to = String(req.query.to || "").toLowerCase();
      const subject = String(req.query.subject || "(no subject)");
      const text = String(req.query.text || "");

      if (!/^[^@]+@[^@]+\.[^@]+$/.test(to)) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const id = Math.random().toString(36).slice(2);
      const msg = {
        id,
        from: "tester@example.com",
        to,
        subject,
        text,
        html: `<p>${text}</p>`,
        received_at: nowISO(),
      };

      const local = to.split("@")[0];
      await redis.set(msgKey(id), JSON.stringify(msg), "EX", MSG_TTL);
      await redis.lpush(inboxKey(local), id);
      await redis.ltrim(inboxKey(local), 0, 199);
      await redis.expire(inboxKey(local), INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to });
    } catch (e) {
      console.error("push error:", e);
      res.status(500).json({ ok: false, error: "push_failed" });
    }
  });
}

/* ======================= Optional SMTP ingest (internal) ======================= */
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"],
  logger: false,
  onData(stream, _session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const to = (mail.to?.value?.[0]?.address || "").toLowerCase();
          if (!to) return callback();

          const id = Math.random().toString(36).slice(2);
          const msg = {
            id,
            from: mail.from?.text || "",
            to,
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            received_at: nowISO(),
            headers: Object.fromEntries(mail.headerLines?.map((h) => [h.key, h.line]) || []),
          };

          const local = to.split("@")[0];
          await redis.set(msgKey(id), JSON.stringify(msg), "EX", MSG_TTL);
          await redis.lpush(inboxKey(local), id);
          await redis.ltrim(inboxKey(local), 0, 199);
          await redis.expire(inboxKey(local), INBOX_TTL);

          console.log(`[smtp] stored message for ${to}`);
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

smtp.listen(SMTP_PORT, "0.0.0.0", () => {
  console.log(`[smtp] listening on :${SMTP_PORT}`);
});

/* ======================= Start ======================= */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
