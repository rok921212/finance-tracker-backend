const crypto = require("crypto");
const Game = require("../models/game.model.js");
const AuditLog = require("../models/auditLog.model.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId } = require("../utils/validation.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const cloud = require("../services/cloudinary.js");

// Public (authenticated) list used by the Add Entry dropdown: active games only
// Cached in Redis until a game changes; the browser always revalidates (a cheap 304 via ETag)
const listActiveGames = async (req, res) => {
  await sendCached(req, res, { name: "games", deps: [deps.games] }, async () => {
    const games = await Game.find({ active: true }).sort({ sortOrder: 1, name: 1 }).select("name").lean();
    return games.map((g) => ({ id: g._id, name: g.name }));
  });
};

const cleanName = (name) => {
  const n = String(name ?? "").trim();
  if (n.length < 2 || n.length > 60) throw new HttpError(400, "Game name must be 2-60 characters", "INVALID_NAME");
  return n;
};

const toAdminGame = (g) => ({
  id: g._id,
  name: g.name,
  slug: g.slug,
  active: g.active,
  sortOrder: g.sortOrder,
  imageUrl: cloud.gameImageUrl(g.image),
});

const adminListGames = async (req, res) => {
  await sendCached(req, res, { name: "admin-games", deps: [deps.games] }, async () => {
    const games = await Game.find().sort({ sortOrder: 1, name: 1 }).select("name slug active sortOrder image").lean();
    return games.map(toAdminGame);
  });
};

const createGame = async (req, res) => {
  const name = cleanName(req.body.name);
  const slug = Game.slugify(name);
  if (await Game.exists({ slug })) throw new HttpError(409, "A game with this name already exists", "GAME_EXISTS");
  const last = await Game.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
  const game = await Game.create({ name, slug, sortOrder: last ? last.sortOrder + 1 : 0 });
  await Promise.all([AuditLog.record(req.userId, "game.create", "game", game._id, { name }), bump(deps.games)]);
  res.status(201).json(toAdminGame(game));
};

const updateGame = async (req, res) => {
  const id = toObjectId(req.params.id, "game id");
  const game = await Game.findById(id);
  if (!game) throw new HttpError(404, "Game not found", "NOT_FOUND");

  const changes = {};
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    const slug = Game.slugify(name);
    if (slug !== game.slug && (await Game.exists({ slug }))) {
      throw new HttpError(409, "A game with this name already exists", "GAME_EXISTS");
    }
    changes.name = { from: game.name, to: name };
    game.name = name;
    game.slug = slug;
  }
  if (req.body.sortOrder !== undefined) {
    const order = Number(req.body.sortOrder);
    if (!Number.isInteger(order)) throw new HttpError(400, "sortOrder must be an integer", "INVALID_ORDER");
    game.sortOrder = order;
  }
  let toggled = false;
  if (req.body.active !== undefined) {
    const active = Boolean(req.body.active);
    toggled = active !== game.active;
    game.active = active;
  }
  // Mongoose only sends the modified paths ($set), not the whole document
  const modified = game.isModified();
  await game.save();
  if (modified) await bump(deps.games);

  if (toggled) await AuditLog.record(req.userId, "game.toggle", "game", game._id, { active: game.active });
  if (changes.name) await AuditLog.record(req.userId, "game.update", "game", game._id, changes);
  res.json(toAdminGame(game));
};

// Swap sortOrder with the neighbour in the requested direction
const moveGame = async (req, res) => {
  const id = toObjectId(req.params.id, "game id");
  const dir = req.body.direction === "up" ? -1 : 1;
  const games = await Game.find().sort({ sortOrder: 1, name: 1 }).select("_id sortOrder");
  const idx = games.findIndex((g) => g._id.equals(id));
  if (idx === -1) throw new HttpError(404, "Game not found", "NOT_FOUND");
  const swapIdx = idx + dir;
  if (swapIdx >= 0 && swapIdx < games.length) {
    // Normalise to 0..n-1 then swap, so duplicate sortOrder values can't block the move
    const ordered = games.map((g) => g._id);
    [ordered[idx], ordered[swapIdx]] = [ordered[swapIdx], ordered[idx]];
    // Delta write: only games whose position actually changed
    const ops = ordered
      .map((gid, i) => ({ gid, i, prev: games.find((g) => g._id.equals(gid)).sortOrder }))
      .filter(({ i, prev }) => i !== prev)
      .map(({ gid, i }) => ({ updateOne: { filter: { _id: gid }, update: { $set: { sortOrder: i } } } }));
    if (ops.length) {
      await Game.bulkWrite(ops);
      await bump(deps.games);
    }
    // Delta response: new order as [id, sortOrder] pairs for the changed games only
    return res.json({ changed: ops.map((o) => [o.updateOne.filter._id, o.updateOne.update.$set.sortOrder]) });
  }
  res.json({ changed: [] });
};

// No login: the shareable public games page. Active games only, in the admin's order
const listPublicGames = async (req, res) => {
  await sendCached(req, res, { name: "public-games", deps: [deps.games] }, async () => {
    const games = await Game.find({ active: true }).sort({ sortOrder: 1, name: 1 }).select("name image").lean();
    return games.map((g) => ({ id: g._id, name: g.name, imageUrl: cloud.gameImageUrl(g.image) }));
  });
};

// Any image is uploaded and cropped to 600x600 by Cloudinary; identical bytes reuse the same asset
const uploadGameImage = async (req, res) => {
  const id = toObjectId(req.params.id, "game id");
  const game = await Game.findById(id);
  if (!game) throw new HttpError(404, "Game not found", "NOT_FOUND");

  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const up = await cloud.uploadGameImage(req.file.buffer, hash);
  const previous = game.image && game.image.publicId;
  game.image = { publicId: up.publicId, version: up.version };
  await game.save();
  // Another game may share the old asset (same bytes): only delete it when nothing else uses it
  if (previous && previous !== up.publicId && !(await Game.exists({ "image.publicId": previous }))) {
    cloud.destroy(previous).catch(() => {});
  }
  await Promise.all([AuditLog.record(req.userId, "game.image", "game", game._id, { action: "upload" }), bump(deps.games)]);
  res.json(toAdminGame(game));
};

const removeGameImage = async (req, res) => {
  const id = toObjectId(req.params.id, "game id");
  const game = await Game.findById(id);
  if (!game) throw new HttpError(404, "Game not found", "NOT_FOUND");
  const previous = game.image && game.image.publicId;
  if (previous) {
    game.image = null;
    await game.save();
    if (!(await Game.exists({ "image.publicId": previous }))) cloud.destroy(previous).catch(() => {});
    await Promise.all([AuditLog.record(req.userId, "game.image", "game", game._id, { action: "remove" }), bump(deps.games)]);
  }
  res.json(toAdminGame(game));
};

module.exports = { listActiveGames, listPublicGames, adminListGames, createGame, updateGame, moveGame, uploadGameImage, removeGameImage };
