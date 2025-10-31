import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";

/* ------------ Redis connection ------------ */
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");
const redis = new Redis(redisUrl, useTls ? { tls: {} } : {});
redis.on("connect", () => console.log("[redis] connected"));
redis.on("error", (e) => console.error("[redis] error:", e));

/* ------------ HTTP Server ------------ */
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

// ---- DEV TEST ROUTE ----
if (process.env.DEV_MODE === "1") {
  app.get("/_test/push", async (req, res) => {
    try {
      const to = (req.query.to || "").toLowerCase();
      if (!to) return res.status(400).json({ error: "Missing ?to=" });
      const msg = {
        id: Date.now().toString(36),
        from: "local@test",
        to,
        subject: req.query.subject || "(no subject)",
        text: req.query.text || "",
        date: new Date().toISOString(),
      };
      const key = `mailbox:${to}`;
      await redis.lpush(key, JSON.stringify(msg));
      await redis.ltrim(key, 0, 199);
      console.log(`[test] pushed message for ${to}`);
      res.json({ ok: true, stored: msg });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
}

/* ------------ Read inbox ------------ */
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

app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});

/* ------------ SMTP server ------------ */
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"],
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
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
            headers: Object.fromEntries(mail.headerLines?.map(h => [h.key, h.line]) || []),
          };

          await redis.lpush(key, JSON.stringify(record));
          await redis.ltrim(key, 0, 199);
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
