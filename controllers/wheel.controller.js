const crypto = require("crypto");
const Setting = require("../models/setting.model.js");
const WheelSegment = require("../models/wheelSegment.model.js");
const WheelSpin = require("../models/wheelSpin.model.js");
const AuditLog = require("../models/auditLog.model.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId } = require("../utils/validation.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const cloud = require("../services/cloudinary.js");

// Wheel settings live in one Setting doc; segments are their own collection
const KEY = "wheel";
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 24;
const RECENT_SPINS = 50;

const DEFAULTS = {
  enabled: false,
  title: "Wheel of Fortune",
  subtitle: "",
  spinDurationSec: 6,
  extraRotations: 6,
  // null = random among active segments
  targetSegmentId: null,
  // Seconds a visitor (by IP) must wait between spins; 0 = no limit
  cooldownSec: 0,
};

// Multipart fields arrive as strings
const toBool = (v) => v === true || v === "true" || v === "1";

const text = (value, max, label, code) => {
  const t = String(value ?? "").trim().replace(/\s+/g, " ");
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`, code);
  return t;
};

const intInRange = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`, "INVALID_WHEEL_SETTING");
  }
  return n;
};

const cleanLabel = (v) => {
  const t = text(v, 40, "Label", "INVALID_LABEL");
  if (!t) throw new HttpError(400, "Label is required", "INVALID_LABEL");
  return t;
};

// Free text, e.g. "$50" or "10 Free Spins"
const cleanAmount = (v) => text(v, 30, "Amount", "INVALID_AMOUNT");

// Segments saved before amounts were text hold a number (0 meant "none")
const amountText = (v) => (v === null || v === undefined || v === 0 ? "" : String(v));

