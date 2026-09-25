const crypto = require("crypto");
const zlib = require("zlib");
const env = require("../config/env.js");
const { hub } = require("./events.js");

/**
 * Response cache with version-counter invalidation.
 *
 * Every cached response depends on one or more "versions" (e.g. `payments`, `payments:u:<id>`).
 * The version numbers are part of the cache key, so a write only has to INCR a counter —
 * no key scanning or SMEMBERS/DEL fan-out — and a stale entry can never be served after a
 * write (old keys simply stop being read). Because of that, TTLs only bound memory use and can
 * be long: an entry is valid for as long as its data is unchanged.
 *
 * Backends, in order of preference:
 *   REDIS_URL                                      -> ioredis (TCP; e.g. Render Key Value)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN -> @upstash/redis (same as production app)
 *   neither                                        -> bounded in-process memory store
 *
 * Hardening:
 * - Counters are seeded with the current time when missing, so an evicted/flushed counter (or a
 *   restarted memory-mode process) always jumps forward and never reuses an old version.
 *   Recommended Redis policy: `volatile-lru` (cache bodies have a TTL and are evictable; the
 *   counters have none and are kept).
 * - Every Redis call has a timeout. A failing Redis opens a short circuit (reads use the memory
 *   store) instead of every request waiting on it.
 * - A bump that cannot reach Redis is remembered and replayed; until it lands, versions and bodies
 *   come from memory, so Redis can never serve a body the missed bump should have invalidated.
 * - Bodies are stored gzipped and sent as-is to clients that accept gzip (no per-request gzip).
 * - Concurrent misses compute once: per process (in-flight map) and across instances (short lock).
 * - Hot entries have their TTL extended when read past half-life, so they don't expire together.
 */

const MEMORY_MAX_ENTRIES = 1000;
// In-process copy of hot Redis entries (see sendCached)
const L1_MAX_ENTRIES = 200;
// Kept short so a hot entry is re-read from Redis now and then, which extends its Redis TTL
const L1_TTL = 5 * 60;
const DEFAULT_TTL = 60 * 60; // 1h; entries can't go stale (versioned keys), TTL only caps memory
const MAX_TTL = 24 * 60 * 60;
const OP_TIMEOUT_MS = 750;
const CIRCUIT_OPEN_MS = 5000;
const REPLAY_EVERY_MS = 5000;
const GZIP_MIN_BYTES = 1024;
const LOCK_MS = 5000; // a computing instance holds the key's lock at most this long
const LOCK_WAIT_MS = 1500; // others wait this long for its result, then compute themselves
const LOCK_POLL_MS = 100;
// Part of every cache key: bump when any cached response changes shape or meaning (or the stored
// format changes), so a deploy never serves bodies written by older code (even from a shared Redis).
const CACHE_SCHEMA = 7;

// A missing counter starts from the current time: always above any value it could have had before
const seed = () => Date.now();

const stats = {
  hitsL1: 0,
  hitsStore: 0,
  misses: 0,
  lockWaitHits: 0,
  fallbacks: 0,
  circuitOpens: 0,
  bumpFailures: 0,
  replays: 0,
  slidingRefreshes: 0,
};

let lastWarn = 0;
const warn = (msg) => {
  if (env.isTest) return;
  if (Date.now() - lastWarn > 60000) {
    lastWarn = Date.now();
    console.warn("[cache] " + msg);
  }
};

// ---- Stored entry format --------------------------------------------------------
// In process: { etag, body?: string, gz?: Buffer }. In Redis (JSON): { etag, body? } or { etag, gz: base64 }.
const encode = (entry) => (entry.gz ? { etag: entry.etag, gz: entry.gz.toString("base64") } : entry);
const decode = (stored) => {
  if (!stored) return null;
  if (typeof stored.gz === "string") return { etag: stored.etag, gz: Buffer.from(stored.gz, "base64") };
  return stored;
};

// ---- Stores -----------------------------------------------------------------------

const createMemoryStore = (maxEntries = MEMORY_MAX_ENTRIES) => {
  const data = new Map(); // key -> { v, exp }
  const versions = new Map(); // version counters never expire
  const live = (key) => {
    const e = data.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      data.delete(key);
      return null;
    }
    return e.v;
  };
  const current = (k) => {
    if (!versions.has(k)) versions.set(k, seed());
    return versions.get(k);
  };
  return {
    kind: "memory",
    get: async (key) => live(key),
    set: async (key, value, ttl) => {
      if (data.size >= maxEntries) data.delete(data.keys().next().value); // evict oldest
      data.set(key, { v: value, exp: Date.now() + ttl * 1000 });
    },
    getVersions: async (keys) => keys.map(current),
    // Returns the new counter values, in key order
    bump: async (keys) =>
      keys.map((k) => {
        const v = current(k) + 1;
        versions.set(k, v);
        return v;
      }),
    lock: async () => true,
    unlock: async () => {},
    clear: async () => {
      data.clear();
      versions.clear();
    },
  };
};

