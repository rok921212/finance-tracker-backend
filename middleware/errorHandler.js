const env = require("../config/env.js");
const log = require("../utils/logger.js");

// Central error handler: consistent {message, code} responses, no stack traces to clients
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ message: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ message: "Invalid data", code: "VALIDATION_ERROR" });
  }
  if (err.name === "CastError") {
    return res.status(400).json({ message: "Invalid id", code: "INVALID_ID" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request too large", code: "TOO_LARGE" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Malformed JSON", code: "BAD_JSON" });
  }
  if (!env.isTest) log.error(`Unhandled error in ${req.method} ${req.originalUrl}`, { id: req.id, error: err.stack || String(err) });
  res.status(500).json({ message: "Internal server error", code: "SERVER_ERROR" });
};

module.exports = errorHandler;
