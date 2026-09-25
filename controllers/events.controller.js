const User = require("../models/user.model.js");
const { HttpError } = require("../utils/httpError.js");
const { hub } = require("../services/events.js");
const { versionMap, sharedVersions, deps } = require("../services/cache.js");

const HEARTBEAT_MS = 25000;
const MAX_DEPS = 200;
const CROSS_INSTANCE_POLL_MS = 3000;

// Deps every user may follow: the games list (its points-remaining depends on all payments)
const USER_GLOBAL = [deps.games, deps.payments];
// What an admin follows even before caching anything
const ADMIN_GLOBAL = [deps.games, deps.payments, deps.users, deps.audit];

const streams = new Set();

// ---- Cross-instance changes -------------------------------------------------
// Bumps made on this instance arrive through the hub directly. With a shared Redis, another
// instance may bump too: poll the counters open streams care about (server-side only) and emit
// whatever moved. Inactive when versions are process-local or no stream is open.
const lastSeen = new Map();
let pollTimer = null;
hub.on("bump", (changed) => Object.entries(changed).forEach(([d, v]) => lastSeen.set(d, v)));

const pollOnce = async () => {
  if (!streams.size || !sharedVersions()) return;
  const watched = new Set();
  streams.forEach((s) => s.deps.forEach((d) => watched.add(d)));
  const current = await versionMap([...watched]).catch(() => ({}));
  const changed = {};
  for (const [d, v] of Object.entries(current)) {
    if (lastSeen.has(d) && lastSeen.get(d) !== v) changed[d] = v;
    else if (!lastSeen.has(d)) lastSeen.set(d, v);
  }
  if (Object.keys(changed).length) hub.emit("bump", changed);
};

const syncPoller = () => {
  if (streams.size && !pollTimer) {
    pollTimer = setInterval(pollOnce, CROSS_INSTANCE_POLL_MS);
    pollTimer.unref();
  } else if (!streams.size && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastSeen.clear();
  }
};

// ---- Stream -----------------------------------------------------------------

/**
 * GET /api/events?deps=a,b,c  (text/event-stream)
 * Pushes data-version bumps so the browser can keep cached responses until they really change,
 * instead of revalidating them. Events carry only dep names and version numbers.
 *   event: hello  data: {dep: version}  current versions of the requested deps (resync on (re)connect)
 *   event: bump   data: {dep: version}  deps that just changed, filtered to what this user may see
 */
const openStream = async (req, res) => {
  const userId = String(req.userId);
  const user = await User.findById(userId).select("role").lean();
  if (!user) throw new HttpError(401, "User not found", "UNAUTHORIZED");

  const conn = { admin: user.role === "admin", deps: new Set() };
  const own = new Set([deps.userPayments(userId), deps.userBookings(userId), deps.user(userId)]);
  const allowed = (dep) => conn.admin || USER_GLOBAL.includes(dep) || own.has(dep);

  const requested = String(req.query.deps || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, MAX_DEPS)
    .filter(allowed);
  conn.deps = new Set([...requested, ...(conn.admin ? ADMIN_GLOBAL : USER_GLOBAL), ...own]);

  res.status(200);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const onBump = async (changed) => {
    const visible = Object.fromEntries(Object.entries(changed).filter(([d]) => allowed(d)));
    if (Object.keys(visible).length) {
      Object.keys(visible).forEach((d) => conn.deps.add(d));
      send("bump", visible);
    }
    // This account changed (e.g. role): re-check what the stream may carry from now on
    if (changed[deps.user(userId)] !== undefined) {
      const fresh = await User.findById(userId).select("role").lean().catch(() => null);
      if (!fresh) return res.end();
      conn.admin = fresh.role === "admin";
    }
  };

  // Subscribe before reading versions, so a bump in between is never missed
  hub.on("bump", onBump);
  const ping = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  streams.add(conn);
  syncPoller();
  res.on("close", () => {
    clearInterval(ping);
    hub.off("bump", onBump);
    streams.delete(conn);
    syncPoller();
  });

  send("hello", await versionMap([...conn.deps]));
};

module.exports = { openStream, _streams: streams };
