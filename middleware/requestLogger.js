const crypto = require("crypto");
const log = require("../utils/logger.js");

const LOG_BODIES = process.env.LOG_BODIES !== "false";

/**
 * Logs every API request and its response: method, path, user, status, duration,
 * request data (body/query/uploaded file metadata) and the response body — secrets redacted.
 * Each request gets an id (also sent back as X-Request-Id) to match log lines to a client report.
 */
const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();
  req.id = req.headers["x-request-id"] || crypto.randomUUID().slice(0, 8);
  res.set("X-Request-Id", req.id);

  // Capture the response body whichever way it is sent (res.json calls res.send internally)
  let responseBody;
  const send = res.send;
  res.send = function (body) {
    if (responseBody === undefined) responseBody = body;
    return send.call(this, body);
  };

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    const fields = {
      id: req.id,
      status,
      ms: Math.round(ms),
      user: req.username ? `${req.username}(${req.userId})` : undefined,
      ip: req.ip,
    };
    if (LOG_BODIES) {
      fields.query = Object.keys(req.query || {}).length ? log.compact(req.query) : undefined;
      fields.req = req.body && Object.keys(req.body).length ? log.compact(req.body) : undefined;
      fields.file = req.file ? `${req.file.originalname} ${req.file.mimetype} ${req.file.size}B` : undefined;
      const isJson = /json/.test(res.get("Content-Type") || "");
      // Pre-gzipped cached bodies are Buffers: log their size, not their bytes
      fields.res = status === 304 ? undefined : Buffer.isBuffer(responseBody) ? `<${responseBody.length}B ${res.get("Content-Encoding") || "binary"}>` : isJson ? log.compact(responseBody) : responseBody ? `<${res.get("Content-Type") || "body"}>` : undefined;
    }
    if (res.locals.authError) fields.auth = res.locals.authError;
    log[level](`${req.method} ${req.originalUrl}`, fields);
  });

  next();
};

module.exports = requestLogger;