const createIoRedisStore = (url) => {
  const Redis = require("ioredis");
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
    commandTimeout: OP_TIMEOUT_MS,
  });
  client.on("error", (e) => warn("Redis error: " + e.message));
  const run = async (p) => {
    const results = await p.exec();
    const failed = (results || []).find(([err]) => err);
    if (!results || failed) throw failed ? failed[0] : new Error("pipeline failed");
    return results.map(([, v]) => v);
  };
  return {
    kind: "redis",
    // One round-trip: the body and its remaining lifetime (for sliding expiry)
    getWithTtl: async (key) => {
      const [s, pttl] = await run(client.pipeline().get(key).pttl(key));
      return { value: s ? JSON.parse(s) : null, pttl: Number(pttl) };
    },
    set: async (key, value, ttl) => {
      await client.set(key, JSON.stringify(value), "EX", ttl);
    },
    expire: async (key, ttl) => client.expire(key, ttl),
    getVersions: async (keys) => {
      const values = await client.mget(keys);
      const missing = keys.filter((_, i) => values[i] == null);
      if (!missing.length) return values.map(Number);
      const p = client.pipeline();
      missing.forEach((k) => p.set(k, seed(), "NX"));
      await run(p);
      return (await client.mget(keys)).map(Number);
    },
    bump: async (keys) => {
      const p = client.pipeline();
      keys.forEach((k) => p.set(k, seed(), "NX").incr(k));
      return (await run(p)).filter((_, i) => i % 2 === 1).map(Number);
    },
    lock: async (key, ms) => (await client.set(key, "1", "PX", ms, "NX")) === "OK",
    unlock: async (key) => client.del(key),
    clear: async () => {},
  };
};

const createUpstashStore = (url, token) => {
  const { Redis } = require("@upstash/redis");
  const client = new Redis({ url, token, retry: { retries: 1, backoff: () => 50 } });
  return {
    kind: "upstash",
    // One REST round-trip: the body (auto JSON-deserialized) and its remaining lifetime
    getWithTtl: async (key) => {
      const [value, pttl] = await client.pipeline().get(key).pttl(key).exec();
      return { value: value ?? null, pttl: Number(pttl) };
    },
    set: async (key, value, ttl) => {
      await client.set(key, value, { ex: ttl });
    },
    expire: async (key, ttl) => client.expire(key, ttl),
    getVersions: async (keys) => {
      const values = await client.mget(...keys);
      const missing = keys.filter((_, i) => values[i] == null);
      if (!missing.length) return values.map(Number);
      const p = client.pipeline();
      missing.forEach((k) => p.set(k, seed(), { nx: true }));
      await p.exec();
      return (await client.mget(...keys)).map(Number);
    },
    bump: async (keys) => {
      // One REST round-trip for all counters
      const p = client.pipeline();
      keys.forEach((k) => p.set(k, seed(), { nx: true }).incr(k));
      return (await p.exec()).filter((_, i) => i % 2 === 1).map(Number);
    },
    lock: async (key, ms) => (await client.set(key, "1", { nx: true, px: ms })) === "OK",
    unlock: async (key) => client.del(key),
    clear: async () => {},
  };
};

const memory = createMemoryStore();
let primary = env.REDIS_URL
  ? createIoRedisStore(env.REDIS_URL)
  : env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? createUpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
    : memory;

if (!env.isTest) console.log(`[cache] using ${primary.kind} store`);

// ---- Resilience: timeouts, circuit breaker, replay of missed bumps -------------------------

