import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* ------------ Redis connection (stable + quiet logs) ------------ */
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  keepAlive: 10000,
  connectTimeout: 10000,
  enableReadyCheck: false,
  reconnectOnError: (err) => /READONLY|ECONNRESET|EPIPE/i.test(err?.message || "")
});

let firstConnect = true;
let lastWarn = 0;
const LOG_REDIS = process.env.LOG_REDIS === "1";

redis.on("connect", () => {
  if (firstConnect) {
    console.log("[redis] connected");
    firstConnect = false;
  } else if (LOG_REDIS) {
    console.log("[redis] reconnected");
  }
});

redis.on("ready", () => {
  if (LOG_REDIS) console.log("[redis] ready");
});

redis.on("reconnecting", (ms) => {
  const now = Date.now();
  if (now - lastWarn > 60000) {
    console.warn(`[redis] reconnecting in ${ms}ms`);
    lastWarn = now;
  }
});

redis.on("end", () => {
  console.warn("[redis] connection closed");
});

redis.on("error", (e) => {
  const now = Date.now();
  if (now - lastWarn > 60000) {
    console.warn("[redis] transient issue:", e.code || e.message);
    lastWarn = now;
  }
});

// Ping συχνά για να αποφεύγονται idle disconnects σε free plans
setInterval(() => {
  redis.ping().catch(() => {});
}, 20000);

/* ------------ HTTP (health & API) ------------ */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(bodyParser.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Λήψη τελευταίων 50 emails από mailbox
app.get("/messages/:mailbox", async (req, res) => {
  try {
    const key = `mailbox:${req.params.mailbox.toLowerCase()}`;
    const items = await redis.lrange(key, 0, 49);
    const list = items.map((s) => JSON.parse(s));
    res.json({ mailbox: req.params.mailbox, count: list.length, items: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Διαγραφή mailbox
app.delete("/messages/:mailbox", async (req, res) => {
  try {
    const key = `mailbox:${req.params.mailbox.toLowerCase()}`;
    await redis.del(key);
    res.json({ mailbox: req.params.mailbox, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete mailbox" });
  }
});

const httpServer = app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});

/* ------------ SMTP server (store to Redis) ------------ */
// Render δεν κάνει proxy SMTP/25. Χρησιμοποιούμε 2525 για internal/testing.
const SMTP_PORT = process.env.SMTP_PORT || 2525;

const smtp = new SMTPServer({
  disabledCommands: ["AUTH"], // demo χωρίς auth
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const toAddr = mail.to?.value?.[0]?.address || "unknown";
          const to = toAddr.toLowerCase();
          const key = `mailbox:${to}`;

          const record = {
            id: Date.now().toString(36),
            from: mail.from?.text || "",
            to: mail.to?.text || "",
            subject: mail.subject || "",
            date: mail.date || new Date().toISOString(),
            text: mail.text || "",
            html: mail.html || "",
            headers: Object.fromEntries(
              (mail.headerLines || []).map((h) => [h.key, h.line])
            )
          };

          await redis.lpush(key, JSON.stringify(record));
          await redis.ltrim(key, 0, 199); // κράτα 200 max ανά mailbox
          if (LOG_REDIS) console.log(`[smtp] stored message for ${to}`);
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
  }
});

smtp.listen(SMTP_PORT, "0.0.0.0", () => {
  console.log(`[smtp] listening on :${SMTP_PORT}`);
});

/* ------------ Graceful shutdown ------------ */
function shutdown(signal) {
  console.log(`[sys] ${signal} received, shutting down...`);
  try { smtp.close(); } catch {}
  try { httpServer.close(() => console.log("[http] closed")); } catch {}
  try { redis.quit().catch(() => redis.disconnect()); } catch {}
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
