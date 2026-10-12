const multer = require("multer");
const { HttpError } = require("../utils/httpError.js");
const { detectImageFormat, MAX_SCREENSHOT_BYTES } = require("./uploadScreenshot.js");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCREENSHOT_BYTES, files: 1 },
});

// One image in `field`, exposed as req.file with .detectedFormat (magic bytes, not the client MIME).
// When not required and no file is sent, req.file is null.
const uploadSingleImage = (field, { required = true } = {}) => (req, res, next) => {
  upload.single(field)(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "Image is too large (max 5MB)", "FILE_TOO_LARGE"));
      return next(new HttpError(400, "Invalid image upload", "UPLOAD_INVALID"));
    }
    if (!req.file) {
      if (required) return next(new HttpError(400, "Image is required", "IMAGE_REQUIRED"));
      req.file = null;
      return next();
    }
    req.file.detectedFormat = detectImageFormat(req.file.buffer);
    if (!req.file.detectedFormat) {
      return next(new HttpError(400, "Unsupported image type. Use AVIF, JPG, PNG or WebP", "UNSUPPORTED_TYPE"));
    }
    next();
  });
};

module.exports = { uploadSingleImage };
