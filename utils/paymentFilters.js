const User = require("../models/user.model.js");
const { parseDay, toObjectId, escapeRegex } = require("./validation.js");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Builds a Payment $match from whitelisted query params.
 * Shared by the admin list, summaries and CSV export so they always agree.
 */
const buildPaymentFilter = async (query) => {
  const match = {};

  if (query.dateFrom || query.dateTo) {
    match.date = {};
    if (query.dateFrom) match.date.$gte = parseDay(query.dateFrom, "dateFrom");
    // dateTo is inclusive of the whole day
    if (query.dateTo) match.date.$lt = new Date(parseDay(query.dateTo, "dateTo").getTime() + DAY_MS);
  }

  if (query.gameId) match.gameId = toObjectId(query.gameId, "gameId");

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

module.exports = { buildPaymentFilter };
