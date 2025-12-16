// server.js — FULL VERSION (deploy-safe, no trimming)

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { simpleParser } from "mailparser";
import { Redis as UpstashRedis } from "@upstash/redis";

/* -------------------- Upstash Redis -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

const rGet = (k) => redis.get(k);
const rSetEX = (k, v, ex) => redis.set(k, v, { ex });
const rLPush = (k, v) => redis.lpush(k, v);
const rLTrim = (k, s, e) => redis.ltrim(k, s, e);
const rLRange = (k, s, e) => redis.lrange(k, s, e);
const rExpire = (k, sec) => redis.expire(k, sec);
const rDel = (k) => redis.del(k);

/* -------------------- App -------------------- */
const app = express();
const WEB_PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* -------------------- Middleware -------------------- */
app.use(helmet());

app.use(
  cors({
    origin: (origin, cb) => {
      const allow = (process.env.FRONTEND_ORIGIN || "*")
        .split(",")
        .map((s) => s.trim());
      if (!origin || allow.includes("*") || allow.includes(origin)) {
        return cb(null, true);
      }
      cb(new Error("CORS blocked"));
    },
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      req.path === "/" ||
      req.path === "/healthz" ||
      req.path.startsWith("/_debug"),
  })
);

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 600);
const MSG_TTL = Number(process.env.MSG_TTL || 600);
const DOMAIN = process.env.DOMAIN || "temp-mail.gr";
const API_KEY = process.env.API_KEY || "";

const nowISO = () => new Date().toISOString();
const inboxKey = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;

/* -------------------- Store Message -------------------- */
async function storeMessage({
  id,
  to,
  from,
  subject,
  text,
  html,
  raw,
  headers,
  received_at,
}) {
  const msgId = id || Math.random().toString(36).slice(2);
  const toLc = (to || "").toLowerCase();
  const local = toLc.split("@")[0];

  const msg = {
    id: msgId,
    to: toLc,
    from: from || "",
    subject: subject || "",
    text: text || "",
    html: html || "",
    raw: raw || "",
    headers: headers || {},
    received_at: received_at || nowISO(),
  };

  await rSetEX(messageKey(msgId), JSON.stringify(msg), MSG_TTL);
  await rLPush(inboxKey(local), msgId);
  await rLTrim(inboxKey(local), 0, 199);
  await rExpire(inboxKey(local), INBOX_TTL);

  return msgId;
}

/* -------------------- Health / Debug -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.send("OK"));

app.get("/_debug/apikey", (_req, res) => {
  const k = API_KEY || "";
  res.json({
    hasKey: !!k,
    len: k.length,
    head: k.slice(0, 4),
    tail: k.slice(-4),
  });
});

/* -------------------- Core API -------------------- */
app.post("/create", async (_req, res) => {
  const local = Math.random().toString(36).slice(2, 10);
  const email = `${local}@${DOMAIN}`;

  await rDel(inboxKey(local));
  await rLPush(inboxKey(local), "__init__");
  await rLTrim(inboxKey(local), 1, -1);
  await rExpire(inboxKey(local), INBOX_TTL);

  res.json({ ok: true, email, local, expires_in: INBOX_TTL });
});

app.get("/inbox/:local", async (req, res) => {
  const ids = await rLRange(inboxKey(req.params.local), 0, 49);
  const messages = [];

  for (const id of ids) {
    if (id === "__init__") continue;
    const raw = await rGet(messageKey(id));
    if (!raw) continue;
    const m = JSON.parse(raw);
    messages.push({
      id: m.id,
      from: m.from,
      subject: m.subject,
      preview: (m.text || m.raw || "").slice(0, 160),
      received_at: m.received_at,
    });
  }

  res.json({ ok: true, messages });
});

app.get("/message/:id", async (req, res) => {
  const raw = await rGet(messageKey(req.params.id));
  if (!raw) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...JSON.parse(raw) });
});

/* -------------------- Incoming JSON -------------------- */
app.post("/incoming-email", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ ok: false });
  }

  const { to, from, subject, text, html } = req.body || {};
  if (!to || !from) return res.status(400).json({ ok: false });

  await storeMessage({ to, from, subject, text, html });
  res.json({ ok: true });
});

/* -------------------- RAW inbound -------------------- */
app.post(
  "/cloudflare/inbound",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const mail = await simpleParser(req.body);
    const to = mail.to?.value?.[0]?.address;
    if (!to) return res.status(400).json({ ok: false });

    await storeMessage({
      to,
      from: mail.from?.text,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      raw: req.body.toString("utf8"),
      headers: Object.fromEntries(
        mail.headerLines?.map((h) => [h.key, h.line]) || []
      ),
    });

    res.json({ ok: true });
  }
);

/* -------------------- PUSH -------------------- */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/push", upload.single("raw"), async (req, res) => {
  const sentKey = req.body.api_key || req.headers["x-api-key"];
  if (API_KEY && sentKey !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const to = (req.body.to || "").toLowerCase();
  if (!to.includes("@")) {
    return res.status(400).json({ ok: false, error: "invalid_to" });
  }

  const raw = req.file?.buffer?.toString("utf8") || "";

  await storeMessage({
    to,
    from: req.body.from,
    subject: req.body.subject,
    raw,
  });

  res.json({ ok: true });
});

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
