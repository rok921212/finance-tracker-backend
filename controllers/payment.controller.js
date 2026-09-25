const crypto = require("crypto");
const Payment = require("../models/payment.model.js");
const { PAYMENT_METHODS } = Payment;
const Game = require("../models/game.model.js");
const PaymentEdit = require("../models/paymentEdit.model.js");
const cloud = require("../services/cloudinary.js");
const { HttpError } = require("../utils/httpError.js");
const { parseToCents, parseDay, toObjectId, parsePagination, pageResult, escapeRegex } = require("../utils/validation.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const { listProject, syncToken, sendChanges } = require("../utils/delta.js");
const { pointsUsed } = require("../utils/gamePoints.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// Compact list row: ids + numbers + game name + thumbnail; no full screenshot data
// thumbSize: pixel size of the thumbnails (the admin table shows them smaller than the user dashboard)
const toListItem = (p, thumbSize = 160) => ({
  id: p._id,
  date: p.date,
  game: p.game ? p.game.name : null,
  deposit: p.deposit,
  loaded: p.loaded,
  redeemed: p.redeemed || 0,
  cashout: p.cashout || 0,
  paymentMethod: p.paymentMethod || null,
  player: p.player || null,
  editedAt: p.editedAt || undefined,
  userDeletedAt: p.userDeletedAt || undefined,
  thumb: cloud.thumbUrl(p.screenshot, thumbSize),
  cashoutThumb: cloud.thumbUrl(p.cashoutProof, thumbSize),
  ...(p.user ? { user: { id: p.user._id, username: p.user.username } } : {}),
});

const gameLookup = [
  {
    $lookup: {
      from: "games",
      localField: "gameId",
      foreignField: "_id",
      as: "game",
      pipeline: [{ $project: { name: 1 } }],
    },
  },
  { $unwind: { path: "$game", preserveNullAndEmptyArrays: true } },
];

const cleanPlayer = (value) => {
  const player = String(value ?? "").trim();
  if (!player) throw new HttpError(400, "Player is required (the name used to load points)", "PLAYER_REQUIRED");
  if (player.length > 60) throw new HttpError(400, "Player must be at most 60 characters", "INVALID_PLAYER");
  return player;
};

const cleanPaymentMethod = (value) => {
  const method = String(value ?? "").trim().toLowerCase();
  if (!PAYMENT_METHODS.includes(method)) {
    throw new HttpError(400, `Payment method must be one of: ${PAYMENT_METHODS.join(", ")}`, "INVALID_PAYMENT_METHOD");
  }
  return method;
};

// Shared by create and edit: every entry field is validated in full
const parseEntry = (body) => {
  const date = parseDay(body.date);
  // Allow one day of slack for timezones ahead of UTC
  if (date.getTime() > Date.now() + DAY_MS) {
    throw new HttpError(400, "Date cannot be in the future", "INVALID_DATE");
  }
  if (!String(body.redeemed ?? "").trim()) {
    throw new HttpError(400, "Redeemed is required (enter 0 if nothing was redeemed)", "REDEEMED_REQUIRED");
  }
  const cashoutRaw = String(body.cashout ?? "").trim();
  return {
    date,
    deposit: parseToCents(body.deposit, "Deposit"),
    loaded: parseToCents(body.loaded, "Loaded"),
    redeemed: parseToCents(body.redeemed, "Redeemed"),
    // Optional; empty = 0
    cashout: cashoutRaw ? parseToCents(cashoutRaw, "Cashout") : 0,
    paymentMethod: cleanPaymentMethod(body.paymentMethod),
    player: cleanPlayer(body.player),
    gameId: toObjectId(body.gameId, "game"),
  };
};

const assertGameActive = async (gameId) => {
  const game = await Game.findOne({ _id: gameId, active: true }).select("_id").lean();
  if (!game) throw new HttpError(400, "Game unavailable", "GAME_UNAVAILABLE");
};

// The entry's "loaded" must fit in what's left of the game's points pool (if one is set).
// excludeId: the entry being edited, so its old amount isn't counted twice.
const assertPointsLeft = async (gameId, loaded, excludeId) => {
  const game = await Game.findById(gameId).select("name totalPoints").lean();
  if (!game || game.totalPoints == null) return;
  const { used = 0, redeemed = 0 } = (await pointsUsed([gameId], excludeId)).get(String(gameId)) || {};
  // Redeemed points go back into the game's pool
  const remaining = game.totalPoints - used + redeemed;
  if (loaded > remaining) {
    const left = (Math.max(0, remaining) / 100).toFixed(2);
    throw new HttpError(400, `Not enough points left for ${game.name} (${left} remaining)`, "INSUFFICIENT_GAME_POINTS", {
      remaining: Math.max(0, remaining),
    });
  }
};

const hashOf = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// Same user re-submitting the same screenshot is most likely an accident: ask first
const assertNotDuplicate = async (userId, hash, allowDuplicate, excludeId) => {
  if (allowDuplicate === "true") return;
  const match = { userId, screenshotHash: hash, ...(excludeId ? { _id: { $ne: excludeId } } : {}) };
  const dup = await Payment.findOne(match).select("_id date").lean();
  if (dup) {
    throw new HttpError(409, "This screenshot was already submitted", "DUPLICATE_SCREENSHOT", {
      existing: { id: dup._id, date: dup.date },
    });
  }
};

// Identical bytes reuse the existing Cloudinary asset instead of uploading again.
// `created` is set only when this call made a new asset (so it can be cleaned up on failure).
const storeScreenshot = async (file, hash) => {
  const existing = await Payment.findOne({ screenshotHash: hash }).select("screenshot").lean();
  if (existing) {
    return { value: { publicId: existing.screenshot.publicId, version: existing.screenshot.version }, created: null };
  }
  const up = await cloud.uploadScreenshot(file.buffer, hash, file.detectedFormat);
  return {
    value: { publicId: up.publicId, version: up.version },
    created: up.existing ? null : { publicId: up.publicId, field: "screenshot" },
  };
};

// Optional cashout screenshot; identical bytes reuse the existing Cloudinary asset
const storeCashoutProof = async (file) => {
  const hash = hashOf(file.buffer);
  const reuse = await Payment.findOne({ cashoutProofHash: hash }).select("cashoutProof").lean();
  if (reuse && reuse.cashoutProof) {
    return { value: { publicId: reuse.cashoutProof.publicId, version: reuse.cashoutProof.version }, hash, created: null };
  }
  const up = await cloud.uploadCashoutProof(file.buffer, hash);
  return {
    value: { publicId: up.publicId, version: up.version },
    hash,
    created: up.existing ? null : { publicId: up.publicId, field: "cashoutProof" },
  };
};

// Assets made by this code are named after their hash (payments/<hash>, payments/cashout/<hash>), and every
// entry using one stores that hash, so look it up through the (indexed) hash field instead of scanning
// by publicId. Any other name (e.g. from older data) falls back to the exact publicId match.
const HASH_FIELD = { screenshot: "screenshotHash", cashoutProof: "cashoutProofHash" };
const ASSET_ID_RE = { screenshot: /^payments\/([0-9a-f]{64})$/, cashoutProof: /^payments\/cashout\/([0-9a-f]{64})$/ };
const assetRefQuery = ({ field, publicId }) => {
  const m = ASSET_ID_RE[field] && ASSET_ID_RE[field].exec(publicId);
  return m ? { [HASH_FIELD[field]]: m[1], [`${field}.publicId`]: publicId } : { [`${field}.publicId`]: publicId };
};

// Avoid orphaned images: delete assets that no payment references any more
const cleanupAssets = async (assets) => {
  for (const asset of assets) {
    if (!asset) continue;
    const stillUsed = await Payment.exists(assetRefQuery(asset)).catch(() => true);
    if (!stillUsed) await cloud.destroy(asset.publicId).catch(() => {});
  }
};

const createPayment = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const entry = parseEntry(req.body);
  const cashoutFile = req.cashoutProofFile; // optional
  await assertGameActive(entry.gameId);
  await assertPointsLeft(entry.gameId, entry.loaded);

  // The payment screenshot is optional
  const hash = req.file ? hashOf(req.file.buffer) : null;
  if (hash) await assertNotDuplicate(userId, hash, req.body.allowDuplicate);

  const created = [];
  let payment;
  try {
    const shot = hash ? await storeScreenshot(req.file, hash) : null;
    if (shot) created.push(shot.created);
    const proof = cashoutFile ? await storeCashoutProof(cashoutFile) : null;
    if (proof) created.push(proof.created);
    payment = await Payment.create({
      userId,
      ...entry,
      ...(proof ? { cashoutProof: proof.value, cashoutProofHash: proof.hash } : {}),
      ...(shot ? { screenshot: shot.value, screenshotHash: hash } : {}),
    });
  } catch (err) {
    await cleanupAssets(created);
    throw err;
  }

  await bump(deps.payments, deps.userPayments(userId));
  res.status(201).json({ message: "Entry submitted", payment: { id: payment._id } });
};

const myPaymentDetail = async (userId, id) => {
  const [p] = await Payment.aggregate([{ $match: { _id: id, userId, userDeletedAt: null } }, ...gameLookup]);
  // 404 (not 403) so other users' ids are not revealed
  if (!p) throw new HttpError(404, "Payment not found", "NOT_FOUND");
  return {
    ...toListItem(p),
    gameId: p.gameId,
    screenshot: cloud.fullUrl(p.screenshot),
    cashoutProof: cloud.fullUrl(p.cashoutProof),
    createdAt: p.createdAt,
  };
};

const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Field-by-field changes between the stored entry and the edited one, for the admin edit log.
// Legacy entries may lack some fields, so they're normalised the same way toListItem does.
const diffEntry = async (current, entry) => {
  const changes = [];
  const compare = (field, from, to) => {
    if (from !== to) changes.push({ field, from, to });
  };
  compare("date", dayOf(current.date), dayOf(entry.date));
  if (!current.gameId.equals(entry.gameId)) {
    const games = await Game.find({ _id: { $in: [current.gameId, entry.gameId] } }).select("name").lean();
    const nameOf = (gid) => (games.find((g) => g._id.equals(gid)) || {}).name || null;
    changes.push({ field: "game", from: nameOf(current.gameId), to: nameOf(entry.gameId) });
  }
  compare("player", current.player || null, entry.player);
  compare("paymentMethod", current.paymentMethod || null, entry.paymentMethod);
  compare("deposit", current.deposit, entry.deposit);
  compare("loaded", current.loaded, entry.loaded);
  compare("redeemed", current.redeemed || 0, entry.redeemed);
  compare("cashout", current.cashout || 0, entry.cashout);
  return changes;
};

// Edit an own entry. Screenshot / cashout screenshot are replaced only when a new file is sent.
// Every edit that changes something is logged (PaymentEdit) so the admin can see what changed and when.
const updatePayment = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const id = toObjectId(req.params.id, "payment id");
  const current = await Payment.findOne({ _id: id, userId, userDeletedAt: null })
    .select("date gameId player paymentMethod deposit loaded redeemed cashout screenshot screenshotHash cashoutProof")
    .lean();
  if (!current) throw new HttpError(404, "Payment not found", "NOT_FOUND");

  const entry = parseEntry(req.body);
  // Keeping a game that has since been disabled is fine; switching to one is not
  if (!current.gameId.equals(entry.gameId)) await assertGameActive(entry.gameId);
  // Checked on every edit: "loaded" may have changed even when the game didn't
  await assertPointsLeft(entry.gameId, entry.loaded, id);
  const cashoutFile = req.cashoutProofFile; // optional: omitted keeps the current one

  const newHash = req.file ? hashOf(req.file.buffer) : null;
  const replaceShot = newHash && newHash !== current.screenshotHash;
  if (replaceShot) await assertNotDuplicate(userId, newHash, req.body.allowDuplicate, id);

  const set = { ...entry };
  const changes = await diffEntry(current, entry);
  const created = [];
  try {
    if (replaceShot) {
      const shot = await storeScreenshot(req.file, newHash);
      created.push(shot.created);
      Object.assign(set, { screenshot: shot.value, screenshotHash: newHash });
      changes.push({ field: "screenshot", from: null, to: current.screenshot ? "replaced" : "added" });
    }
    if (cashoutFile) {
      const proof = await storeCashoutProof(cashoutFile);
      created.push(proof.created);
      Object.assign(set, { cashoutProof: proof.value, cashoutProofHash: proof.hash });
      const oldProofId = current.cashoutProof && current.cashoutProof.publicId;
      if (proof.value.publicId !== oldProofId) {
        changes.push({ field: "cashoutProof", from: null, to: oldProofId ? "replaced" : "added" });
      }
    }
    if (changes.length) set.editedAt = new Date();
    // The user may have deleted the entry (from another tab) while this request was running
    const result = await Payment.updateOne({ _id: id, userId, userDeletedAt: null }, { $set: set }, { runValidators: true });
    if (!result.matchedCount) throw new HttpError(404, "Payment not found", "NOT_FOUND");
  } catch (err) {
    await cleanupAssets(created);
    throw err;
  }
  if (changes.length) await PaymentEdit.create({ paymentId: id, userId, changes, createdAt: set.editedAt });

  // Images this edit replaced or dropped: delete them if nothing else uses them
  const dropped = [];
  if (set.screenshot && current.screenshot) dropped.push({ publicId: current.screenshot.publicId, field: "screenshot" });
  const oldProof = current.cashoutProof && current.cashoutProof.publicId;
  if (oldProof && set.cashoutProof && set.cashoutProof.publicId !== oldProof) {
    dropped.push({ publicId: oldProof, field: "cashoutProof" });
  }
  await cleanupAssets(dropped);

  await bump(deps.payments, deps.userPayments(userId));
  res.json({ message: "Entry updated", payment: await myPaymentDetail(userId, id) });
};

