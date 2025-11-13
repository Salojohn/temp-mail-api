
// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { Redis as UpstashRedis } from "@upstash/redis";

/* -------------------- Upstash Redis (REST) -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

const rGet        = async (k)        => await redis.get(k);
const rSetEX      = async (k,v,ex)   => await redis.set(k, v, { ex });
const rLPush      = async (k,v)      => await redis.lpush(k, v);
const rLTrim      = async (k,s,e)    => await redis.ltrim(k, s, e);
const rLRange     = async (k,s,e)    => await redis.lrange(k, s, e);
const rExpire     = async (k,sec)    => await redis.expire(k, sec);
const rDel        = async (k)        => await redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);       // Απαραίτητο για Render & rate-limit
app.disable("x-powered-by");

/* --- Health/debug ΠΡΙΝ το rate-limit --- */
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

/* --- NEW: Self-test για Upstash --- */
app.get("/_debug/selftest", async (_req, res) => {
  try {
    const key = `selftest:${Date.now()}`;
    // 1) SETEX
    await rSetEX(key, JSON.stringify({ ok: true }), 30);
    // 2) GET
    const got = await rGet(key);
    // 3) LIST ops
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

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allow = (process.env.FRONTEND_ORIGIN || "*")
      .split(",").map(s => s.trim());
    if (!origin || allow.includes("*") || allow.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  }
}));
app.use(bodyParser.json({ limit: "1mb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Μην φρενάρεις health/debug, για να μην παίρνουμε 500 από το lib
  skip: (req) => req.path === "/" || req.path === "/healthz" || req.path.startsWith("/_debug")
}));

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL   = Number(process.env.MSG_TTL   || 600);
const DOMAIN    = process.env.DOMAIN || "temp-mail.gr";

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

/* -------------------- Core API -------------------- */

// POST /create -> { ok, email, local, expires_in }
async function handleCreate(_req, res) {
  const local = Math.random().toString(36).slice(2, 10);
  const email = `${local}@${DOMAIN}`;
  const key = mailboxKeyFromLocal(local);

  try {
    // 1) Καθάρισε/ετοίμασε inbox
    await rDel(key);                           // ok αν δεν υπάρχει
    // 2) Βάλε ένα marker για να υπάρχει key (ώστε να μην κολλήσει EXPIRE)
    await rLPush(key, "__init__");             // δημιουργεί τη λίστα
    await rLTrim(key, 1, -1);                  // σβήσε το marker, λίστα άδεια
    // 3) TTL
    await rExpire(key, INBOX_TTL);             // λίστα με TTL, ακόμα κι αν είναι άδεια

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
      if (id === "__init__") continue;  // αγνόησε τυχόν marker
      const raw = await rGet(messageKey(id));
      if (!raw) continue;
      const m = typeof raw === "string" ? JSON.parse(raw) : raw;
      messages.push({
        id: m.id,
        from: m.from || "",
        subject: m.subject || "",
        preview: (m.text || "").slice(0, 160),
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
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {}
    });
  } catch (e) {
    console.error("message error:", e);
    return res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
}

/* ---- Routes (και /api/* aliases) ---- */
app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);

app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);

/* -------------------- DEV: /_test/push -------------------- */
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

      await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
      const mbox = mailboxKeyFromLocal(local);
      await rLPush(mbox, id);
      await rLTrim(mbox, 0, 199);
      await rExpire(mbox, INBOX_TTL);

      return res.json({ ok: true, accepted: true, id, to: toAddress });
    } catch (e) {
      console.error("[_test/push] error:", e);
      return res.status(500).json({ ok: false, error: e.message || "push_failed" });
    }
  });
}

/* -------------------- (Προαιρετικό) SMTP για internal tests -------------------- */
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

          await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
          const mbox = mailboxKeyFromLocal(local);
          await rLPush(mbox, id);
          await rLTrim(mbox, 0, 199);
          await rExpire(mbox, INBOX_TTL);

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
