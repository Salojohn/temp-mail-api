// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* -------------------- Redis -------------------- */
/* Βάζουμε ασφαλείς προεπιλογές για να ΜΗΝ κρεμάει:
   - maxRetriesPerRequest: 3
   - connectTimeout: 3000ms
   - enableOfflineQueue: false (να μη συσσωρεύονται εντολές)
   - retryStrategy: εκθετική με ταβάνι 2s
   - TLS αν rediss://
*/
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),
  maxRetriesPerRequest: 3,
  connectTimeout: 3000,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(200 + times * 200, 2000),
  reconnectOnError: (err) => {
    // ξανασύνδεση μόνο σε connection-reset/read-timeout
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("econnreset") || msg.includes("timeout");
  },
});

redis.on("connect", () => console.log("[redis] connected"));
redis.on("reconnecting", (ms) =>
  console.log(`[redis] reconnecting in ${ms}ms`)
);
redis.on("error", (e) =>
  console.log("[redis] transient issue:", e.code || e.message)
);

/* -------------------- Express App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", true); // Render/Proxy safe
app.disable("x-powered-by");

app.use(helmet());
app.use(
  cors({
    origin:
      (process.env.FRONTEND_ORIGIN || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length > 0
        ? (process.env.FRONTEND_ORIGIN || "")
            .split(",")
            .map((s) => s.trim())
        : "*",
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

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL = Number(process.env.MSG_TTL || 600);

const nowISO = () => new Date().toISOString();
const keyInbox = (local) => `inbox:${local}`;
const keyMsg = (id) => `msg:${id}`;

/* -------------------- Health/Debug -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/_debug/ping", (_req, res) =>
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: process.env.DOMAIN || null,
    allowedList:
      (process.env.FRONTEND_ORIGIN || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [],
  })
);

// Δείξε ποιο REDIS_URL χρησιμοποιεί ο server (μάσκα στο password)
app.get("/_debug/redis-url", (_req, res) => {
  try {
    const v = process.env.REDIS_URL || "";
    const m = v.match(/^(rediss?:\/\/)([^:]+):([^@]+)@(.+)$/i);
    if (!m) return res.json({ ok: true, url: v || null });
    const masked = `${m[1]}${m[2]}:***@${m[4]}`;
    res.json({ ok: true, url: masked });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// Ping Redis με timeout 2s (να ΜΗΝ κρεμάει)
app.get("/_debug/redis", async (_req, res) => {
  const timeoutMs = 2000;
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("ping_timeout")), timeoutMs)
  );
  try {
    const pong = await Promise.race([redis.ping(), timeout]);
    res.json({ ok: true, pong });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* -------------------- Core API -------------------- */
// POST /create -> { ok, email, local, expires_in }
async function handleCreate(_req, res) {
  try {
    const local = Math.random().toString(36).slice(2, 10);
    const domain = process.env.DOMAIN || "temp-mail.gr";
    const email = `${local}@${domain}`;

    // Δημιουργούμε/αδειάζουμε inbox λίστα, και ορίζουμε TTL
    await redis.del(keyInbox(local));
    await redis.expire(keyInbox(local), INBOX_TTL);

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("create error:", e);
    res.status(500).json({ ok: false, error: "create_failed" });
  }
}

// GET /inbox/:local -> { ok, messages: [...] }
async function handleInbox(req, res) {
  try {
    const local = String(req.params.local || "").trim();
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const ids = await redis.lrange(keyInbox(local), 0, 49);
    const messages = [];
    for (const id of ids) {
      const raw = await redis.get(keyMsg(id));
      if (!raw) continue;
      const m = JSON.parse(raw);
      messages.push({
        id: m.id,
        from: m.from || "",
        subject: m.subject || "",
        preview: (m.text || "").slice(0, 160),
        received_at: m.received_at || m.date || nowISO(),
      });
    }
    res.json({ ok: true, messages });
  } catch (e) {
    console.error("inbox error:", e);
    res.status(500).json({ ok: false, error: "inbox_failed" });
  }
}

// GET /message/:id -> full body
async function handleMessage(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await redis.get(keyMsg(id));
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

/* ---- Routes χωρίς /api ---- */
app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);

/* ---- Aliases με /api/* ---- */
app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);

/* -------------------- DEV helper: push fake messages -------------------- */
if (process.env.DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const toAddress = String(req.query.to || "").toLowerCase();
      const subject = String(req.query.subject || "(no subject)");
      const text = String(req.query.text || "");
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
        html: `<p>${text}</p>`,
        received_at: nowISO(),
      };

      const local = toAddress.split("@")[0];
      await redis.set(keyMsg(id), JSON.stringify(msg), "EX", MSG_TTL);
      await redis.lpush(keyInbox(local), id);
      await redis.ltrim(keyInbox(local), 0, 199);
      await redis.expire(keyInbox(local), INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to: toAddress });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "push_failed" });
    }
  });
}

/* -------------------- SMTP (προαιρετικό, internal) -------------------- */
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"],
  logger: false,
  onData(stream, session, callback) {
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
            headers: Object.fromEntries(
              mail.headerLines?.map((h) => [h.key, h.line]) || []
            ),
          };

          const local = to.split("@")[0];
          await redis.set(keyMsg(id), JSON.stringify(msg), "EX", MSG_TTL);
          await redis.lpush(keyInbox(local), id);
          await redis.ltrim(keyInbox(local), 0, 199);
          await redis.expire(keyInbox(local), INBOX_TTL);

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

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