const MY_SORTS = ["date", "deposit", "loaded", "redeemed", "cashout", "player"];
// Player names compare case-insensitively (sort order and filter)
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

// Optional player filter: the exact name, ignoring case ("Superman" matches "superman", "superman2" does not)
const myPlayerMatch = (query) => {
  const player = String(query.player ?? "").trim().slice(0, 60);
  return player ? { player: { $regex: "^" + escapeRegex(player) + "$", $options: "i" } } : {};
};

// ?sort=deposit|loaded|redeemed|cashout|player|date &order=asc|desc (default: newest first; player A-Z)
const myListOptions = (query) => {
  const sort = query.sort ? String(query.sort) : "date";
  if (!MY_SORTS.includes(sort)) throw new HttpError(400, "Invalid sort", "INVALID_SORT");
  if (query.order && !["asc", "desc"].includes(query.order)) throw new HttpError(400, "Invalid order", "INVALID_ORDER");
  const order = query.order || (sort === "player" ? "asc" : "desc");
  const dir = order === "asc" ? 1 : -1;
  // Ties (and the default view) fall back to newest first
  const $sort = sort === "date" ? { date: dir, _id: dir } : { [sort]: dir, date: -1, _id: -1 };
  return { $sort, collation: sort === "player" ? CASE_INSENSITIVE : undefined };
};

