const crypto = require("crypto");
const Tag = require("../models/tag.model.js");
const { PAYMENT_METHODS } = require("../models/payment.model.js");
const AuditLog = require("../models/auditLog.model.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId } = require("../utils/validation.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const cloud = require("../services/cloudinary.js");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Multipart fields arrive as strings
const toBool = (v) => v === true || v === "true" || v === "1";

const text = (value, max, label, code) => {
  const t = String(value ?? "").trim().replace(/\s+/g, " ");
  if (t.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`, code);
  return t;
};

const cleanMethod = (m) => {
  if (!PAYMENT_METHODS.includes(m)) throw new HttpError(400, "Pick a valid payment method", "INVALID_PAYMENT_METHOD");
  return m;
};

const cleanHandle = (h) => {
  const t = text(h, 100, "Tag", "INVALID_TAG");
  if (!t) throw new HttpError(400, "Tag is required", "INVALID_TAG");
  return t;
};

const assertUnique = async (method, handle, exceptId) => {
  const filter = { method, handle: new RegExp(`^${escapeRegex(handle)}$`, "i") };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Tag.exists(filter)) throw new HttpError(409, "This tag already exists for that payment method", "TAG_EXISTS");
};

// Download file name: only safe characters (Cloudinary puts it in the attachment flag)
const downloadName = (t) => `${t.method}-${String(t.handle).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag"}-qr`;

const toAdminTag = (t) => ({
  id: t._id,
  method: t.method,
  handle: t.handle,
  name: t.name || "",
  note: t.note || "",
  active: t.active,
  sortOrder: t.sortOrder,
  qrUrl: cloud.tagQrUrl(t.qr),
});

const uploadQr = async (file) => {
  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const up = await cloud.uploadTagQr(file.buffer, hash);
  return { publicId: up.publicId, version: up.version };
};

// Identical bytes share one asset: only delete it when no tag uses it any more
const releaseQr = async (publicId) => {
  if (publicId && !(await Tag.exists({ "qr.publicId": publicId }))) cloud.destroy(publicId).catch(() => {});
};

const adminListTags = async (req, res) => {
  await sendCached(req, res, { name: "admin-tags", deps: [deps.tags] }, async () => {
    const tags = await Tag.find().sort({ method: 1, sortOrder: 1, createdAt: 1 }).lean();
    return tags.map(toAdminTag);
  });
};

// No login: active tags in payment-method order, then the admin's order
const listPublicTags = async (req, res) => {
  await sendCached(req, res, { name: "public-tags", deps: [deps.tags] }, async () => {
    const tags = await Tag.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    return tags
      .sort((a, b) => PAYMENT_METHODS.indexOf(a.method) - PAYMENT_METHODS.indexOf(b.method))
      .map((t) => ({
        id: t._id,
        method: t.method,
        handle: t.handle,
        name: t.name || "",
        note: t.note || "",
        qrUrl: cloud.tagQrUrl(t.qr),
        qrDownloadUrl: cloud.tagQrDownloadUrl(t.qr, downloadName(t)),
      }));
  });
};

const createTag = async (req, res) => {
  const body = req.body || {};
  const method = cleanMethod(body.method);
  const handle = cleanHandle(body.handle);
  await assertUnique(method, handle);
  const last = await Tag.findOne({ method }).sort({ sortOrder: -1 }).select("sortOrder").lean();
  const tag = await Tag.create({
    method,
    handle,
    name: text(body.name, 60, "Name", "INVALID_NAME"),
    note: text(body.note, 200, "Note", "INVALID_NOTE"),
    qr: req.file ? await uploadQr(req.file) : null,
    sortOrder: last ? last.sortOrder + 1 : 0,
  });
  await Promise.all([AuditLog.record(req.userId, "tag.create", "tag", tag._id, { method, handle }), bump(deps.tags)]);
  res.status(201).json(toAdminTag(tag));
};

// JSON or multipart: any of method/handle/name/note/active, a new `qr` file, or removeQr=true
const updateTag = async (req, res) => {
  const id = toObjectId(req.params.id, "tag id");
  const tag = await Tag.findById(id);
  if (!tag) throw new HttpError(404, "Tag not found", "NOT_FOUND");
  const body = req.body || {};

  if (body.method !== undefined) tag.method = cleanMethod(body.method);
  if (body.handle !== undefined) tag.handle = cleanHandle(body.handle);
  if (tag.isModified("method") || tag.isModified("handle")) await assertUnique(tag.method, tag.handle, tag._id);
  if (body.name !== undefined) tag.name = text(body.name, 60, "Name", "INVALID_NAME");
  if (body.note !== undefined) tag.note = text(body.note, 200, "Note", "INVALID_NOTE");
  if (body.active !== undefined) tag.active = toBool(body.active);

  const previousQr = tag.qr && tag.qr.publicId;
  if (req.file) tag.qr = await uploadQr(req.file);
  else if (toBool(body.removeQr)) tag.qr = null;

  // A new method puts the tag at the end of that method's list
  if (tag.isModified("method")) {
    const last = await Tag.findOne({ method: tag.method, _id: { $ne: tag._id } }).sort({ sortOrder: -1 }).select("sortOrder").lean();
    tag.sortOrder = last ? last.sortOrder + 1 : 0;
  }

  const changed = tag.modifiedPaths();
  if (changed.length) {
    await tag.save();
    if (previousQr && previousQr !== (tag.qr && tag.qr.publicId)) await releaseQr(previousQr);
    await Promise.all([AuditLog.record(req.userId, "tag.update", "tag", tag._id, { fields: changed }), bump(deps.tags)]);
  }
  res.json(toAdminTag(tag));
};

const deleteTag = async (req, res) => {
  const id = toObjectId(req.params.id, "tag id");
  const tag = await Tag.findByIdAndDelete(id);
  if (!tag) throw new HttpError(404, "Tag not found", "NOT_FOUND");
  await releaseQr(tag.qr && tag.qr.publicId);
  await Promise.all([
    AuditLog.record(req.userId, "tag.delete", "tag", tag._id, { method: tag.method, handle: tag.handle }),
    bump(deps.tags),
  ]);
  res.json({ id: tag._id });
};

// Swap with the neighbour in the same payment method; returns the changed [id, sortOrder] pairs
const moveTag = async (req, res) => {
  const id = toObjectId(req.params.id, "tag id");
  const tag = await Tag.findById(id).select("method").lean();
  if (!tag) throw new HttpError(404, "Tag not found", "NOT_FOUND");
  const tags = await Tag.find({ method: tag.method }).sort({ sortOrder: 1, createdAt: 1 }).select("_id sortOrder");
  const idx = tags.findIndex((t) => t._id.equals(id));
  const swapIdx = idx + (req.body && req.body.direction === "up" ? -1 : 1);
  if (swapIdx < 0 || swapIdx >= tags.length) return res.json({ changed: [] });

  // Normalise to 0..n-1 then swap, so duplicate sortOrder values can't block the move
  const ordered = tags.map((t) => t._id);
  [ordered[idx], ordered[swapIdx]] = [ordered[swapIdx], ordered[idx]];
  const ops = ordered
    .map((tid, i) => ({ tid, i, prev: tags.find((t) => t._id.equals(tid)).sortOrder }))
    .filter(({ i, prev }) => i !== prev)
    .map(({ tid, i }) => ({ updateOne: { filter: { _id: tid }, update: { $set: { sortOrder: i } } } }));
  if (ops.length) {
    await Tag.bulkWrite(ops);
    await bump(deps.tags);
  }
  res.json({ changed: ops.map((o) => [o.updateOne.filter._id, o.updateOne.update.$set.sortOrder]) });
};

module.exports = { adminListTags, listPublicTags, createTag, updateTag, deleteTag, moveTag };
