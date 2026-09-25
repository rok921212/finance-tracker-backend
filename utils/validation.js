const mongoose = require("mongoose");
const { HttpError } = require("./httpError.js");

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "450.5" -> 45050, parsed as strings so no floating point is involved
const parseToCents = (value, field) => {
  const str = String(value ?? "").trim();
  if (!AMOUNT_RE.test(str)) {
    throw new HttpError(400, `${field} must be a positive amount with up to 2 decimals`, "INVALID_AMOUNT");
  }
  const [whole, frac = ""] = str.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
};

// "YYYY-MM-DD" -> Date at UTC midnight; rejects impossible dates like 2026-02-31
const parseDay = (value, field = "date") => {
  const m = DAY_RE.exec(String(value ?? "").trim());
  if (!m) throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD)`, "INVALID_DATE");
  const [, y, mo, d] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD)`, "INVALID_DATE");
  }
  return date;
};

const toObjectId = (value, field = "id") => {
  if (!mongoose.isValidObjectId(value) || String(value).length !== 24) {
    throw new HttpError(400, `Invalid ${field}`, "INVALID_ID");
  }
  return new mongoose.Types.ObjectId(String(value));
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePagination = (query, { defaultLimit = 20, maxLimit = 50 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const pageResult = (items, total, { page, limit }) => ({
  items,
  total,
  page,
  pages: Math.max(1, Math.ceil(total / limit)),
});

module.exports = { parseToCents, parseDay, toObjectId, escapeRegex, parsePagination, pageResult };
