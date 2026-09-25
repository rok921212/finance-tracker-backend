const Payment = require("../models/payment.model.js");
const DeletedPayment = require("../models/deletedPayment.model.js");
const { TOMBSTONE_TTL_S } = DeletedPayment;
const { HttpError } = require("./httpError.js");
const { versionsOf } = require("../services/cache.js");

// Rows are re-sent if they changed within this window, so a write that commits slightly
// after its updatedAt timestamp is never missed. Clients de-duplicate by id.
const SAFETY_MS = 5000;
const CHANGES_LIMIT = 200;

// Only the fields list rows need; keeps Mongo -> API transfer small
const listProject = {
  $project: {
    date: 1,
    gameId: 1,
    userId: 1,
    deposit: 1,
    loaded: 1,
    redeemed: 1,
    cashout: 1,
    cashoutProof: 1,
    paymentMethod: 1,
    player: 1,
    editedAt: 1,
    userDeletedAt: 1,
    screenshot: 1,
    createdAt: 1,
    updatedAt: 1,
  },
};

/** Sync token returned with a list, so the client can ask for "changes since" later. */
const syncToken = async (dep) => ({
  version: await versionsOf(dep),
  cursor: new Date(Date.now() - SAFETY_MS).toISOString(),
});

const parseSince = (value) => {
  const d = new Date(String(value || ""));
  if (!value || Number.isNaN(d.getTime())) throw new HttpError(400, "Invalid since cursor", "INVALID_CURSOR");
  return d;
};

/**
 * Delta endpoint: returns only payments changed since the client's cursor.
 * - If the client's version token still matches, nothing changed: 204 with no body and no DB query.
 * - `match` tells the client whether the row still belongs in its list (false when `visible` says no).
 * - Too many changes -> { reset: true } so the client refetches the page instead.
 * - Permanently deleted rows come from tombstones as { id, deleted: true, match: false }.
 * - `visible(row)` (optional) hides rows from this feed, e.g. entries the user deleted on their side.
 */
const sendChanges = async (req, res, { dep, match, toItem, extraStages = [], tombstoneMatch = {}, visible }) => {
  const version = await versionsOf(dep);
  res.set("Cache-Control", "no-store");
  if (req.query.v && req.query.v === version) return res.status(204).end();

  const since = parseSince(req.query.since);
  const cursor = new Date(Date.now() - SAFETY_MS).toISOString(); // taken before querying
  // Tombstones expire: past that window we can't prove what was deleted, so reload everything
  if (Date.now() - since.getTime() > (TOMBSTONE_TTL_S - 3600) * 1000) return res.json({ reset: true, version, cursor });

  const [rows, tombstones] = await Promise.all([
    Payment.aggregate([
      { $match: { ...match, updatedAt: { $gt: since } } },
      { $sort: { updatedAt: 1 } },
      { $limit: CHANGES_LIMIT + 1 },
      listProject,
      ...extraStages,
    ]),
    DeletedPayment.find({ ...tombstoneMatch, deletedAt: { $gt: since } })
      .select("paymentId")
      .limit(CHANGES_LIMIT + 1)
      .lean(),
  ]);
  if (rows.length > CHANGES_LIMIT || tombstones.length > CHANGES_LIMIT) return res.json({ reset: true, version, cursor });

  res.json({
    version,
    cursor,
    items: [
      ...rows.map((r) => ({
        ...toItem(r),
        createdAt: r.createdAt,
        match: !visible || visible(r),
      })),
      ...tombstones.map((t) => ({ id: t.paymentId, deleted: true, match: false })),
    ],
  });
};

module.exports = { listProject, syncToken, sendChanges };