const cleanColor = (v) => {
  const c = String(v ?? "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new HttpError(400, "Color must look like #RRGGBB", "INVALID_COLOR");
  return c.toLowerCase();
};

const readConfig = async () => {
  const doc = await Setting.findOne({ key: KEY }).lean();
  return { ...DEFAULTS, ...((doc && doc.value) || {}) };
};

const activeSegments = () => WheelSegment.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();

const toAdminSegment = (s) => ({
  id: s._id,
  label: s.label,
  amount: amountText(s.amount),
  color: s.color,
  active: s.active,
  sortOrder: s.sortOrder,
  imageUrl: cloud.wheelImageUrl(s.image),
});

const toPublicSegment = (s) => ({
  id: s._id,
  label: s.label,
  amount: amountText(s.amount),
  color: s.color,
  imageUrl: cloud.wheelImageUrl(s.image),
});

const uploadImage = async (file) => {
  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const up = await cloud.uploadWheelImage(file.buffer, hash);
  return { publicId: up.publicId, version: up.version };
};

// Identical bytes share one asset: only delete it when no segment uses it any more
const releaseImage = async (publicId) => {
  if (publicId && !(await WheelSegment.exists({ "image.publicId": publicId }))) cloud.destroy(publicId).catch(() => {});
};

const ipHash = (req) => crypto.createHash("sha256").update(`wheel:${req.ip || ""}`).digest("hex");

// ---------- Public (no login) ----------

// Never includes targetSegmentId: visitors must not learn where the wheel will land
const getPublicWheel = async (req, res) => {
  await sendCached(req, res, { name: "public-wheel", deps: [deps.wheel] }, async () => {
    const [config, segments] = await Promise.all([readConfig(), activeSegments()]);
    return {
      enabled: !!config.enabled && segments.length >= MIN_SEGMENTS,
      title: config.title,
      subtitle: config.subtitle,
      spinDurationSec: config.spinDurationSec,
      extraRotations: config.extraRotations,
      cooldownSec: config.cooldownSec,
      segments: segments.map(toPublicSegment),
    };
  });
};

// The server decides the result; the page only animates to it
const spinWheel = async (req, res) => {
  const [config, segments] = await Promise.all([readConfig(), activeSegments()]);
  if (!config.enabled || segments.length < MIN_SEGMENTS) {
    throw new HttpError(403, "The wheel is closed right now", "WHEEL_CLOSED");
  }

  const hash = ipHash(req);
  if (config.cooldownSec > 0) {
    const last = await WheelSpin.findOne({ ipHash: hash }).sort({ createdAt: -1 }).select("createdAt").lean();
    const waitMs = last ? last.createdAt.getTime() + config.cooldownSec * 1000 - Date.now() : 0;
    if (waitMs > 0) {
      const retryAfterSec = Math.ceil(waitMs / 1000);
      throw new HttpError(429, `You can spin again in ${retryAfterSec}s`, "WHEEL_COOLDOWN", { retryAfterSec });
    }
  }

  // A target that was turned off or deleted falls back to random
  let index = config.targetSegmentId ? segments.findIndex((s) => String(s._id) === String(config.targetSegmentId)) : -1;
  const forced = index !== -1;
  if (!forced) index = crypto.randomInt(segments.length);
  const won = segments[index];

  await WheelSpin.create({ segmentId: won._id, label: won.label, amount: amountText(won.amount), forced, ipHash: hash });
  await bump(deps.wheelSpins);
  res.json({ ...toPublicSegment(won), segmentId: won._id, index, spinDurationSec: config.spinDurationSec });
};

// ---------- Admin ----------

// Cached until the wheel changes or someone spins (both are pushed to open admin tabs)
const adminGetWheel = async (req, res) => {
  await sendCached(req, res, { name: "admin-wheel", deps: [deps.wheel, deps.wheelSpins] }, async () => {
    const [config, segments, spins] = await Promise.all([
      readConfig(),
      WheelSegment.find().sort({ sortOrder: 1, createdAt: 1 }).lean(),
      WheelSpin.find().sort({ createdAt: -1 }).limit(RECENT_SPINS).lean(),
    ]);
    return {
      config,
      segments: segments.map(toAdminSegment),
      recentSpins: spins.map((s) => ({
        id: s._id,
        segmentId: s.segmentId,
        label: s.label,
        amount: amountText(s.amount),
        forced: s.forced,
        createdAt: s.createdAt,
      })),
      limits: { minSegments: MIN_SEGMENTS, maxSegments: MAX_SEGMENTS },
    };
  });
};

const updateWheelConfig = async (req, res) => {
  const body = req.body || {};
  const next = await readConfig();

  if (body.enabled !== undefined) next.enabled = toBool(body.enabled);
  if (body.title !== undefined) next.title = text(body.title, 60, "Title", "INVALID_TITLE") || DEFAULTS.title;
  if (body.subtitle !== undefined) next.subtitle = text(body.subtitle, 160, "Subtitle", "INVALID_SUBTITLE");
  if (body.spinDurationSec !== undefined) next.spinDurationSec = intInRange(body.spinDurationSec, 2, 30, "Spin time");
  if (body.extraRotations !== undefined) next.extraRotations = intInRange(body.extraRotations, 2, 15, "Rotations");
  if (body.cooldownSec !== undefined) next.cooldownSec = intInRange(body.cooldownSec, 0, 7 * 24 * 60 * 60, "Cooldown");
  if (body.targetSegmentId !== undefined) {
    if (body.targetSegmentId === null || body.targetSegmentId === "") {
      next.targetSegmentId = null;
    } else {
      const id = toObjectId(body.targetSegmentId, "segment id");
      // A hidden target is allowed (spins fall back to random until it is shown again)
      if (!(await WheelSegment.exists({ _id: id }))) {
        throw new HttpError(400, "Pick a segment for the wheel to land on", "INVALID_TARGET");
      }
      next.targetSegmentId = String(id);
    }
  }

  const doc = await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true, new: true });
  await Promise.all([AuditLog.record(req.userId, "wheel.config", "setting", doc._id, next), bump(deps.wheel)]);
  res.json(next);
};