const listMyPayments = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const pg = parsePagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const match = { userId, userDeletedAt: null, ...myPlayerMatch(req.query) };
  const { $sort, collation } = myListOptions(req.query);

  await sendCached(
    req,
    res,
    { name: "my-payments", deps: [deps.userPayments(userId), deps.games], scope: String(userId) },
    async () => {
      const sync = await syncToken(deps.userPayments(userId)); // read before querying
      const [items, total] = await Promise.all([
        Payment.aggregate([
          { $match: match },
          { $sort },
          { $skip: pg.skip },
          { $limit: pg.limit },
          listProject,
          ...gameLookup,
        ]).collation(collation),
        Payment.countDocuments(match),
      ]);
      return { ...pageResult(items.map((p) => toListItem(p)), total, pg), sync };
    },
  );
};

// Delta sync: only the user's payments changed since the last sync
const myChanges = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  await sendChanges(req, res, {
    dep: deps.userPayments(userId),
    match: { userId },
    toItem: toListItem,
    extraStages: gameLookup,
    tombstoneMatch: { userId },
    // Entries the user deleted leave their list (match:false) but still exist for the admin
    visible: (r) => !r.userDeletedAt,
  });
};

// "Delete" from the user's side: the entry is only hidden from this user. The admin still
// sees it (flagged) and is the only one who can delete it permanently.
const deleteMyPayment = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const id = toObjectId(req.params.id, "payment id");
  const result = await Payment.updateOne({ _id: id, userId, userDeletedAt: null }, { $set: { userDeletedAt: new Date() } });
  if (!result.matchedCount) throw new HttpError(404, "Payment not found", "NOT_FOUND");
  await bump(deps.payments, deps.userPayments(userId));
  res.json({ message: "Entry deleted", id });
};

