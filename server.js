import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import Redis from "ioredis";
import crypto from "crypto";

const DOMAIN = (process.env.DOMAIN || "localhost").toLowerCase();
const MSG_TTL = parseInt(process.env.MSG_TTL || "600", 10);
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

function isOurDomain(address) {
    if (!address) return false;
    const [, domain] = String(address).toLowerCase().split("@");
    return domain === DOMAIN;
}

async function inboxExists(local) {
    return !!(await redis.get(`inbox:${local}`));
}

const server = new SMTPServer({
    disabledCommands: ["AUTH"], // μόνο εισερχόμενα
    logger: false,
    onRcptTo(address, session, callback) {
        if (!isOurDomain(address.address)) {
            return callback(new Error("550 Relaying denied"));
        }
        callback(); // OK
    },
    async onData(stream, session, callback) {
        try {
            const parsed = await simpleParser(stream);

            // valid recipient του domain μας
            const rcpt = (session.envelope.rcptTo || [])
                .map(r => r.address)
                .find(isOurDomain);
            if (!rcpt) return callback(new Error("550 No valid recipient"));

            const local = rcpt.split("@")[0]?.replace(/[^a-z0-9]/gi, "").toLowerCase();
            if (!local || !(await inboxExists(local))) {
                // drop ήρεμα για άγνωστα/ληγμένα inboxes
                return callback();
            }

            const id = crypto.randomBytes(8).toString("hex");
            const msg = {
                id,
                from: parsed.from?.text || session.envelope.mailFrom?.address || "",
                to: rcpt,
                subject: parsed.subject || "(no subject)",
                body_plain: parsed.text || "",
                body_html: parsed.html || "",
                attachments: (parsed.attachments || []).map(a => ({
                    filename: a.filename, contentType: a.contentType, size: a.size
                })),
                received_at: Date.now()
            };

            await redis.set(`msg:${id}`, JSON.stringify(msg), "EX", MSG_TTL);
            await redis.lpush(`msgs:${local}`, id);
            await redis.expire(`msgs:${local}`, MSG_TTL);

            callback(); // 250 OK
        } catch (e) {
            console.error("SMTP onData error:", e);
            callback(new Error("451 Temporary error"));
        }
    },
    size: 10 * 1024 * 1024 // 10MB όριο
});

server.listen(25, () => {
    console.log(`SMTP server for ${DOMAIN} listening on :25`);
});
