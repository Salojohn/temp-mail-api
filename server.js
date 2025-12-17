// server.js (deploy-safe, full)
// Node/ESM (imports). Requires package.json: { "type": "module" }

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { simpleParser } from "mailparser";
import { Redis as UpstashRedis } from "@upstash/redis";

/* -------------------- Upstash Redis (REST) -------------------- */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.error("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

const redis = new UpstashRedis({ url: redisUrl, token: redisToken });

const rGet = async (k) => await redis.get(k);
const rSetEX = async (k, v, ex) => await redis.set(k, v, { ex });
const rLPush = async (k, v) => await redis.lpush(k, v);
const rLTrim = async (k, s, e) => await redis.ltrim(k, s, e);
const rLRange = async (k, s, e) => await redis.lrange(k, s, e);
const rExpire = async (k, sec) => await redis.expire(k, sec);
const rDel = async (k) => await redis.del(k);

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
        .map((s) => s.trim())
        .filter(Boolean);

      if (!origin || allow.includes("*") || allow.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked for origin: " + origin));
    },
  })
);

// JSON + urlencoded
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/" || req.path === "/healthz" || req.path.startsWith("/_debug"),
  })
);

/* -------------------- Helpers -------------------- */
const INBOX_TTL = Number(process.env.INBOX_TTL || 3600); // ✅ προτείνω 1h
const MSG_TTL = Number(process.env.MSG_TTL || 3600);     // ✅ προτείνω 1h
const DOMAIN = process.env.DOMAIN || "temp-mail.gr";
const API_KEY = (process.env.API_KEY || "").trim();

// attachments (MVP: small-only in Redis)
const MAX_ATTACH_BYTES = Number(process.env.MAX_ATTACH_BYTES || 2 * 1024 * 1024); // 2MB
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE || "https://api.temp-mail.gr").trim();

const nowISO = () => new Date().toISOString();
const mailboxKeyFromLocal = (local) => `inbox:${local}`;
const messageKey = (id) => `msg:${id}`;
const attachKey = (msgId, idx) => `att:${msgId}:${idx}`;

async function storeAttachments(msgId, attachments = []) {
  const out = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i] || {};
    const size = a.size || (a.content?.length || 0);

    const meta = {
      idx: i,
      filename: a.filename || `attachment-${i}`,
      contentType: a.contentType || "application/octet-stream",
      size,
      disposition: a.contentDisposition || "attachment", // attachment | inline
      cid: a.cid || null,
      stored: "none", // redis | skipped
    };

    if (a.content && size > 0 && size <= MAX_ATTACH_BYTES) {
      const b64 = Buffer.from(a.content).toString("base64");
      await rSetEX(attachKey(msgId, i), b64, MSG_TTL);
      meta.stored = "redis";
    } else {
      meta.stored = "skipped"; // later: store in R2/S3
    }

    out.push(meta);
  }
  return out;
}

// Replace cid: references in HTML to /attachment/:id/:idx
function resolveCidHtml(html, msgId, atts = [], baseUrl = "") {
  if (!html) return "";
  let out = String(html);
  const prefix = baseUrl ? baseUrl.replace(/\/+$/, "") : "";

  for (const a of atts || []) {
    if (!a?.cid) continue;
    const cid = String(a.cid).replace(/[<>]/g, "");
    out = out.replaceAll(
      `cid:${cid}`,
      `${prefix}/attachment/${encodeURIComponent(msgId)}/${a.idx}`
    );
  }
  return out;
}

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
  attachments,
}) {
  const msgId = (id || Math.random().toString(36).slice(2)).toString();
  const toLc = (to || "").toLowerCase().trim();
  const local = toLc.split("@")[0];

  const msg = {
    id: msgId,
    to: toLc,
    from: (from || "").toString(),
    subject: (subject || "").toString(),
    text: (text || "").toString(),
    html: (html || "").toString(),
    raw: (raw || "").toString(),
    headers: headers || {},
    received_at: received_at || nowISO(),
    attachments: [],
  };

  msg.attachments = await storeAttachments(msgId, attachments || []);
  msg.html = resolveCidHtml(msg.html, msgId, msg.attachments, PUBLIC_API_BASE);

  await rSetEX(messageKey(msgId), JSON.stringify(msg), MSG_TTL);

  const mbox = mailboxKeyFromLocal(local);
  await rLPush(mbox, msgId);
  await rLTrim(mbox, 0, 199);
  await rExpire(mbox, INBOX_TTL);

  return { msgId, local };
}

/* -------------------- Health / Debug -------------------- */
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

