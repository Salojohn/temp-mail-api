// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { redis } from "./redisClient.js";

/* ------------ ENV ------------ */
const WEB_PORT   = process.env.PORT || 3000;
const SMTP_PORT  = process.env.SMTP_PORT || 2525;    // Render δεν εκθέτει :25
const DEV_MODE   = process.env.DEV_MODE === "1";
const INBOX_TTL  = Number(process.env.INBOX_TTL || 600); // sec
const MSG_TTL    = Number(process.env.MSG_TTL   || 600); // sec
const DOMAIN     = (process.env.DOMAIN || "temp-mail.gr").toLowerCase();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

/* ------------ Express app ------------ */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // πίσω από Render proxy

app.use(helmet());
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(bodyParser.json({ limit: "1mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
  })
);

/* ------------ helpers ------------ */
const randomId = (len = 10) =>
  Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 2 + len);

const normalizeEmail = (str = "") =>
  decodeURIComponent(String(str).trim().toLowerCase());

const isValidEmail = (email = "") =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const mailboxKey = (addr) => `mailbox:${addr.toLowerCase()}`;
const messageKey = (id)   => `msg:${id}`;

// helper: time-guard (μην “κρεμάει” ποτέ ο client)
const withTimeout = (p, ms = 1500) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), ms)),
  ]);

/** Αποθήκευση μηνύματος σε Redis (pipeline) */
async function storeMessage(record) {
  const listKey = mailboxKey(record.to);
  const mKey    = messageKey(record.id);
  const pipe = redis.pipeline();
  pipe.lpush(listKey, JSON.stringify(record));
  pipe.ltrim(listKey, 0, 199);                 // κρατάμε έως 200
  pipe.expire(listKey, INBOX_TTL);
  pipe.set(mKey, JSON.stringify(record), "EX", MSG_TTL);
  await pipe.exec();
}

/** Δημιουργία νέου temp email */
function generateAddress() {
  const local = randomId(6).slice(0, 10);
  return `${local}@${DOMAIN}`;
}

/* ------------ Routes ------------ */
// Health + debug
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/_debug/ping", (_req, res) =>
  res.json({ ok: true, t: Date.now(), dev: DEV_MODE, domain: DOMAIN })
);

// Δημιουργία temp email
app.post("/create", async (_req, res) => {
  const address = generateAddress();
  const key = mailboxKey(address);
  try {
    // προ-δημιούργησε inbox με TTL ώστε να ξέρει ο client το lifetime
    await redis.expire(key, INBOX_TTL);
  } catch { /* ignore */ }
  res.json({ ok: true, address, ttl: INBOX_TTL, domain: DOMAIN });
});

// Επιστροφή inbox (expanded messages)
app.get("/messages/:mailbox", async (req, res) => {
  try {
    const addr = normalizeEmail(req.params.mailbox);
    if (!isValidEmail(addr)) {
      return res.status(400).json({ error: "invalid mailbox" });
    }
    const key  = mailboxKey(addr);

    let raw = [];
    try {
      raw = await withTimeout(redis.lrange(key, 0, 49), 1500);
    } catch (e) {
      if (e.message === "TIMEOUT") {
        console.warn("[/messages] lrange timeout");
        return res.json({ mailbox: addr, count: 0, items: [] });
      }
      throw e;
    }

    if (!raw?.length) return res.json({ mailbox: addr, count: 0, items: [] });

    const items = raw.map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);

    res.json({ mailbox: addr, count: items.length, items });
  } catch (err) {
    console.error("[/messages] error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Λήψη ενός μηνύματος
app.get("/message/:id", async (req, res) => {
  try {
    const val = await withTimeout(redis.get(messageKey(req.params.id)), 1500);
    if (!val) return res.status(404).json({ error: "Not found" });
    res.json(JSON.parse(val));
  } catch (e) {
    if (e.message === "TIMEOUT") {
      return res.status(504).json({ error: "Timeout" });
    }
    console.error("[/message] error:", e);
    res.status(500).json({ error: "Failed to fetch" });
  }
});

// Διαγραφή inbox
app.delete("/messages/:mailbox", async (req, res) => {
  try {
    const addr = normalizeEmail(req.params.mailbox);
    if (!isValidEmail(addr)) {
      return res.status(400).json({ error: "invalid mailbox" });
    }
    const key = mailboxKey(addr);
    const idsRaw = await withTimeout(redis.lrange(key, 0, -1), 1500).catch(() => []);
    if (idsRaw?.length) {
      // σβήσε και τα per-message keys
      const parsed = idsRaw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      const ids = parsed.map((r) => r.id).filter(Boolean);
      if (ids.length) await redis.del(...ids.map(messageKey)).catch(() => {});
    }
    await redis.del(key).catch(() => {});
    res.json({ mailbox: addr, deleted: true });
  } catch (e) {
    console.error("[delete inbox] error:", e);
    res.status(500).json({ error: "Failed to delete mailbox" });
  }
});

/* ------------ DEV test (εικονική εισαγωγή) ------------ */
if (DEV_MODE) {
  // GET: /_test/push?to=a@b.com&subject=Hi&text=Hello
  app.get("/_test/push", async (req, res) => {
    try {
      const to      = normalizeEmail(req.query.to);
      const subject = String(req.query.subject || "");
      const text    = String(req.query.text || "");
      if (!isValidEmail(to)) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const id = randomId(8);
      const rec = {
        id,
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        date: new Date().toISOString(),
        headers: { "x-dev": "true" }
      };

      // απάντησε ΑΜΕΣΑ
      res.json({ ok: true, accepted: true, id, to });

      // γράψε στο παρασκήνιο
      const pipe = redis.pipeline();
      pipe.lpush(mailboxKey(to), JSON.stringify(rec));
      pipe.ltrim(mailboxKey(to), 0, 199);
      pipe.expire(mailboxKey(to), INBOX_TTL);
      pipe.set(messageKey(id), JSON.stringify(rec), "EX", MSG_TTL);
      pipe.exec().catch((e) => console.warn("[_test/push] pipeline error:", e?.message || e));
    } catch (err) {
      console.error("[_test/push] error:", err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "push failed" });
    }
  });

  // POST: /_test/push  { to, subject, text }
  app.post("/_test/push", async (req, res) => {
    try {
      const to      = normalizeEmail(req.body?.to);
      const subject = String(req.body?.subject || "");
      const text    = String(req.body?.text || "");
      if (!isValidEmail(to)) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }
      const id = randomId(8);
      const rec = {
        id, to,
        from: `tester@${DOMAIN}`,
        subject, text, html: "",
        date: new Date().toISOString(),
        headers: { "x-dev": "true" }
      };
      await storeMessage(rec);
      res.json({ ok: true, stored: rec });
    } catch (e) {
      console.error("[_test/push POST] error:", e);
      res.status(500).json({ ok: false, error: "push failed" });
    }
  });
}

/* ------------ SMTP server (internal use) ------------ */
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"], // demo only
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const toAddr = normalizeEmail(mail?.to?.value?.[0]?.address || "");
          if (!isValidEmail(toAddr)) throw new Error("No/invalid recipient");

          const headersObj =
            Object.fromEntries((mail.headerLines || []).map(h => [h.key, h.line])) || {};

          const rec = {
            id: randomId(8),
            to: toAddr,
            from: mail.from?.text || "",
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            date: mail.date || new Date().toISOString(),
            headers: headersObj
          };

          await storeMessage(rec);
          console.log(`[smtp] stored message for ${toAddr}`);
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

/* ------------ Start HTTP ------------ */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
