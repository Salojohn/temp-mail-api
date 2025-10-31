import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* ------------ Redis connection (stable) ------------ */
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),

  // Μην πετάει MaxRetriesPerRequestError για εκκρεμή αιτήματα
  maxRetriesPerRequest: null,

  // Reconnect backoff: 200ms, 400ms, ... έως 2000ms
  retryStrategy: (times) => Math.min(times * 200, 2000),

  // Κράτα ζωντανή τη σύνδεση & βάλε έγκαιρα timeouts
  keepAlive: 10000,
  connectTimeout: 10000,

  // Σε managed providers βοηθά να είναι off
  enableReadyCheck: false,

  // Ζήτα reconnect σε συγκεκριμένα σφάλματα
  reconnectOnError: (err) => /READONLY|ECONNRESET|EPIPE/i.test(err?.message || "")
});

redis.on("connect", () => console.log("[redis] connected"));
redis.on("error", (e) => console.error("[redis] error:", e));

// Ping κάθε 30s ώστε οι free providers να μη θεωρούν τη σύνδεση idle
setInterval(() => {
  redis.ping().catch(() => {});
}, 30000);

/* ------------ HTTP (health/API) ------------ */
// Στο Render ΠΡΕΠΕΙ να ακούς στο PORT για να θεωρηθεί “healthy” το service
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
    legacyHeaders: false,
  })
);

app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Ενδεικτικό endpoint για ανάγνωση μηνυμάτων από Redis
app.get("/messages/:mailbox", async (req, res) => {
  try {
    const key = `mailbox:${req.params.mailbox.toLowerCase()}`;
    const items = await redis.lrange(key, 0, 49); // latest 50
    const list = items.map((s) => JSON.parse(s));
    res.json({ mailbox: req.params.mailbox, count: list.length, items: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});

/* ------------ SMTP server ------------ */
/* Σημείωση: Το Render δεν κάνει proxy SMTP/25 από έξω.
   Δένουμε σε μη-privileged port (π.χ. 2525) για internal χρήση/testing.
   Για πραγματικό public SMTP ingress χρειάζεται TCP service σε άλλον provider. */
const SMTP_PORT = process.env.SMTP_PORT || 2525;

const smtp = new SMTPServer({
  disabledCommands: ["AUTH"], // demo: χωρίς auth
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          // Χρησιμοποίησε τον πρώτο recipient ως mailbox key
          const to = (mail.to?.value?.[0]?.address || "unknown").toLowerCase();
          const key = `mailbox:${to}`;

          const record = {
            id: Date.now().toString(36),
            from: mail.from?.text || "",
            to: mail.to?.text || "",
            subject: mail.subject || "",
            date: mail.date || new Date().toISOString(),
            text: mail.text || "",
            html: mail.html || "",
            headers:
              Object.fromEntries(
                (mail.headerLines || []).map((h) => [h.key, h.line])
              ) || {},
          };

          await redis.lpush(key, JSON.stringify(record));
          await redis.ltrim(key, 0, 199); // κράτα μέχρι 200/mbox
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
