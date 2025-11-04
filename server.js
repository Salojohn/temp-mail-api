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
const SMTP_PORT  = process.env.SMTP_PORT || 2525;          // Render δεν εκθέτει 25 δημοσίως
const DEV_MODE   = process.env.DEV_MODE === "1";
const INBOX_TTL  = Number(process.env.INBOX_TTL || 600);   // sec
const MSG_TTL    = Number(process.env.MSG_TTL   || 600);   // sec
const DOMAIN     = (process.env.DOMAIN || "temp-mail.gr").toLowerCase();

/** CORS allowlist για παραγωγή. Πρόσθεσε/αφαίρεσε origins όπως θέλεις. */
const ALLOW_ORIGINS = new Set([
  "https://temp-mail.gr",
  "https://www.temp-mail.gr",
  "https://api.temp-mail.gr",
  "https://temp-mail-api-2.onrender.com",
]);

/* ------------ Express ------------ */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // πίσω από Render proxy

// Helmet (CSP off για να παίξει blob: στο iframe · μπορείς να το σφίξεις αργότερα)
app.use(helmet({ contentSecurityPolicy: false }));

// CORS (allowlist). Αν θέλεις «άνοιγμα» προσωρινά, βάλε origin: "*"
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // server-to-server / curl
      if (ALLOW_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
    },
    credentials: false,
  })
);
app.options("*", cors());

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

/* ------------ Helpers ------------ */
const randomId = (len = 10) =>
  Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 2 + len);

const normalizeEmail = (str = "") => decodeURIComponent(String(str).trim().toLowerCase());

const isValidEmail = (email = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const mailboxKey = (addr) => `mailbox:${addr.toLowerCase()}`;
const messageKey = (id) => `msg:${id}`;

const withTimeout = (p, ms = 1500) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), ms))]);

/** Αποθήκευση μηνύματος σε Redis (pipeline + TTLs) */
async function storeMessage(rec) {
  const listKey = mailboxKey(rec.to);
  const mKey = messageKey(rec.id);
  const pipe = redis.pipeline();
  pipe.lpush(listKey, JSON.stringify(rec));
  pipe.ltrim(listKey, 0, 199); // έως 200 ανά inbox
  pipe.expire(listKey, INBOX_TTL);
  pipe.set(mKey, JSON.stringify(rec), "EX", MSG_TTL);
  await pipe.exec();
}

/** Δημιουργία νέου temp email */
function generateAddress() {
  const local = randomId(6).slice(0, 10);
  return { local, email: `${local}@${DOMAIN}` };
}

/* ------------ Core handlers (για reuse σε / και /api) ------------ */
async function handleCreate(_req, res) {
  const { local, email } = generateAddress();
  const key = mailboxKey(email);
  try {
    await redis.expire(key, INBOX_TTL);
  } catch {}
  // Επιστρέφουμε και τα δύο schemas (παλιό & νέο) για πλήρη συμβατότητα
  res.json({
    ok: true,
    // νέο schema (frontend expects)
    email,
    local,
    expires_in: INBOX_TTL,
    domain: DOMAIN,
    // legacy keys
    address: email,
    ttl: INBOX_TTL,
  });
}

