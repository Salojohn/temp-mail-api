// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { Readable } from "stream";
import { Redis as UpstashRedis } from "@upstash/redis";
import { simpleParser } from "mailparser";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Upstash Redis client (REST) ---
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

// tiny wrappers
const rGet    = async (k)      => await redis.get(k);
const rSetEX  = async (k,v,ex) => await redis.set(k, v, { ex });
const rLPush  = async (k,v)    => await redis.lpush(k, v);
const rLTrim  = async (k,s,e)  => await redis.ltrim(k, s, e);
const rLRange = async (k,s,e)  => await redis.lrange(k, s, e);
const rExpire = async (k,sec)  => await redis.expire(k, sec);
const rDel    = async (k)      => await redis.del(k);

// --- Config ---
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL   = Number(process.env.MSG_TTL   || 600);
const DOMAIN    = process.env.DOMAIN || "temp-mail.gr";
const API_KEY   = process.env.API_KEY || ""; // protect /push
const DEV_MODE  = !!process.env.DEV_MODE;

// --- Helpers ---
const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

// --- Middlewares ---
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: (o, cb) => cb(null, true) })); // change if lock-down needed
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/" || req.path.startsWith("/_debug")
}));

// Multer for multipart/form-data (attachments)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 } }); // 300KB per attachment cap

// --- Debug / Health ---
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/_debug/ping", (_req, res) => {
  res.json({
    ok: true,
    t: Date.now(),
    dev: DEV_MODE,
    domain: DOMAIN,
    hasUpstash: !!redisUrl && !!redisToken
  });
});
app.get("/_debug/redis", (_req, res) =>
  res.json({ ok: true, url: !!redisUrl, token: !!redisToken }));

// --- Self-test (Upstash) ---
app.get("/_debug/selftest", async (_req, res) => {
  try {
    const key = `selftest:${Date.now()}`;
    await rSetEX(key, JSON.stringify({ ok: true }), 30);
    const got = await rGet(key);
    const lkey = `selflist:${Date.now()}`;
    await rLPush(lkey, "a");
    await rLPush(lkey, "b");
    await rExpire(lkey, 30);
    const lr = await rLRange(lkey, 0, 9);
    res.json({ ok: true, setexValue: got, list: lr });
  } catch (e) {
    console.error("[selftest] ", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------------- Core API ----------------

// POST /create
app.post("/create", async (_req, res) => {
  try {
    const local = Math.random().toString(36).slice(2, 10);
    const email = `${local}@${DOMAIN}`;
    const key = mailboxKeyFromLocal(local);

    // ensure list exists + TTL
    await rDel(key);
    await rLPush(key, "__init__");
    await rLTrim(key, 1, -1);
    await rExpire(key, INBOX_TTL);

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("[create] ", e);
    res.status(500).json({ ok: false, error: "create_failed" });
  }
});

// GET /inbox/:local
app.get("/inbox/:local", async (req, res) => {
  try {
    const local = req.params.local;
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const key = mailboxKeyFromLocal(local);
    const ids = await rLRange(key, 0, 199);
    const messages = [];

    for (const id of ids) {
      if (id === "__init__") continue;
      const raw = await rGet(messageKey(id));
      if (!raw) continue;
      const m = typeof raw === "string" ? JSON.parse(raw) : raw;
      messages.push({
        id: m.id,
        from: m.from || "",
        subject: m.subject || "",
        preview: (m.text || "").slice(0, 220),
        received_at: m.received_at || nowISO()
      });
    }

    res.json({ ok: true, messages });
  } catch (e) {
    console.error("inbox error:", e);
    res.status(500).json({ ok: false, error: "inbox_failed" });
  }
});

// GET /message/:id
app.get("/message/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await rGet(messageKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof raw === "string" ? JSON.parse(raw) : raw;
    res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      to: m.to || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      attachments: m.attachments || [],
      received_at: m.received_at || nowISO(),
      headers: m.headers || {}
    });
  } catch (e) {
    console.error("message error:", e);
    res.status(500).json({ ok: false, error: "message_failed" });
  }
});

/*
  POST /push
  Accepts:
   - JSON body (from worker or test): { to, from, subject, text, html, headers }
   - multipart/form-data (from Mailgun): fields like 'recipient' / 'to', 'from', 'subject', 'body-plain','body-html' + files attachments[]

  Requires: header x-api-key === API_KEY OR DEV_MODE true (optionally).
*/
app.post("/push", upload.any(), async (req, res) => {
  try {
    // auth
    const keyHeader = req.get("x-api-key") || "";
    if (!DEV_MODE && API_KEY && keyHeader !== API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // pick fields from form or json
    const body = req.body || {};
    const to = (body.to || body.recipient || body.recipient || body["recipient[0]"] || "").toLowerCase();
    const from = body.from || body.sender || body["sender"] || "";
    const subject = body.subject || "";
    const textPlain = body["body-plain"] || body.text || body.plain || body.body || "";
    const htmlBody = body["body-html"] || body.html || "";

    if (!to) return res.status(400).json({ ok: false, error: "missing_to" });

    // attachments (multer stored in req.files)
    const attachments = [];
    if (req.files && req.files.length) {
      for (const f of req.files) {
        // limit storing very large attachments: keep only first N or size-limit already set by multer
        const base64 = f.buffer.toString("base64");
        attachments.push({
          filename: f.originalname,
          contentType: f.mimetype,
          size: f.size,
          data_b64: base64.slice(0, 300 * 1024 * 4 / 3) // truncate if needed
        });
      }
    }

    // store message
    const id = Math.random().toString(36).slice(2);
    const msg = {
      id,
      from,
      to,
      subject,
      text: textPlain,
      html: htmlBody,
      attachments,
      headers: body.headers || {},
      received_at: nowISO()
    };

    // push to redis
    await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
    const local = to.split("@")[0];
    const mbox = mailboxKeyFromLocal(local);
    await rLPush(mbox, id);
    await rLTrim(mbox, 0, 199);
    await rExpire(mbox, INBOX_TTL);

    return res.json({ ok: true, stored: true, id, to });
  } catch (e) {
    console.error("/push error:", e);
    return res.status(500).json({ ok: false, error: "push_failed" });
  }
});

// --- DEV-only quick push via GET (/_test/push?to=..&subject=..&text=..) ---
if (DEV_MODE) {
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
        attachments: [],
        received_at: nowISO()
      };

      const local = to.split("@")[0];
      await rSetEX(messageKey(id), JSON.stringify(msg), MSG_TTL);
      await rLPush(mailboxKeyFromLocal(local), id);
      await rLTrim(mailboxKeyFromLocal(local), 0, 199);
      await rExpire(mailboxKeyFromLocal(local), INBOX_TTL);

      res.json({ ok: true, accepted: true, id, to });
    } catch (e) {
      console.error("[_test/push] ", e);
      res.status(500).json({ ok: false, error: "push_failed" });
    }
  });
}

// Optional SMTP server is NOT included here — prefer Mailgun inbound / Cloudflare worker

// Start
app.listen(PORT, () => console.log(`[http] listening on :${PORT}`));