const mySummary = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const opts = { name: "my-summary", deps: [deps.userPayments(userId)], scope: String(userId) };
  await sendCached(req, res, opts, async () => {
    // One group per game; the overall totals are summed from those rows
    const rows = await Payment.aggregate([
      { $match: { userId, userDeletedAt: null, ...myPlayerMatch(req.query) } },
      {
        $group: {
          _id: "$gameId",
          deposit: { $sum: "$deposit" },
          loaded: { $sum: "$loaded" },
          redeemed: { $sum: { $ifNull: ["$redeemed", 0] } },
          cashout: { $sum: { $ifNull: ["$cashout", 0] } },
        },
      },
      {
        $lookup: {
          from: "games",
          localField: "_id",
          foreignField: "_id",
          as: "game",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: "$game", preserveNullAndEmptyArrays: true } },
      { $sort: { redeemed: -1, "game.name": 1 } },
    ]);
    const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
    return {
      totalDeposit: sum("deposit"),
      totalLoaded: sum("loaded"),
      totalRedeemed: sum("redeemed"),
      totalCashout: sum("cashout"),
      redeemedByGame: rows.map((r) => ({ gameId: r._id, game: r.game ? r.game.name : null, redeemed: r.redeemed })),
    };
  });
};

const getMyPayment = async (req, res) => {
  const userId = toObjectId(req.userId, "user");
  const id = toObjectId(req.params.id, "payment id");
  const opts = { name: "my-payment", deps: [deps.userPayments(userId), deps.games], scope: `${userId}:${id}` };
  await sendCached(req, res, opts, () => myPaymentDetail(userId, id));
};

module.exports = {
  createPayment,
  updatePayment,
  deleteMyPayment,
  listMyPayments,
  myChanges,
  mySummary,
  getMyPayment,
  toListItem,
  gameLookup,
  cleanupAssets,
};