const withTimeout = (promise, ms = OP_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

let circuitOpenUntil = 0;
const openCircuit = (op, e) => {
  if (Date.now() >= circuitOpenUntil) stats.circuitOpens += 1;
  circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  warn(`${op} failed, using memory for ${CIRCUIT_OPEN_MS / 1000}s: ${e.message}`);
};

// Counter keys whose bump never reached Redis. While any exist, Redis may hold bodies those bumps
// should have invalidated, so everything is served from memory until the replay succeeds.
const unsynced = new Set();
let replayTimer = null;

const redisUsable = () => primary !== memory && !unsynced.size && Date.now() >= circuitOpenUntil;

const replay = async () => {
  const keys = [...unsynced];
  try {
    const values = await withTimeout(primary.bump(keys));
    keys.forEach((k) => unsynced.delete(k));
    stats.replays += 1;
    warn(`replayed ${keys.length} missed invalidation(s); back on ${primary.kind}`);
    // Tell open streams: these deps moved (and are read from Redis again from now on)
    hub.emit("bump", Object.fromEntries(keys.map((k, i) => [k.replace(/^v:/, ""), values[i]])));
  } catch (e) {
    warn(`replay failed, still serving from memory: ${e.message}`);
  }
  if (!unsynced.size && replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
};

const scheduleReplay = (keys) => {
  keys.forEach((k) => unsynced.add(k));
  if (!replayTimer) {
    replayTimer = setInterval(replay, REPLAY_EVERY_MS);
    replayTimer.unref();
  }
};

// Run a read-side operation against Redis, falling back to memory (and opening the circuit)
const viaRedis = async (op, redisCall, memoryCall) => {
  if (!redisUsable()) return memoryCall();
  try {
    return await withTimeout(redisCall());
  } catch (e) {
    stats.fallbacks += 1;
    openCircuit(op, e);
    return memoryCall();
  }
};

const store = {
  /** Entry for a key; extends a hot Redis entry's TTL once it is past half its lifetime. */
  get: (key, ttl) =>
    viaRedis(
      "get",
      async () => {
        const { value, pttl } = await primary.getWithTtl(key);
        if (value && ttl && pttl > 0 && pttl < (ttl * 1000) / 2) {
          stats.slidingRefreshes += 1;
          withTimeout(primary.expire(key, ttl)).catch(() => {}); // fire and forget
        }
        return decode(value);
      },
      () => memory.get(key),
    ),
  set: (key, value, ttl) =>
    viaRedis(
      "set",
      () => primary.set(key, encode(value), ttl),
      () => memory.set(key, value, ttl),
    ),
  // Always bump the in-process counters too, so memory mode is consistent if Redis drops.
  // Returns the new values from whichever store versions are currently read from.
  bump: async (keys) => {
    const local = await memory.bump(keys);
    if (primary === memory) return local;
    const usable = redisUsable();
    try {
      const remote = await withTimeout(primary.bump(keys));
      return usable ? remote : local;
    } catch (e) {
      stats.bumpFailures += 1;
      scheduleReplay(keys);
      warn(`bump failed, serving from memory until it is replayed: ${e.message}`);
      return local;
    }
  },
};

const readVersions = async (keys) => {
  if (redisUsable()) {
    try {
      return { versions: await withTimeout(primary.getVersions(keys)), remote: true };
    } catch (e) {
      stats.fallbacks += 1;
      openCircuit("getVersions", e);
    }
  }
  return { versions: await memory.getVersions(keys), remote: false };
};

// ---- Versions -------------------------------------------------------------------------

const vkey = (dep) => `v:${dep}`;

/**
 * Invalidate everything that depends on these versions (one INCR each, pipelined).
 * Resolves to the new versions ({ dep: n }) and pushes them to open /api/events streams.
 */
const bump = async (...deps) => {
  try {
    const values = await store.bump(deps.map(vkey));
    const changed = Object.fromEntries(deps.map((d, i) => [d, values[i]]));
    hub.emit("bump", changed);
    return changed;
  } catch (e) {
    warn("bump failed: " + e.message);
    return {};
  }
};

/** Current versions as { dep: n }, read the same way sendCached reads them. */
const versionMap = async (depList) => {
  if (!depList.length) return {};
  const { versions } = await readVersions(depList.map(vkey));
  return Object.fromEntries(depList.map((d, i) => [d, versions[i]]));
};

/** Header form of a version map: "payments=12,games=3" (dep names never contain "," or "="). */
const formatVersions = (map) =>
  Object.entries(map)
    .map(([d, v]) => `${d}=${v}`)
    .join(",");

/** Current version numbers for the given deps (used for cheap "anything changed?" checks). */
const versionsOf = async (...deps) => (await readVersions(deps.map(vkey))).versions.join(".");

// ---- Responses ------------------------------------------------------------------------

const hash = (s) => crypto.createHash("sha1").update(s).digest("base64url");

// Stable representation of the query string so ?a=1&b=2 and ?b=2&a=1 share a cache entry
const canonicalQuery = (query) =>
  Object.keys(query || {})
    .sort()
    .map((k) => `${k}=${String(query[k])}`)
    .join("&");

const inFlight = new Map(); // coalesce concurrent misses for the same key (per process)

// L1: an in-process copy of bodies cached in Redis, so a hot entry costs one Redis round-trip
// (the version MGET) instead of two. Safe because keys embed the version numbers: after a write
// the key changes and the old L1 copy is never read again. Only used with versions that really
// came from Redis, so a key built from the fallback (memory) counters can never match it.
let l1 = primary === memory ? null : createMemoryStore(L1_MAX_ENTRIES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildEntry = (body) => {
  const etag = `"${hash(body)}"`;
  // Large bodies are kept gzipped: smaller in Redis and sent without re-compressing
  return Buffer.byteLength(body) >= GZIP_MIN_BYTES ? { etag, gz: zlib.gzipSync(body) } : { etag, body };
};

/** Compute a missing entry once, even across instances (short Redis lock; losers wait for it). */
const computeOnce = async (key, ttl, compute, useL1) => {
  const lockKey = `lock:${key}`;
  let locked = true;
  if (redisUsable()) {
    locked = await withTimeout(primary.lock(lockKey, LOCK_MS)).catch(() => true);
    if (!locked) {
      // Another instance is computing it: wait briefly for its result
      for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
        await sleep(LOCK_POLL_MS);
        const ready = await store.get(key, ttl);
        if (ready) {
          stats.lockWaitHits += 1;
          if (useL1) await l1.set(key, ready, Math.min(ttl, L1_TTL));
          return { entry: ready, computed: false };
        }
      }
    }
  }
  try {
    const entry = buildEntry(JSON.stringify(await compute()));
    await store.set(key, entry, ttl);
    if (useL1) await l1.set(key, entry, Math.min(ttl, L1_TTL));
    return { entry, computed: true };
  } finally {
    if (locked && redisUsable()) withTimeout(primary.unlock(lockKey)).catch(() => {});
  }
};

/**
 * Serve a JSON response from cache (computing it on miss), with ETag / 304 support.
 *   name    - endpoint name, part of the key
 *   deps    - version dependencies; bumping any of them invalidates this entry
 *   scope   - extra key material, e.g. the user id for per-user data
 *   ttl     - server-side cache lifetime in seconds (default 1h; only bounds memory)
 *   maxAge  - browser max-age in seconds (0 = always revalidate with If-None-Match)
 */
const sendCached = async (req, res, { name, deps, scope = "", ttl: ttlIn = DEFAULT_TTL, maxAge = 0 }, compute) => {
  const ttl = Math.min(ttlIn, MAX_TTL);
  const { versions, remote } = await readVersions(deps.map(vkey));
  const useL1 = !!l1 && remote;
  const key = `c${CACHE_SCHEMA}:${name}:${versions.join(".")}:${hash(scope + "?" + canonicalQuery(req.query))}`;

  let entry = useL1 ? await l1.get(key) : null;
  if (entry) stats.hitsL1 += 1;
  if (!entry) {
    entry = await store.get(key, ttl);
    if (entry) {
      stats.hitsStore += 1;
      if (useL1) await l1.set(key, entry, Math.min(ttl, L1_TTL));
    }
  }
  let hit = !!entry;
  if (!entry) {
    let pending = inFlight.get(key);
    const started = !pending;
    if (started) {
      stats.misses += 1;
      pending = computeOnce(key, ttl, compute, useL1).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const result = await pending;
    entry = result.entry;
    // A MISS only for the request that actually computed the body
    hit = !(started && result.computed);
  }

  res.set("ETag", entry.etag);
  // Which data versions this body reflects: the browser keeps it until a pushed bump moves one
  res.set("X-Cache-Versions", formatVersions(Object.fromEntries(deps.map((d, i) => [d, versions[i]]))));
  res.set("Cache-Control", maxAge > 0 ? `private, max-age=${maxAge}` : "private, no-cache");
  res.set("X-Cache", hit ? "HIT" : "MISS");
  res.vary("Accept-Encoding");

  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === entry.etag)) {
    return res.status(304).end();
  }
  res.type("application/json");
  if (!entry.gz) return res.send(entry.body);
  // Already gzipped: send the stored bytes (the compression middleware skips encoded responses)
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.set("Content-Encoding", "gzip");
    return res.send(entry.gz);
  }
  res.send(zlib.gunzipSync(entry.gz).toString("utf8"));
};

