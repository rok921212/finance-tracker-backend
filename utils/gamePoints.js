const Payment = require("../models/payment.model.js");

// Points a game has handed out: the "loaded" amount of every entry.
// Computed from payments (not stored), so edit/delete need no bookkeeping.
const pointsUsed = async (gameIds, excludePaymentId) => {
  const match = { gameId: { $in: gameIds } };
  if (excludePaymentId) match._id = { $ne: excludePaymentId };
  const rows = await Payment.aggregate([{ $match: match }, { $group: { _id: "$gameId", used: { $sum: "$loaded" } } }]);
  return new Map(rows.map((r) => [String(r._id), r.used]));
};

// totalPoints null = unlimited (no pool set)
const withPoints = (game, used = 0) => ({
  totalPoints: game.totalPoints ?? null,
  used,
  remaining: game.totalPoints == null ? null : game.totalPoints - used,
});

module.exports = { pointsUsed, withPoints };
