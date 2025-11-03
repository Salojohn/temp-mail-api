import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const useTls = redisUrl.startsWith("rediss://");

export const redis = new Redis(redisUrl, {
  ...(useTls ? { tls: {} } : {}),
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  reconnectOnError: (err) =>
    /READONLY|ECONNRESET|EPIPE|Connection is closed/i.test(err?.message || ""),
  enableReadyCheck: false,
  keepAlive: 10000,
  connectTimeout: 10000
});

let firstConnect = true;
let lastWarn = 0;
redis.on("connect", () => {
  if (firstConnect) {
    console.log("[redis] connected");
    firstConnect = false;
  }
});
redis.on("reconnecting", (ms) => {
  const now = Date.now();
  if (now - lastWarn > 60000) {
    console.warn(`[redis] reconnecting in ${ms}ms`);
    lastWarn = now;
  }
});
redis.on("end", () => console.warn("[redis] connection closed"));
redis.on("error", (e) => {
  const now = Date.now();
  if (now - lastWarn > 60000) {
    console.warn("[redis] transient issue:", e.code || e.message);
    lastWarn = now;
  }
});

// keep-alive για free plans
setInterval(() => {
  redis.ping().catch(() => {});
}, 20000);

// soft-guards
process.on("unhandledRejection", (e) =>
  console.warn("[sys] unhandledRejection:", e?.message || e)
);
process.on("uncaughtException", (e) =>
  console.warn("[sys] uncaughtException:", e?.message || e)
);
