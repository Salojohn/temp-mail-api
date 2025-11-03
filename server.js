// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { redis } from "./redisClient.js"; // ✅ Χρησιμοποιούμε τον singleton client

/* ------------ ENV ------------ */
const WEB_PORT   = process.env.PORT || 3000;
const SMTP_PORT  = process.env.SMTP_PORT || 2525;
const DEV_MODE   = process.env.DEV_MODE === "1" || process.env.NODE_ENV === "development";
const INBOX_TTL  = Number(process.env.INBOX_TTL || 600); // seconds
const MSG_TTL    = Number(process.env.MSG_TTL   || 600); // seconds
const DOMAIN     = process.env.DOMAIN || "temp-mail.local";

/* ------------ Express app ------------ */
const app = express();
app.disable("x-powered-by");

/* ✅ Απαραίτητο στο Render (proxy in front) */
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip, // σωστό πίσω από proxy
  })
);

/* ------------ helpers ------------ */
const mailboxKey = (addr) => `mailbox:${addr.toLowerCase()}`;

/** Αποθήκευση μηνύματος σε Redis */
async function storeMessage({ to, from, subject, text, html, headers }) {
  const id  = Date.now().toString(36);
  const key = mailboxKey(to);

  const record = {
    id,
    to,
    from: from || "",
    subject: subject || "",
    date: new Date().toISOString(),
    text: text || "",
    html: html || "",
    headers: headers || {},
  };

  // LPUSH για λίστα, κράτα έως 200, και βάλε TTL
  await redis.lpush(key, JSON.stringify(record));
  await redis.ltrim(key, 0, 199);
  await redis.expire(key, INBOX_TTL);

  // αποθήκευση και σε per-message key αν θες ξεχωριστό TTL
  await redis.setex(`msg:${id}`, MSG_TTL, JSON.stringify(record));

  return id;
}

/* ------------ Routes ------------ */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/_debug/ping", (_req, res) =>
  res.json({ ok: true, t: Date.now(), dev: DEV_MODE, domain: DOMAIN })
);

// Επιστροφή inbox
app.get("/messages/:mailbox", async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.mailbox).toLowerCase();
    const key  = mailboxKey(addr);
    const raw  = await redis.lrange(key, 0, 49);
    const items = raw.map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    res.json({ mailbox: addr, count: items.length, items });
  } catch (err) {
    console.error("[/messages] error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/* ------------ DEV test endpoints ------------ */
if (DEV_MODE) {
  // GET: /_test/push?to=a@b.com&subject=Hi&text=Hello
  app.get("/_test/push", async (req, res) => {
    try {
      const to      = (req.query.to || "").toString().toLowerCase();
      const subject = (req.query.subject || "").toString();
      const text    = (req.query.text || "").toString();

      if (!to || !to.includes("@")) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const id = await storeMessage({
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        headers: { "x-dev": "true" },
      });

      res.json({ ok: true, accepted: true, id, to });
    } catch (err) {
      console.error("[_test/push] error:", err);
      res.status(500).json({ ok: false, error: "push failed" });
    }
  });

  // POST: /_test/push  { to, subject, text }
  app.post("/_test/push", async (req, res) => {
    try {
      const to      = (req.body.to || "").toString().toLowerCase();
      const subject = (req.body.subject || "").toString();
      const text    = (req.body.text || "").toString();

      if (!to || !to.includes("@")) {
        return res.status(400).json({ ok: false, error: "Invalid 'to' address" });
      }

      const id = await storeMessage({
        to,
        from: `tester@${DOMAIN}`,
        subject,
        text,
        html: "",
        headers: { "x-dev": "true" },
      });

      res.json({ ok: true, accepted: true, id, to });
    } catch (err) {
      console.error("[_test/push POST] error:", err);
      res.status(500).json({ ok: false, error: "push failed" });
    }
  });
}

/* ------------ SMTP server (για πραγματικά emails) ------------ */
const smtp = new SMTPServer({
  disabledCommands: ["AUTH"], // demo, no auth
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async (mail) => {
        try {
          const toAddr = (mail.to?.value?.[0]?.address || "").toLowerCase();
          if (!toAddr) throw new Error("No recipient");

          const headersObj =
            Object.fromEntries(
              (mail.headerLines || []).map((h) => [h.key, h.line])
            ) || {};

          await storeMessage({
            to: toAddr,
            from: mail.from?.text || "",
            subject: mail.subject || "",
            text: mail.text || "",
            html: mail.html || "",
            headers: headersObj,
          });

          console.log(`[smtp] stored message for ${toAddr}`);
          callback(); // ok
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
