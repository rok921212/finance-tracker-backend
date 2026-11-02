const Game = require("../models/game.model.js");
const GameCredential = require("../models/gameCredential.model.js");
const AuditLog = require("../models/auditLog.model.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId } = require("../utils/validation.js");
const { encrypt, decrypt } = require("../services/secretBox.js");

// Admin-only backend logins per game. Responses are never cached (no sendCached, Cache-Control: no-store).
// The list has no passwords; a password is only returned by reveal, which is audit-logged.

const MAX_PER_GAME = 50;

const noStore = (res) => res.setHeader("Cache-Control", "no-store");

const text = (value, label, max, { required = false } = {}) => {
  const s = String(value ?? "").trim();
  if (required && !s) throw new HttpError(400, `${label} is required`, "INVALID_CREDENTIAL");
  if (s.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`, "INVALID_CREDENTIAL");
  return s;
};
// Passwords keep their spaces; only length is checked
const password = (value, { required }) => {
  const s = value == null ? "" : String(value);
  if (required && !s) throw new HttpError(400, "Password is required", "INVALID_CREDENTIAL");
  if (s.length > 200) throw new HttpError(400, "Password must be at most 200 characters", "INVALID_CREDENTIAL");
  return s;
};

// Optional link: http(s) only (no javascript: etc.); a bare "example.com/admin" gets https://
const link = (value, label) => {
  let s = text(value, label, 500);
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(400, `${label} must be a valid link`, "INVALID_CREDENTIAL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new HttpError(400, `${label} must start with http:// or https://`, "INVALID_CREDENTIAL");
  }
  return s;
};

const toItem = (c) => ({
  id: c._id,
  gameId: c.gameId,
  label: c.label || "",
  username: c.username,
  notes: c.notes || "",
  adminUrl: c.adminUrl || "",
  gameUrl: c.gameUrl || "",
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const findGame = async (req) => {
  const gameId = toObjectId(req.params.id, "game id");
  const game = await Game.findById(gameId).select("name").lean();
  if (!game) throw new HttpError(404, "Game not found", "NOT_FOUND");
  return game;
};

const findCredential = async (req) => {
  const gameId = toObjectId(req.params.id, "game id");
  const credId = toObjectId(req.params.credId, "credential id");
  const cred = await GameCredential.findOne({ _id: credId, gameId });
  if (!cred) throw new HttpError(404, "Login not found", "NOT_FOUND");
  return cred;
};

const listCredentials = async (req, res) => {
  const game = await findGame(req);
  const items = await GameCredential.find({ gameId: game._id }).select("-password").sort({ createdAt: 1 }).lean();
  noStore(res);
  res.json(items.map(toItem));
};

// Number of logins per game, for the "Logins (n)" buttons
const credentialCounts = async (req, res) => {
  const rows = await GameCredential.aggregate([{ $group: { _id: "$gameId", count: { $sum: 1 } } }]);
  noStore(res);
  res.json(Object.fromEntries(rows.map((r) => [String(r._id), r.count])));
};

const createCredential = async (req, res) => {
  const game = await findGame(req);
  if ((await GameCredential.countDocuments({ gameId: game._id })) >= MAX_PER_GAME) {
    throw new HttpError(400, `A game can have at most ${MAX_PER_GAME} logins`, "TOO_MANY_CREDENTIALS");
  }
  const cred = await GameCredential.create({
    gameId: game._id,
    label: text(req.body.label, "Label", 60),
    username: text(req.body.username, "Username", 100, { required: true }),
    password: encrypt(password(req.body.password, { required: true })),
    notes: text(req.body.notes, "Notes", 300),
    adminUrl: link(req.body.adminUrl, "Admin link"),
    gameUrl: link(req.body.gameUrl, "Game link"),
    createdBy: req.userId,
  });
  await AuditLog.record(req.userId, "credential.create", "credential", cred._id, { game: game.name, username: cred.username });
  noStore(res);
  res.status(201).json(toItem(cred));
};

// Fields left out are unchanged; an empty password keeps the current one
const updateCredential = async (req, res) => {
  const cred = await findCredential(req);
  const changed = [];
  if (req.body.label !== undefined) {
    cred.label = text(req.body.label, "Label", 60);
    changed.push("label");
  }
  if (req.body.username !== undefined) {
    cred.username = text(req.body.username, "Username", 100, { required: true });
    changed.push("username");
  }
  if (req.body.notes !== undefined) {
    cred.notes = text(req.body.notes, "Notes", 300);
    changed.push("notes");
  }
  for (const [key, label] of [["adminUrl", "Admin link"], ["gameUrl", "Game link"]]) {
    if (req.body[key] !== undefined) {
      cred[key] = link(req.body[key], label);
      changed.push(key);
    }
  }
  const pw = password(req.body.password, { required: false });
  if (pw) {
    cred.password = encrypt(pw);
    changed.push("password");
  }
  await cred.save();
  if (changed.length) await AuditLog.record(req.userId, "credential.update", "credential", cred._id, { username: cred.username, changed });
  noStore(res);
  res.json(toItem(cred));
};

const deleteCredential = async (req, res) => {
  const cred = await findCredential(req);
  await cred.deleteOne();
  await AuditLog.record(req.userId, "credential.delete", "credential", cred._id, { username: cred.username });
  noStore(res);
  res.json({ message: "Login deleted", id: cred._id });
};

const revealCredential = async (req, res) => {
  const cred = await findCredential(req);
  const plain = decrypt(cred.password);
  await AuditLog.record(req.userId, "credential.reveal", "credential", cred._id, { username: cred.username });
  noStore(res);
  res.json({ id: cred._id, password: plain });
};

module.exports = { listCredentials, credentialCounts, createCredential, updateCredential, deleteCredential, revealCredential };
