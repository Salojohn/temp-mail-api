import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { simpleParser } from 'mailparser';
import { Redis } from '@upstash/redis';
import { v4 as uuid } from 'uuid';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- ENV ----
const {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  API_KEY = '',       // ίδιο με τον Worker
  DOMAIN = 'temp-mail.gr',
  INBOX_TTL = '600',  // sec
  MSG_TTL = '600'     // sec
} = process.env;

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ------------------------------
// util helpers
// ------------------------------
const inboxKey = (local) => `inbox:${local}`;
const msgKey   = (id)    => `msg:${id}`;
const attKey   = (id)    => `att:${id}`;

// ------------------------------
// PUSH (από Worker) – δέχεται raw MIME
// ------------------------------
app.post('/push', upload.single('raw'), async (req, res) => {
  try {
    if (!req.body?.api_key || req.body.api_key !== API_KEY) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: 'missing raw' });
    }

    const to = String(req.body.to || '').trim().toLowerCase();
    const from = String(req.body.from || '').trim();
    const subject = String(req.body.subject || '').trim();

    // Περιμένουμε to = "<local>@temp-mail.gr"
    const local = to.split('@')[0] || '';
    if (!local) return res.status(400).json({ ok: false, error: 'bad to' });

    // Parse MIME
    const parsed = await simpleParser(req.file.buffer);

    // Σώματα
    const body_plain = parsed.text || '';
    const body_html  = parsed.html ? (typeof parsed.html === 'string' ? parsed.html : parsed.html.toString()) : '';

    // Preview
    const preview = (parsed.text || '').slice(0, 160);

    // Headers (flatten)
    const headers = {};
    for (const [k, v] of parsed.headers) headers[k] = v;

    // Φτιάξε message object
    const id = uuid().replace(/-/g, '').slice(0, 10);
    const received_at = new Date().toISOString();

    const msg = {
      id,
      local,
      email: `${local}@${DOMAIN}`,
      from: parsed.from?.text || from || '',
      subject: parsed.subject || subject || '',
      preview,
      received_at,
      headers,
      body_plain,
      body_html,
      attachments: []
    };

    // Attachments: αποθηκεύουμε σε Redis ως base64 + meta
    if (Array.isArray(parsed.attachments) && parsed.attachments.length) {
      for (const a of parsed.attachments) {
        const attId = uuid().replace(/-/g, '').slice(0, 12);
        const meta = {
          id: attId,
          filename: a.filename || 'file',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content?.length || 0)
        };
        msg.attachments.push(meta);
        // σώζουμε το περιεχόμενο ξεχωριστά (base64)
        const b64 = a.content ? Buffer.from(a.content).toString('base64') : '';
        await redis.set(attKey(attId), { b64, meta }, { ex: Number(MSG_TTL) });
      }
    }

    // 1) σώζουμε το full message
    await redis.set(msgKey(id), msg, { ex: Number(MSG_TTL) });

    // 2) index στο inbox (λίστα με ids πιο πρόσφατα μπροστά)
    await redis.lpush(inboxKey(local), id);
    await redis.expire(inboxKey(local), Number(INBOX_TTL));

    return res.json({ ok: true, id });
  } catch (e) {
    console.error('push error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ------------------------------
// LIST inbox (το έχεις ήδη – δείχνω μία καθαρή εκδοχή)
// GET /inbox/:local
// ------------------------------
app.get('/inbox/:local', async (req, res) => {
  try {
    const local = req.params.local.toLowerCase();
    const ids = await redis.lrange(inboxKey(local), 0, 49);
    const items = [];
    for (const id of ids) {
      const m = await redis.get(msgKey(id));
      if (m) {
        items.push({
          id: m.id,
          from: m.from,
          subject: m.subject,
          preview: m.preview,
          received_at: m.received_at
        });
      }
    }
    res.json({ ok: true, messages: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ------------------------------
// FULL message
// GET /message/:id
// ------------------------------
app.get('/message/:id', async (req, res) => {
  try {
    const m = await redis.get(msgKey(req.params.id));
    if (!m) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({
      ok: true,
      id: m.id,
      from: m.from,
      subject: m.subject,
      received_at: m.received_at,
      headers: m.headers,
      body_plain: m.body_plain,
      body_html: m.body_html,
      attachments: m.attachments || []
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ------------------------------
// Attachment download
// GET /attachment/:attId  -> binary
// ------------------------------
app.get('/attachment/:attId', async (req, res) => {
  try {
    const obj = await redis.get(attKey(req.params.attId));
    if (!obj || !obj.b64 || !obj.meta) return res.status(404).send('Not found');

    const buf = Buffer.from(obj.b64, 'base64');
    res.setHeader('Content-Type', obj.meta.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${obj.meta.filename || 'file'}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).send('error');
  }
});

// ------------------------------
// CREATE (παραμένει όπως το έχεις – δείγμα)
app.post('/create', async (_req, res) => {
  const local = Math.random().toString(36).slice(2, 10);
  const email = `${local}@${DOMAIN}`;
  const expires_in = Number(INBOX_TTL);
  res.json({ ok: true, local, email, expires_in });
});
// ------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API listening on', PORT));
