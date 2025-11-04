// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Redis } from "@upstash/redis";           // REST client (no sockets)
import { SMTPServer } from "smtp-server";         // optional
import { simpleParser } from "mailparser";        // optional

/* -------------------- Redis (Upstash REST) -------------------- */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* -------------------- App bootstrap -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(helmet());
app.use(bodyParser.json({ limit: "1mb" }));

// CORS: δέχεται λίστα origins χωρισμένα με κόμμα
const allowed = (process.env.FRONTEND_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowed.includes("*") || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* -------------------- Helpers -------------------- */
const DOMAIN = process.env.DOMAIN || "temp-mail.gr";
const INBOX_TTL = Number(process.env.INBOX_TTL || 600); // seconds
const MSG_TTL = Number(process.env.MSG_TTL || 600);

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`; // list of message ids
const messageKey = (id) => `msg:${id}`;

/* -------------------- Health/Debug -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/_debug/ping", (_req, res) => {
  res.json({
    ok: true,
    t: Date.now(),
    dev: !!process.env.DEV_MODE,
    domain: DOMAIN,
    allowedList: allowed,
  });
});

app.get("/_debug/redis", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, ping: pong });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* -------------------- Core API -------------------- */
// POST /create -> { ok, email, local, expires_in }
app.post("/create", async (_req, res) => {
  try {
    const local = Math.random().toString(36).slice(2, 10);
    const email = `${local}@${DOMAIN}`;

    const key = mailboxKeyFromLocal(local);
    // φτιάχνουμε άδειο inbox με TTL (Upstash: set ένα marker και expire)
    await redis.del(key); // καθαρισμός λίστας μηνυμάτων
    // Upstash δεν έχει native EX για λίστες — κρατάμε μόνο expire σε message keys
    // και προαιρετικά σώζουμε ένα marker ώστε να μπορούμε να ελέγξουμε ύπαρξη
    await redis.set(`${key}:marker`, "1", { ex: INBOX_TTL });

    res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("create error:", e);
    res.status(500).json({ ok: false, error: "create_failed" });
  }
});

// GET /inbox/:local -> { ok, messages:[...] }
app.get("/inbox/:local", async (req, res) => {
  try {
    const local = (req.params.local || "").trim();
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const key = mailboxKeyFromLocal(local);
    const ids = (await redis.lrange(key, 0, 199)) || [];

    const messages = [];
    for (const id of ids) {
      const raw = await redis.get(messageKey(id));
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

    res.json({ ok: true, messages });
  } catch (e) {
    console.error("inbox error:", e);
    res.status(500).json({ ok: false, error: "inbox_failed" });
  }
});

// GET /message/:id -> full body
app.get("/message/:id", async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await redis.get(messageKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof raw === "string" ? JSON.parse(raw) : raw;
    res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      received_at: m.received_at || m.date || nowISO(),
      headers: m.headers || {},
    });
  } catch (e) {
    console.error("message error:", e);
    res.status(500).json({ ok: false, error: "message_failed" });
  }
});

/* ---- /api/* aliases (για συμβατότητα) ---- */
app.post("/api/create", async (req, res) => app._router.handle(req, res, () => {}, "/create"));
app.get("/api/inbox/:local", async (req, res) => app._router.handle(req, res, () => {}, `/inbox/${req.params.local}`));
app.get("/api/message/:id", async (req, res) => app._router.handle(req, res, () => {}, `/message/${req.params.id}`));

/* -------------------- DEV helper: push fake message -------------------- */
// GET /_test/push?to=a@temp-mail.gr&subject=Hi&text=Hello
if (process.env.DEV_MODE) {
  app.get("/_test/push", async (req, res) => {
    try {
      const to = String(req.query.to || "").toLowerCase();
      const subject = String(req.query.subject || "(no subject)");
      const text = String(req.query.text || "");
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(to)) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const local = to.split("@")[0];
      const id = Math.random().toString(36).slice(2);

      const msg = {
        id,
        from: "tester@example.com",
        to,
        subject,
        text,
        html: `<p>${text}</p>`,
        received_at: nowISO(),
      };

      await redis.set(messageKey(id), JSON.stringify(msg), { ex: MSG_TTL });
      await redis.lpush(mailboxKeyFromLocal(local), id);
      await redis.ltrim(mailboxKeyFromLocal(local), 0, 199);
      // ανανεώνουμε marker ώστε να «κρατάει» lifetime inbox
      await redis.set(`${mailboxKeyFromLocal(local)}:marker`, "1", { ex: INBOX_TTL });

      res.json({ ok: true, accepted: true, id, to });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "push_failed" });
    }
  });
}

/* -------------------- (Optional) Local SMTP sink -------------------- */
// Αν βάλεις ENABLE_SMTP=1, θα ακούει στο :2525 για δοκιμές.
if (process.env.ENABLE_SMTP === "1") {
  const SMTP_PORT = process.env.SMTP_PORT || 2525;
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH"],
    logger: false,
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then(async (mail) => {
          try {
            const to = (mail.to?.value?.[0]?.address || "").toLowerCase();
            if (!to) return callback();

            const local = to.split("@")[0];
            const id = Math.random().toString(36).slice(2);

            const msg = {
              id,
              from: mail.from?.text || "",
              to,
              subject: mail.subject || "",
              text: mail.text || "",
              html: mail.html || "",
              received_at: nowISO(),
              headers: Object.fromEntries(
                (mail.headerLines || []).map((h) => [h.key, h.line])
              ),
            };

            await redis.set(messageKey(id), JSON.stringify(msg), { ex: MSG_TTL });
            await redis.lpush(mailboxKeyFromLocal(local), id);
            await redis.ltrim(mailboxKeyFromLocal(local), 0, 199);
            await redis.set(`${mailboxKeyFromLocal(local)}:marker`, "1", { ex: INBOX_TTL });

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
}

/* -------------------- Start HTTP -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
