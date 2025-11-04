// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { Redis } from "@upstash/redis";

/* -------------------- Redis (Upstash REST) -------------------- */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allowed = (process.env.FRONTEND_ORIGIN || "*")
      .split(",")
      .map(s => s.trim());
    if (!origin || allowed.includes("*") || allowed.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  }
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
const DOMAIN    = process.env.DOMAIN || "temp-mail.gr";

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

/* -------------------- Debug/Health -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/_debug/ping", (_req, res) => {
  const allowedList = (process.env.FRONTEND_ORIGIN || "*").split(",").map(s => s.trim());
  res.json({ ok: true, t: Date.now(), dev: !!process.env.DEV_MODE, domain: DOMAIN, allowedList });
});

/* -------------------- Core API -------------------- */
// POST /create -> { ok, email, local, expires_in }
async function handleCreate(_req, res) {
  try {
    const local = Math.random().toString(36).slice(2, 10);
    const email = `${local}@${DOMAIN}`;

    const key = mailboxKeyFromLocal(local);
    // Δημιουργία/refresh inbox (κενή λίστα) και TTL
    await redis.del(key);
    await redis.expire(key, INBOX_TTL); // Upstash δέχεται expire χωρίς τιμή; χρησιμοποιούμε set+EX εναλλακτικά

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("create error:", e);
    res.status(500).json({ ok: false, error: "create_failed", detail: String(e) });
  }
}

// GET /inbox/:local -> { ok, messages:[...] }
async function handleInbox(req, res) {
  try {
    const local = req.params.local;
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const key = mailboxKeyFromLocal(local);
    const ids = await redis.lrange(key, 0, 49);
    const messages = [];
    for (const id of ids) {
      const m = await redis.get(messageKey(id));
      if (!m) continue;
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
    res.status(500).json({ ok: false, error: "inbox_failed", detail: String(e) });
  }
}

// GET /message/:id -> full body
async function handleMessage(req, res) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const m = await redis.get(messageKey(id));
    if (!m) return res.status(404).json({ ok: false, error: "not_found" });

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
    res.status(500).json({ ok: false, error: "message_failed", detail: String(e) });
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

      const local = toAddress.split("@")[0];

      await redis.set(messageKey(id), msg, { ex: MSG_TTL });
      await redis.lpush(mailboxKeyFromLocal(local), id);
      await redis.ltrim(mailboxKeyFromLocal(local), 0, 199);
      await redis.expire(mailboxKeyFromLocal(local), INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to: toAddress });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "push_failed", detail: String(e) });
    }
  });
}

/* -------------------- (Προαιρετικό) SMTP -------------------- */
// Το Render δεν εκθέτει SMTP προς τα έξω, το κρατάμε μόνο για εσωτερικό testing.
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
          await redis.set(messageKey(id), msg, { ex: MSG_TTL });
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