const createSegment = async (req, res) => {
  const body = req.body || {};
  if ((await WheelSegment.countDocuments()) >= MAX_SEGMENTS) {
    throw new HttpError(400, `The wheel can have at most ${MAX_SEGMENTS} segments`, "TOO_MANY_SEGMENTS");
  }
  const label = cleanLabel(body.label);
  const last = await WheelSegment.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
  const segment = await WheelSegment.create({
    label,
    amount: cleanAmount(body.amount),
    color: body.color !== undefined ? cleanColor(body.color) : undefined,
    image: req.file ? await uploadImage(req.file) : null,
    sortOrder: last ? last.sortOrder + 1 : 0,
  });
  await Promise.all([
    AuditLog.record(req.userId, "wheel.create", "wheel", segment._id, { label, amount: segment.amount }),
    bump(deps.wheel),
  ]);
  res.status(201).json(toAdminSegment(segment));
};

// JSON or multipart: any of label/amount/color/active, a new `image` file, or removeImage=true
const updateSegment = async (req, res) => {
  const id = toObjectId(req.params.id, "segment id");
  const segment = await WheelSegment.findById(id);
  if (!segment) throw new HttpError(404, "Segment not found", "NOT_FOUND");
  const body = req.body || {};

  if (body.label !== undefined) segment.label = cleanLabel(body.label);
  if (body.amount !== undefined) segment.amount = cleanAmount(body.amount);
  if (body.color !== undefined) segment.color = cleanColor(body.color);
  if (body.active !== undefined) segment.active = toBool(body.active);

  const previousImage = segment.image && segment.image.publicId;
  if (req.file) segment.image = await uploadImage(req.file);
  else if (toBool(body.removeImage)) segment.image = null;

  const changed = segment.modifiedPaths();
  if (changed.length) {
    await segment.save();
    if (previousImage && previousImage !== (segment.image && segment.image.publicId)) await releaseImage(previousImage);
    await Promise.all([
      AuditLog.record(req.userId, "wheel.update", "wheel", segment._id, { fields: changed }),
      bump(deps.wheel),
    ]);
  }
  res.json(toAdminSegment(segment));
};

const deleteSegment = async (req, res) => {
  const id = toObjectId(req.params.id, "segment id");
  const segment = await WheelSegment.findByIdAndDelete(id);
  if (!segment) throw new HttpError(404, "Segment not found", "NOT_FOUND");
  await releaseImage(segment.image && segment.image.publicId);
  // The wheel can no longer land on a deleted segment
  await Setting.updateOne({ key: KEY, "value.targetSegmentId": String(segment._id) }, { $set: { "value.targetSegmentId": null } });
  await Promise.all([
    AuditLog.record(req.userId, "wheel.delete", "wheel", segment._id, { label: segment.label, amount: segment.amount }),
    bump(deps.wheel),
  ]);
  res.json({ id: segment._id });
};

// Swap with the neighbour; returns the changed [id, sortOrder] pairs
const moveSegment = async (req, res) => {
  const id = toObjectId(req.params.id, "segment id");
  const segments = await WheelSegment.find().sort({ sortOrder: 1, createdAt: 1 }).select("_id sortOrder");
  const idx = segments.findIndex((s) => s._id.equals(id));
  if (idx === -1) throw new HttpError(404, "Segment not found", "NOT_FOUND");
  const swapIdx = idx + (req.body && req.body.direction === "up" ? -1 : 1);
  if (swapIdx < 0 || swapIdx >= segments.length) return res.json({ changed: [] });

  // Normalise to 0..n-1 then swap, so duplicate sortOrder values can't block the move
  const ordered = segments.map((s) => s._id);
  [ordered[idx], ordered[swapIdx]] = [ordered[swapIdx], ordered[idx]];
  const ops = ordered
    .map((sid, i) => ({ sid, i, prev: segments.find((s) => s._id.equals(sid)).sortOrder }))
    .filter(({ i, prev }) => i !== prev)
    .map(({ sid, i }) => ({ updateOne: { filter: { _id: sid }, update: { $set: { sortOrder: i } } } }));
  if (ops.length) {
    await WheelSegment.bulkWrite(ops);
    await bump(deps.wheel);
  }
  res.json({ changed: ops.map((o) => [o.updateOne.filter._id, o.updateOne.update.$set.sortOrder]) });
};

module.exports = {
  getPublicWheel,
  spinWheel,
  adminGetWheel,
  updateWheelConfig,
  createSegment,
  updateSegment,
  deleteSegment,
  moveSegment,
};
