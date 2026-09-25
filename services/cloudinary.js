const cloudinary = require("cloudinary").v2;
const env = require("../config/env.js");
const { HttpError } = require("../utils/httpError.js");

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
  analytics: false, // keep delivery URLs clean (no ?_a= tracking param)
});

const FOLDER = "payments";
const MAX_DIMENSION = 1600;

// Read width/height from the AVIF 'ispe' property box (no image decoding needed)
const getAvifDimensions = (buf) => {
  const idx = buf.indexOf("ispe", 0, "ascii");
  if (idx === -1 || idx + 16 > buf.length) return null;
  // box type (4) + version/flags (4) + width (4) + height (4)
  return { width: buf.readUInt32BE(idx + 8), height: buf.readUInt32BE(idx + 12) };
};

const publicIdForHash = (hash) => `${FOLDER}/${hash}`;

/**
 * Upload a screenshot with a deterministic public_id derived from its SHA-256 hash,
 * so identical bytes always map to the same Cloudinary asset.
 * Non-AVIF or oversized images are resized and stored as AVIF; an already small AVIF
 * is stored as-is to avoid recompressing an optimized file.
 */
const uploadScreenshot = (buffer, hash, format) => {
  const options = {
    public_id: publicIdForHash(hash),
    overwrite: false,
    unique_filename: false,
    resource_type: "image",
  };

  const dims = format === "avif" ? getAvifDimensions(buffer) : null;
  const alreadyOptimized = dims && dims.width <= MAX_DIMENSION && dims.height <= MAX_DIMENSION;
  if (!alreadyOptimized) {
    options.format = "avif";
    options.transformation = [
      { width: MAX_DIMENSION, height: MAX_DIMENSION, crop: "limit", quality: "auto" },
    ];
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        return reject(new HttpError(502, "Screenshot upload failed", "UPLOAD_FAILED"));
      }
      resolve({ publicId: result.public_id, version: result.version, existing: !!result.existing });
    });
    stream.end(buffer);
  });
};

const CASHOUT_FOLDER = `${FOLDER}/cashout`;

/**
 * Cashout screenshot, stored next to the payment screenshots. It can be a tall capture, so only
 * the width is limited (never the height) and the original format is kept (AVIF caps dimensions).
 */
const uploadCashoutProof = (buffer, hash) =>
  new Promise((resolve, reject) => {
    const options = {
      public_id: `${CASHOUT_FOLDER}/${hash}`,
      overwrite: false,
      unique_filename: false,
      resource_type: "image",
      transformation: [{ width: MAX_DIMENSION, crop: "limit", quality: "auto" }],
    };
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        return reject(new HttpError(502, "Cashout screenshot upload failed", "UPLOAD_FAILED"));
      }
      resolve({ publicId: result.public_id, version: result.version, existing: !!result.existing });
    });
    stream.end(buffer);
  });

const destroy = (publicId) =>
  cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });

// Delivery URLs are derived on read; only publicId/version are stored in MongoDB
const deliveryUrl = (ref, transformation) =>
  ref && ref.publicId ? cloudinary.url(ref.publicId, { secure: true, version: ref.version, transformation: [transformation] }) : null;

/** Square thumbnail. `size` is the pixel size (2x the CSS size it is shown at). */
const thumbUrl = (ref, size = 160) =>
  deliveryUrl(ref, { width: size, height: size, crop: "fill", quality: "auto", fetch_format: "auto" });

const fullUrl = (ref) => deliveryUrl(ref, { width: MAX_DIMENSION, crop: "limit", quality: "auto", fetch_format: "auto" });

const urls = (ref) => ({ thumb: thumbUrl(ref), full: fullUrl(ref) });

module.exports = { uploadScreenshot, uploadCashoutProof, destroy, urls, thumbUrl, fullUrl, publicIdForHash, getAvifDimensions };
