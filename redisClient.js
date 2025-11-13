// redisClients.js
import { Redis as UpstashRedis } from "@upstash/redis";

const redisUrl   = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!redisUrl || !redisToken) {
  console.warn("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

export const redis = new UpstashRedis({
  url: redisUrl,
  token: redisToken,
});

// Helper wrappers ώστε να έχεις ένα consistent API παντού
export const rGet    = async (k)          => await redis.get(k);
export const rSetEX  = async (k, v, ex)   => await redis.set(k, v, { ex });
export const rLPush  = async (k, v)       => await redis.lpush(k, v);
export const rLTrim  = async (k, start, end) => await redis.ltrim(k, start, end);
export const rLRange = async (k, start, end) => await redis.lrange(k, start, end);
export const rExpire = async (k, sec)     => await redis.expire(k, sec);
export const rDel    = async (k)          => await redis.del(k);

// Μικρό self-test (προαιρετικό, αλλά χρήσιμο για debug)
export async function redisSelfTest() {
  try {
    const key = `selftest:${Date.now()}`;
    await rSetEX(key, JSON.stringify({ ok: true }), 30);
    const v = await rGet(key);
    console.log("[redis selftest] OK:", v);
  } catch (e) {
    console.error("[redis selftest] FAILED:", e);
  }
}