app.get("/_debug/msg/:id", async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const raw = await rGet(messageKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof raw === "string" ? JSON.parse(raw) : raw;
    res.json({
      ok: true,
      id: m.id,
      to: m.to,
      subject: m.subject,
      has_raw: !!m.raw,
      raw_len: (m.raw || "").length,
      attachments: (m.attachments || []).map((a) => ({
        idx: a.idx,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        disposition: a.disposition,
        cid: a.cid,
        stored: a.stored,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------------------- Core API -------------------- */
async function handleCreate(_req, res) {
  const local = Math.random().toString(36).slice(2, 10);
  const email = `${local}@${DOMAIN}`;
  const key = mailboxKeyFromLocal(local);

  try {
    await rDel(key);
    await rLPush(key, "__init__");
    await rLTrim(key, 1, -1);
    await rExpire(key, INBOX_TTL);

    return res.json({ ok: true, email, local, expires_in: INBOX_TTL });
  } catch (e) {
    console.error("[create] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "create_failed" });
  }
}

async function handleInbox(req, res) {
  try {
    const local = (req.params.local || "").trim();
    if (!local) return res.status(400).json({ ok: false, error: "missing_local" });

    const ids = await rLRange(mailboxKeyFromLocal(local), 0, 49);
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
        preview: (m.text || m.raw || "").slice(0, 160),
        received_at: m.received_at || nowISO(),
      });
    }

    return res.json({ ok: true, messages });
  } catch (e) {
    console.error("[inbox] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "inbox_failed" });
  }
}

async function handleMessage(req, res) {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const raw = await rGet(messageKey(id));
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof raw === "string" ? JSON.parse(raw) : raw;

    return res.json({
      ok: true,
      id: m.id,
      from: m.from || "",
      to: m.to || "",
      subject: m.subject || "",
      body_plain: m.text || "",
      body_html: m.html || "",
      raw: m.raw || "",
      received_at: m.received_at || nowISO(),
      headers: m.headers || {},
      attachments: m.attachments || [],
    });
  } catch (e) {
    console.error("[message] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "message_failed" });
  }
}

/* -------------------- Attachment download -------------------- */
async function handleAttachment(req, res) {
  try {
    const id = (req.params.id || "").trim();
    const idx = Number(req.params.idx);

    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    if (!Number.isFinite(idx) || idx < 0)
      return res.status(400).json({ ok: false, error: "invalid_idx" });

    const rawMsg = await rGet(messageKey(id));
    if (!rawMsg) return res.status(404).json({ ok: false, error: "not_found" });

    const m = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
    const meta = (m.attachments || []).find((x) => Number(x.idx) === idx);
    if (!meta) return res.status(404).json({ ok: false, error: "attachment_not_found" });

    if (meta.stored !== "redis") {
      return res.status(413).json({ ok: false, error: "attachment_not_stored_here" });
    }

    const b64 = await rGet(attachKey(id, idx));
    if (!b64) return res.status(404).json({ ok: false, error: "attachment_data_missing" });

    const buf = Buffer.from(String(b64), "base64");

    res.setHeader("Content-Type", meta.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(buf.length));

    const safeName = (meta.filename || "file").replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    return res.send(buf);
  } catch (e) {
    console.error("[attachment] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "attachment_failed" });
  }
}

app.post("/create", handleCreate);
app.get("/inbox/:local", handleInbox);
app.get("/message/:id", handleMessage);
app.get("/attachment/:id/:idx", handleAttachment);

// /api aliases
app.post("/api/create", handleCreate);
app.get("/api/inbox/:local", handleInbox);
app.get("/api/message/:id", handleMessage);
app.get("/api/attachment/:id/:idx", handleAttachment);

/* -------------------- Incoming RAW email (from Worker) -------------------- */
app.post(
  "/cloudflare/inbound",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    try {
      // ✅ optional auth
      if (API_KEY) {
        const sent = (req.headers["x-api-key"] || "").toString().trim();
        if (!sent || sent !== API_KEY) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
      }

      const mail = await simpleParser(req.body);

      const to = (mail.to?.value?.[0]?.address || "").toLowerCase();
      if (!to.includes("@")) return res.status(400).json({ ok: false, error: "missing_to" });

      await storeMessage({
        to,
        from: mail.from?.text || "",
        subject: mail.subject || "",
        text: mail.text || "",
        html: mail.html || "",
        raw: req.body.toString("utf8"),
        headers: Object.fromEntries(mail.headerLines?.map((h) => [h.key, h.line]) || []),
        received_at: nowISO(),
        attachments: mail.attachments || [],
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error("[cloudflare/inbound] error:", e);
      return res.status(500).json({ ok: false, error: e.message || "inbound_failed" });
    }
  }
);

/* -------------------- Start -------------------- */
app.listen(WEB_PORT, () => {
  console.log(`[http] listening on :${WEB_PORT}`);
});