async function handleInboxEmail(req, res) {
  // input: full email (π.χ. foo@temp-mail.gr)
  try {
    const addr = normalizeEmail(req.params.mailbox);
    if (!isValidEmail(addr)) return res.status(400).json({ error: "invalid mailbox" });
    const key = mailboxKey(addr);

    let raw;
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

    const items =
      raw.map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      }).filter(Boolean) || [];

    res.json({ mailbox: addr, count: items.length, items });
  } catch (err) {
    console.error("[/messages] error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
}

async function handleInboxLocal(req, res) {
  // input: μόνο local (π.χ. "foo"), συνθέτουμε email
  try {
    const local = String(req.params.local || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(local)) return res.status(400).json({ error: "invalid local" });
    const addr = `${local}@${DOMAIN}`;
    req.params.mailbox = addr;
    return handleInboxEmail(req, res);
  } catch (e) {
    console.error("[/api/inbox] error:", e);
    res.status(500).json({ error: "Failed to fetch inbox" });
  }
}

async function handleMessage(req, res) {
  try {
    const val = await withTimeout(redis.get(messageKey(req.params.id)), 1500);
    if (!val) return res.status(404).json({ error: "Not found" });
    res.json(JSON.parse(val));
  } catch (e) {
    if (e.message === "TIMEOUT") return res.status(504).json({ error: "Timeout" });
    console.error("[/message] error:", e);
    res.status(500).json({ error: "Failed to fetch" });
  }
}

async function handleDeleteInboxEmail(req, res) {
  try {
    const addr = normalizeEmail(req.params.mailbox);
    if (!isValidEmail(addr)) return res.status(400).json({ error: "invalid mailbox" });

    const key = mailboxKey(addr);
    const raw = await withTimeout(redis.lrange(key, 0, -1), 1500).catch(() => []);
    if (raw?.length) {
      const parsed =
        raw
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter(Boolean) || [];
      const ids = parsed.map((r) => r.id).filter(Boolean);
      if (ids.length) await redis.del(...ids.map(messageKey)).catch(() => {});
    }
    await redis.del(key).catch(() => {});
    res.json({ mailbox: addr, deleted: true });
  } catch (e) {
    console.error("[delete inbox] error:", e);
    res.status(500).json({ error: "Failed to delete mailbox" });
  }
}

async function handleDeleteInboxLocal(req, res) {
  try {
    const local = String(req.params.local || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(local)) return res.status(400).json({ error: "invalid local" });
    const addr = `${local}@${DOMAIN}`;
    req.params.mailbox = addr;
    return handleDeleteInboxEmail(req, res);
  } catch (e) {
    console.error("[/api/inbox DELETE] error:", e);
    res.status(500).json({ error: "Failed to delete mailbox" });
  }
}

/* ------------ Routes ------------ */
// Health/debug
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: Date.now() }));
app.get("/_debug/ping", (_req, res) =>
  res.json({ ok: true, t: Date.now(), dev: DEV_MODE, domain: DOMAIN })
);

// Legacy routes
app.post("/create", handleCreate);
app.get("/messages/:mailbox", handleInboxEmail);
app.get("/message/:id", handleMessage);
app.delete("/messages/:mailbox", handleDeleteInboxEmail);

// API namespaced routes (frontend-friendly)
app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInboxLocal);
app.get("/api/message/:id", handleMessage);
app.delete("/api/inbox/:local", handleDeleteInboxLocal);

/* ------------ DEV test routes ------------ */
if (DEV_MODE) {
  // GET async (απαντάει άμεσα, γράφει στο background)
  app.get("/_test/push", async (req, res) => {
    try {
      const to = normalizeEmail(req.query.to);
      const subject = String(req.query.subject || "");
      const text = String(req.query.text || "");
      if (!isValidEmail(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' address" });

      const id = randomId(8);
      const rec = {
        id,
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        date: new Date().toISOString(),
        headers: { "x-dev": "true" },
      };

      // απάντησε αμέσως
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

  // POST sync (περιμένει να γραφτεί)
  app.post("/_test/push", async (req, res) => {
    try {
      const to = normalizeEmail(req.body?.to);
      const subject = String(req.body?.subject || "");
      const text = String(req.body?.text || "");
      if (!isValidEmail(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' address" });

      const id = randomId(8);
      const rec = {
        id,
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        date: new Date().toISOString(),
        headers: { "x-dev": "true" },
      };
      await storeMessage(rec);
      res.json({ ok: true, stored: rec });
    } catch (e) {
      console.error("[_test/push POST] error:", e);
      res.status(500).json({ ok: false, error: "push failed" });
    }
  });

  // GET sync (για δοκιμή από browser)
  app.get("/_test/push_sync", async (req, res) => {
    try {
      const to = normalizeEmail(req.query.to);
      const subject = String(req.query.subject || "");
      const text = String(req.query.text || "");
      if (!isValidEmail(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' address" });

      const id = randomId(8);
      const rec = {
        id,
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        date: new Date().toISOString(),
        headers: { "x-dev": "true" },
      };
      await storeMessage(rec); // synch write
      res.json({ ok: true, stored: true, id, to });
    } catch (e) {
      console.error("[_test/push_sync] error:", e);
      res.status(500).json({ ok: false, error: "push_sync failed" });
    }
  });
}

/* ------------ SMTP (internal) ------------ */
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
            Object.fromEntries((mail.headerLines || []).map((h) => [h.key, h.line])) || {};

          const rec = {
            id: randomId(8),
            to: toAddr,
            from: mail.from?.text || "",
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            date: mail.date || new Date().toISOString(),
            headers: headersObj,
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
  },
});

smtp.listen(SMTP_PORT, "0.0.0.0", () => {
  console.log(`[smtp] listening on :${SMTP_PORT}`);
});

/* ------------ Start HTTP ------------ */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
