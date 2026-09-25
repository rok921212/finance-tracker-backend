process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.REDIS_URL = "";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const express = require("express");
const request = require("supertest");
const cache = require("../services/cache.js");

/** A stand-in for Redis: backed by a memory store, with switches to fail, hang or lose the lock. */
const makeFakeRedis = () => {
  const m = cache._createMemoryStore();
  const f = { kind: "fake", calls: {}, fail: {}, hang: {}, pttl: 3600e3, lockFree: true };
  const wrap = (name, fn) => async (...args) => {
    f.calls[name] = (f.calls[name] || 0) + 1;
    if (f.hang[name]) return new Promise(() => {});
    if (f.fail[name]) throw new Error(`${name} down`);
    return fn(...args);
  };
  Object.assign(f, {
    getWithTtl: wrap("getWithTtl", async (k) => ({ value: await m.get(k), pttl: f.pttl })),
    set: wrap("set", async (k, v, ttl) => {
      f.lastSet = v;
      return m.set(k, v, ttl);
    }),
    expire: wrap("expire", async () => 1),
    getVersions: wrap("getVersions", m.getVersions),
    bump: wrap("bump", m.bump),
    lock: wrap("lock", async (k) => {
      f.lastLock = k;
      return f.lockFree;
    }),
    unlock: wrap("unlock", async () => 1),
    raw: m,
  });
  return f;
};

// A tiny app: GET /data is cached on dep "d"; each computation returns a new number
let computed = 0;
let payload = () => ({ n: ++computed });
const app = express();
app.get("/data", async (req, res, next) => {
  try {
    await cache.sendCached(req, res, { name: "data", deps: ["d"] }, async () => payload());
  } catch (e) {
    next(e);
  }
});

let fake;
beforeEach(() => {
  computed = 0;
  payload = () => ({ n: ++computed });
  fake = makeFakeRedis();
  cache._setPrimaryForTests(fake);
});
afterAll(() => cache._setPrimaryForTests(null));

test("missing counters are seeded with the current time, so a reset never reuses a version", async () => {
  const before = Date.now();
  const m = cache._createMemoryStore();
  const [v] = await m.getVersions(["v:fresh"]);
  expect(v).toBeGreaterThanOrEqual(before);
  const [bumped] = await m.bump(["v:fresh"]);
  expect(bumped).toBe(v + 1);
  const [other] = await m.bump(["v:never-read"]);
  expect(other).toBeGreaterThan(before);
});

test("serves from the (fake) Redis store and reports the versions in a header", async () => {
  const a = await request(app).get("/data");
  const b = await request(app).get("/data");
  expect(a.body).toEqual({ n: 1 });
  expect(b.body).toEqual({ n: 1 });
  expect(b.headers["x-cache"]).toBe("HIT");
  expect(a.headers["x-cache"]).toBe("MISS");
  expect(a.headers["x-cache-versions"]).toMatch(/^d=\d+$/);
  expect(fake.calls.set).toBe(1);
});

test("a bump that misses Redis switches to memory until it is replayed; Redis never serves the stale body", async () => {
  expect((await request(app).get("/data")).body).toEqual({ n: 1 }); // cached in Redis

  fake.fail.bump = true;
  await cache.bump("d");
  expect(cache.cacheStats()).toMatchObject({ usingRedis: false, unsyncedInvalidations: 1 });
  // Redis still holds n=1 under the old version: it must not be served
  expect((await request(app).get("/data")).body).toEqual({ n: 2 });

  // Replay still failing: stays on memory
  await cache._replay();
  expect(cache.cacheStats().usingRedis).toBe(false);

  fake.fail.bump = false;
  await cache._replay();
  expect(cache.cacheStats()).toMatchObject({ usingRedis: true, unsyncedInvalidations: 0 });
  // Back on Redis with the counter moved: a fresh body, not the old n=1
  expect((await request(app).get("/data")).body).toEqual({ n: 3 });
});

test("a hanging Redis times out, opens the circuit and requests still succeed from memory", async () => {
  fake.hang.getVersions = true;
  const opensBefore = cache.cacheStats().circuitOpens;
  const started = Date.now();
  const res = await request(app).get("/data");
  expect(res.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(cache.cacheStats().circuitOpens).toBe(opensBefore + 1);

  // While the circuit is open, Redis is not tried at all
  const calls = fake.calls.getVersions;
  expect((await request(app).get("/data")).status).toBe(200);
  expect(fake.calls.getVersions).toBe(calls);
});

test("large bodies are stored gzipped and sent pre-compressed; identity clients get plain JSON", async () => {
  payload = () => ({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const gz = await request(app).get("/data").set("Accept-Encoding", "gzip");
  expect(gz.headers["content-encoding"]).toBe("gzip");
  expect(gz.body.items).toHaveLength(200);
  expect(gz.headers.vary).toMatch(/Accept-Encoding/);

  const plain = await request(app).get("/data").set("Accept-Encoding", "identity");
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.body.items).toHaveLength(200);
  expect(plain.headers.etag).toBe(gz.headers.etag);

  // Stored in Redis as gzipped base64, not as the raw JSON
  expect(typeof fake.lastSet.gz).toBe("string");
  expect(fake.lastSet.body).toBeUndefined();
});

test("when another instance holds the compute lock, this one waits for its result instead of computing", async () => {
  fake.lockFree = false;
  const waitingBefore = cache.cacheStats().lockWaitHits;
  const pending = request(app).get("/data").then((r) => r);
  // The other instance finishes computing and stores the body
  while (!fake.lastLock) await new Promise((r) => setTimeout(r, 10));
  await fake.raw.set(fake.lastLock.slice("lock:".length), { etag: '"other"', body: JSON.stringify({ n: "other" }) }, 60);
  const res = await pending;
  expect(res.body).toEqual({ n: "other" });
  expect(computed).toBe(0);
  expect(cache.cacheStats().lockWaitHits).toBe(waitingBefore + 1);
});

test("if the lock holder never delivers, the waiter computes by itself after a short wait", async () => {
  fake.lockFree = false;
  const res = await request(app).get("/data");
  expect(res.body).toEqual({ n: 1 });
});

test("hot entries past half their lifetime get their TTL extended", async () => {
  await request(app).get("/data");
  fake.pttl = 10 * 1000; // far below half of the 1h default
  cache._setPrimaryForTests(fake); // the in-process L1 copy expired: this read goes to Redis
  await request(app).get("/data");
  // Fire-and-forget: give it a tick
  await new Promise((r) => setTimeout(r, 10));
  expect(fake.calls.expire).toBe(1);
  expect(cache.cacheStats().slidingRefreshes).toBeGreaterThan(0);
});
