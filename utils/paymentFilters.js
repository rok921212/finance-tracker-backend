const User = require("../models/user.model.js");
const { PAYMENT_METHODS } = require("../models/payment.model.js");
const { HttpError } = require("./httpError.js");
const { parseDay, toObjectId, escapeRegex } = require("./validation.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// "a,b,,a" -> ["a", "b"]: trimmed, de-duplicated, capped so a query can't grow unbounded
const listParam = (v, max = 50) => [...new Set(String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, max);

// { date } condition for ?dateFrom / ?dateTo (both optional, dateTo inclusive of the whole day)
const dateRangeMatch = (query) => {
  if (!query.dateFrom && !query.dateTo) return {};
  const date = {};
  if (query.dateFrom) date.$gte = parseDay(query.dateFrom, "dateFrom");
  if (query.dateTo) date.$lt = new Date(parseDay(query.dateTo, "dateTo").getTime() + DAY_MS);
  return { date };
};

// Condition for ?player: player names or payment tags starting with the text, ignoring case ("mike" matches
// "Mike1714mw"). A tag's leading $ is optional, so "payme" and "$payme" both find "$payme".
const playerMatch = (query) => {
  const text = String(query.player ?? "").trim().slice(0, 60);
  if (!text) return {};
  const start = escapeRegex(text);
  return {
    $or: [
      { player: { $regex: "^" + start, $options: "i" } },
      { paymentTag: { $regex: "^\\$?" + start, $options: "i" } },
    ],
  };
};

/**
 * Builds a Payment $match from whitelisted query params.
 * Shared by the admin list, summaries and CSV export so they always agree.
 */
const buildPaymentFilter = async (query) => {
  const match = { ...dateRangeMatch(query), ...playerMatch(query) };

  if (query.gameId) match.gameId = toObjectId(query.gameId, "gameId");

  // One or more methods, comma-separated
  const methods = listParam(query.paymentMethod);
  if (methods.length) {
    if (methods.some((m) => !PAYMENT_METHODS.includes(m))) throw new HttpError(400, "Invalid paymentMethod", "INVALID_PAYMENT_METHOD");
    match.paymentMethod = methods.length === 1 ? methods[0] : { $in: methods };
  }

  // Game-backend usernames, comma-separated; exact match ignoring case ("zyron" matches "Zyron")
  const gameUsernames = listParam(query.gameUsername);
  if (gameUsernames.length) {
    match.gameUsername = { $in: gameUsernames.map((n) => new RegExp("^" + escapeRegex(n.slice(0, 60)) + "$", "i")) };
  }

  if (query.userId) {
    match.userId = toObjectId(query.userId, "userId");
  } else if (query.search && String(query.search).trim()) {
    const users = await User.find({
      username: { $regex: "^" + escapeRegex(String(query.search).trim().slice(0, 30)), $options: "i" },
    })
      .select("_id")
      .limit(50)
      .lean();
    match.userId = { $in: users.map((u) => u._id) };
  }

  return match;
};

module.exports = { buildPaymentFilter, dateRangeMatch, listParam, playerMatch };
