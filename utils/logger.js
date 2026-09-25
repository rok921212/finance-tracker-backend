const env = require("../config/env.js");

/**
 * Minimal structured logger (one JSON line per event in production, readable lines in development).
 * Secrets are redacted before anything is written.
 */

const SECRET_KEYS = /^(password|newpassword|oldpassword|token|authorization|cookie|adminauthcode|jwt|secret|api_?key|api_?secret)$/i;
const MAX_LEN = Number(process.env.LOG_MAX_BODY) || 2000;

const redact = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (typeof value !== "object") return value;
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((v) => redact(v, depth + 1));
    if (value.length > 20) out.push(`…${value.length - 20} more`);
    return out;
  }
  if (typeof value.toHexString === "function") return value.toHexString(); // ObjectId
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  return out;
};

/** Stringify (after redaction) and cap the size so a big payload can't flood the log. */
const compact = (value) => {
  if (value === undefined || value === "") return undefined;
  let s;
  if (typeof value === "string") {
    try {
      s = JSON.stringify(redact(JSON.parse(value)));
    } catch {
      s = value;
    }
  } else {
    s = JSON.stringify(redact(value));
  }
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…(+${s.length - MAX_LEN} chars)` : s;
};

const write = (level, msg, fields = {}) => {
  if (env.isTest && !process.env.LOG_IN_TESTS) return;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (env.isProd) {
    out(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  } else {
    const extra = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    out(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? " " + extra : ""}`);
  }
};

module.exports = {
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
  redact,
  compact,
};
