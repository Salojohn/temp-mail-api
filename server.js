import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { redis } from "./redisClient.js";

/* ======================= Config ======================= */
const WEB_PORT  = process.env.PORT || 3000;
const SMTP_PORT = process.env.SMTP_PORT || 2525;  // Render δεν εκθέτει 25
const DEV_MODE  = process.env.DEV_MODE === "1";
const INBOX_TTL = Number(process.env.INBOX_TTL || 600); // sec
const MSG_TTL   = Number(process.env.MSG_TTL   || 600); // sec

/* ================ Helpers: keys & storage ============== */
const mailboxKey = (email) => `mailbox:${email.toLowerCase()}`;
const messageKey = (id) => `message:${id}`;

async function storeMessage(toEmail, record) {
  const mKey = messageKey(record.id);
  const listKey = mailboxKey(toEmail);

  // Σώσε το πλήρες μήνυμα με TTL
  await redis.set(mKey, JSON.stringify(record), "EX", MSG_TTL);

  // Index στο mailbox list
  await redis.lpush(listKey, record.id);
  await redis.ltrim(listKey, 0, 199);      // κράτα 200 ids
  await redis.expire(listKey, INBOX_TTL);  // TTL στο inbox list
}

/* ================= HTTP server (health & API) ========== */
const app = express();
app.disable("x-powered-by");

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Inbox → επιστρέφει expanded messages
app.get("/messages/:mailbox", async (req, res) => {
  try {
    const key = mailboxKey(req.params.mailbox);
    const ids = await redis.lrange(key, 0, 49);
    if (!ids?.length) return res.json({ mailbox: req.params.mailbox, count: 0, items: [] });

    const vals = await redis.mget(ids.map(messageKey));
    const items = vals.map((s) => (s ? JSON.parse(s) : null)).filter(Boolean);
    res.json({ mailbox: req.params.mailbox, count: items.length, items });
  } catch (e) {
    console.error("[api] inbox error:", e);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Read single message
app.get("/message/:id", async (req, res) => {
  try {
    const val = await redis.get(messageKey(req.params.id));
    if (!val) return res.status(404).json({ error: "Not found" });
    res.json(JSON.parse(val));
  } catch (e) {
    console.error("[api] get message error:", e);
    res.status(500).json({ error: "Failed to fetch" });
  }
});

// Delete inbox
app.delete("/messages/:mailbox", async (req, res) => {
  try {
    const key = mailboxKey(req.params.mailbox);
    const ids = await redis.lrange(key, 0, -1);
    if (ids?.length) await redis.del(...ids.map(messageKey));
    await redis.del(key);
    res.json({ mailbox: req.params.mailbox, deleted: true });
  } catch (e) {
    console.error("[api] delete inbox error:", e);
    res.status(500).json({ error: "Failed to delete mailbox" });
  }
});

// Test endpoints (ΜΟΝΟ αν DEV_MODE=1)
if (DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const to = (req.query.to || "test@example.com").toLowerCase();
      const record = {
        id: Date.now().toString(36),
        from: req.query.from || "sender@example.com",
        to,
        subject: req.query.subject || "Test via GET",
        text: req.query.text || "Hello from GET /_test/push",
        html: "",
        date: new Date().toISOString()
      };
      await storeMessage(to, record);
      res.json({ ok: true, stored: record });
    } catch (e) {
      console.error("[test] push error:", e);
      res.status(500).json({ error: "push failed" });
    }
  });

  app.post("/_test/push", async (req, res) => {
    try {
      const to = (req.body.to || "test@example.com").toLowerCase();
      const record = {
        id: Date.now().toString(36),
        from: req.body.from || "sender@example.com",
        to,
        subject: req.body.subject || "Test message",
        text: req.body.text || "Hello from POST /_test/push",
        html: req.body.html || "",
        date: new Date().toISOString()
      };
    await storeMessage(to, record);
      res.json({ ok: true, stored: record });
    } catch (e) {
      console.error("[test] push error:", e);
      res.status(500).json({ error: "push failed" });
    }
  });
}

const httpServer = app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});

/* ============== SMTP server (internal testing) ==========
   Render δεν proxy-άρει 25· το 2525 είναι μόνο για internal/integration tests.
   Για public inbound προτίμησε provider με webhooks (Mailgun/Postmark/Resend). */
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"],
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const toAddr = mail?.to?.value?.[0]?.address || "unknown@example.com";
          const to = toAddr.toLowerCase();

          const record = {
            id: Date.now().toString(36),
            from: mail.from?.text || "",
            to: mail.to?.text || to,
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            date: mail.date || new Date().toISOString(),
            headers: Object.fromEntries((mail.headerLines || []).map(h => [h.key, h.line]))
          };

          await storeMessage(to, record);
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

/* ================= Graceful shutdown ==================== */
function shutdown(signal) {
  console.log(`[sys] ${signal} received, shutting down...`);
  try { smtp.close(); } catch {}
  try { httpServer.close(() => console.log("[http] closed")); } catch {}
  try { redis.quit().catch(() => redis.disconnect()); } catch {}
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
