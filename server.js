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
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls  = redisUrl.startsWith("rediss://");
const redis   = new Redis(redisUrl, useTls ? { tls: {} } : {});

redis.on("connect",   () => console.log("[redis] connected"));
redis.on("reconnecting", ms => console.log(`[redis] reconnecting in ${ms}ms`));
redis.on("error",     e  => console.log("[redis] transient issue:", e.code || e.message));

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", true);       // Render/Proxy safe
app.disable("x-powered-by");

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*",
}));
app.use(bodyParser.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL   = Number(process.env.MSG_TTL   || 600);

const nowISO = () => new Date().toISOString();

function mailboxKeyFromLocal(local) {
  // local = "abc123" -> key: "inbox:abc123"
  return `inbox:${local}`;
}
function messageKey(id) {
  return `msg:${id}`;
}

/* -------------------- Debug/Health -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/_debug/ping", (_req, res) => {
  res.json({ ok: true, t: Date.now(), dev: !!process.env.DEV_MODE, domain: process.env.DOMAIN || null });
});

/* -------------------- Core API logic -------------------- */

// POST /create -> { email, local, expires_in }
async function handleCreate(_req, res) {
  try {
    // Φτιάχνουμε local part τύπου abcdef (τυχαίο)
    const local = Math.random().toString(36).slice(2, 10);
    const domain = process.env.DOMAIN || "temp-mail.gr";
    const email = `${local}@${domain}`;

    const key = mailboxKeyFromLocal(local);
    // Δημιουργούμε το inbox ως κενή λίστα + TTL
    // θα αποθηκεύουμε ΜΟΝΟ ids μηνυμάτων μέσα στη λίστα
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
    const local = req.params.local;
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const key = mailboxKeyFromLocal(local);
    const ids = await redis.lrange(key, 0, 49);
    const messages = [];
    for (const id of ids) {
      const raw = await redis.get(messageKey(id));
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
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await redis.get(messageKey(id));
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
      headers: m.headers || {}
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

/* -------------------- DEV: push fake messages -------------------- */
/* Για γρήγορα tests χωρίς SMTP */
if (process.env.DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const toAddress = String(req.query.to || "").toLowerCase();
      const subject   = String(req.query.subject || "(no subject)");
      const text      = String(req.query.text || "");
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

      // local = part πριν το @
      const local = toAddress.split("@")[0];
      await redis.set(messageKey(id), JSON.stringify(msg), "EX", MSG_TTL);
      await redis.lpush(mailboxKeyFromLocal(local), id);
      await redis.ltrim(mailboxKeyFromLocal(local), 0, 199);
      await redis.expire(mailboxKeyFromLocal(local), INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to: toAddress });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "push_failed" });
    }
  });
}

/* -------------------- SMTP (προαιρετικό) -------------------- */
/* Αν θες incoming SMTP για δοκιμές μέσα στο Render container (internal only) */
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

          const id  = Math.random().toString(36).slice(2);
          const msg = {
            id,
            from: mail.from?.text || "",
            to,
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            received_at: nowISO(),
            headers: Object.fromEntries(mail.headerLines?.map(h => [h.key, h.line]) || []),
          };

          const local = to.split("@")[0];
          await redis.set(messageKey(id), JSON.stringify(msg), "EX", MSG_TTL);
          await redis.lpush(mailboxKeyFromLocal(local), id);
          await redis.ltrim(mailboxKeyFromLocal(local), 0, 199);
          await redis.expire(mailboxKeyFromLocal(local), INBOX_TTL);

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
