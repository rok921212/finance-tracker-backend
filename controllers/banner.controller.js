const crypto = require("crypto");
const Setting = require("../models/setting.model.js");
const AuditLog = require("../models/auditLog.model.js");
const { HttpError } = require("../utils/httpError.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const cloud = require("../services/cloudinary.js");

// Popup shown when the public games page loads: { image: {publicId, version}, enabled, link }
const KEY = "popupBanner";

const readBanner = async () => {
  const doc = await Setting.findOne({ key: KEY }).lean();
  return doc && doc.value ? doc.value : null;
};

const toAdminBanner = (b) => ({
  imageUrl: b ? cloud.bannerUrl(b.image) : null,
  enabled: !!(b && b.enabled),
  link: (b && b.link) || "",
});

const cleanLink = (link) => {
  const l = String(link ?? "").trim();
  if (!l) return "";
  let url;
  try {
    url = new URL(l);
  } catch {
    throw new HttpError(400, "Banner link must be a full http(s) URL", "INVALID_LINK");
  }
  if (!["http:", "https:"].includes(url.protocol) || l.length > 500) {
    throw new HttpError(400, "Banner link must be a full http(s) URL", "INVALID_LINK");
  }
  return l;
};

// Saves the new value, audits it and pushes the change to every cached reader
const save = async (req, value, metadata) => {
  const doc = await Setting.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true, new: true });
  await Promise.all([AuditLog.record(req.userId, "banner.update", "setting", doc._id, metadata), bump(deps.banner)]);
  return value;
};

// No login. null when there is no banner or it is turned off
const getPublicBanner = async (req, res) => {
  await sendCached(req, res, { name: "public-banner", deps: [deps.banner] }, async () => {
    const b = await readBanner();
    return b && b.enabled && b.image ? { imageUrl: cloud.bannerUrl(b.image), link: b.link || "" } : null;
  });
};

const adminGetBanner = async (req, res) => {
  res.json(toAdminBanner(await readBanner()));
};

// A new image replaces the old one; a first upload is switched on right away
const adminUploadBanner = async (req, res) => {
  const current = await readBanner();
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const up = await cloud.uploadBanner(req.file.buffer, hash);
  const next = {
    image: { publicId: up.publicId, version: up.version },
    enabled: current && current.image ? !!current.enabled : true,
    link: (current && current.link) || "",
  };
  if (req.body.link !== undefined) next.link = cleanLink(req.body.link);
  await save(req, next, { action: "upload" });
  const previous = current && current.image && current.image.publicId;
  if (previous && previous !== up.publicId) cloud.destroy(previous).catch(() => {});
  res.json(toAdminBanner(next));
};

const adminUpdateBanner = async (req, res) => {
  const current = await readBanner();
  if (!current || !current.image) throw new HttpError(400, "Upload a banner image first", "NO_BANNER");
  const body = req.body || {};
  const next = { ...current };
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.link !== undefined) next.link = cleanLink(body.link);
  await save(req, next, { action: "update", enabled: next.enabled, link: next.link });
  res.json(toAdminBanner(next));
};

const adminDeleteBanner = async (req, res) => {
  const current = await readBanner();
  if (current && current.image) {
    await save(req, null, { action: "remove" });
    cloud.destroy(current.image.publicId).catch(() => {});
  }
  res.json(toAdminBanner(null));
};

module.exports = { getPublicBanner, adminGetBanner, adminUploadBanner, adminUpdateBanner, adminDeleteBanner };
