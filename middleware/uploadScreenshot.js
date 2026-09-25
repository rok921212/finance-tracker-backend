const multer = require("multer");
const { HttpError } = require("../utils/httpError.js");

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // same 5MB limit as the production uploader
// The cashout screenshot can be a tall full-page capture, so it gets a larger allowance
const MAX_CASHOUT_PROOF_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CASHOUT_PROOF_BYTES, files: 2 },
});

// Detect the real image format from the file's magic bytes; the client MIME type is not trusted
const detectImageFormat = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
  }
  return null;
};

const unsupported = (label) =>
  new HttpError(400, `Unsupported ${label} image type. Use AVIF, JPG, PNG or WebP`, "UNSUPPORTED_TYPE");

// Accepts the payment `screenshot` plus an optional `cashoutProof` image.
// Exposes them as req.file and req.cashoutProofFile (each with .detectedFormat, or null when absent).
// Both images are optional. On edit, omitting one keeps the current one.
const makeUpload = ({ requireScreenshot = false } = {}) => (req, res, next) => {
  upload.fields([
    { name: "screenshot", maxCount: 1 },
    { name: "cashoutProof", maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new HttpError(413, "Cashout screenshot is too large (max 10MB)", "FILE_TOO_LARGE"));
      }
      return next(new HttpError(400, "Invalid screenshot upload", "UPLOAD_INVALID"));
    }
    const screenshot = req.files && req.files.screenshot && req.files.screenshot[0];
    const cashoutProof = req.files && req.files.cashoutProof && req.files.cashoutProof[0];
    if (!screenshot && requireScreenshot) {
      return next(new HttpError(400, "Screenshot is required", "SCREENSHOT_REQUIRED"));
    }
    if (screenshot) {
      if (screenshot.size > MAX_SCREENSHOT_BYTES) {
        return next(new HttpError(413, "Screenshot is too large (max 5MB)", "FILE_TOO_LARGE"));
      }
      screenshot.detectedFormat = detectImageFormat(screenshot.buffer);
      if (!screenshot.detectedFormat) return next(unsupported("screenshot"));
    }
    if (cashoutProof) {
      cashoutProof.detectedFormat = detectImageFormat(cashoutProof.buffer);
      if (!cashoutProof.detectedFormat) return next(unsupported("cashout screenshot"));
    }
    req.file = screenshot || null;
    req.cashoutProofFile = cashoutProof || null;
    next();
  });
};

const uploadScreenshot = makeUpload();
const uploadOptionalScreenshot = makeUpload({ requireScreenshot: false });

module.exports = {
  uploadScreenshot,
  uploadOptionalScreenshot,
  detectImageFormat,
  MAX_SCREENSHOT_BYTES,
  MAX_CASHOUT_PROOF_BYTES,
};