// Version dependency names, kept in one place so reads and writes agree
const deps = {
  games: "games",
  payments: "payments",
  userPayments: (userId) => `payments:u:${userId}`,
  users: "users",
  audit: "audit",
  userBookings: (userId) => `bookings:u:${userId}`,
  // One account (role etc.); bumped together with `users` when that account changes
  user: (userId) => `user:${userId}`,
};

/** True while versions are read from Redis, i.e. other server instances may bump them too. */
const sharedVersions = () => redisUsable();

/** Counters for /api/health: hits, misses, fallbacks, circuit opens, replays... */
const cacheStats = () => ({
  store: primary.kind,
  usingRedis: redisUsable(),
  unsyncedInvalidations: unsynced.size,
  ...stats,
});

/** Tests only: run against a fake "Redis" store. */
const _setPrimaryForTests = (fake) => {
  primary = fake || memory;
  l1 = primary === memory ? null : createMemoryStore(L1_MAX_ENTRIES);
  circuitOpenUntil = 0;
  unsynced.clear();
};

module.exports = {
  sendCached,
  bump,
  versionsOf,
  versionMap,
  formatVersions,
  sharedVersions,
  cacheStats,
  deps,
  _memory: memory,
  _createMemoryStore: createMemoryStore,
  _setPrimaryForTests,
  _replay: replay,
};
