const Payment = require("../models/payment.model.js");

// Points a game has handed out ("loaded") and taken back ("redeemed") across every entry.
// Computed from payments (not stored), so edit/delete need no bookkeeping.
// Returns Map<gameId, { used, redeemed }>
const pointsUsed = async (gameIds, excludePaymentId) => {
  const match = { gameId: { $in: gameIds } };
  if (excludePaymentId) match._id = { $ne: excludePaymentId };
  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: "$gameId", used: { $sum: "$loaded" }, redeemed: { $sum: { $ifNull: ["$redeemed", 0] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { used: r.used, redeemed: r.redeemed }]));
};

// totalPoints null = unlimited (no pool set). Redeemed points go back into the pool.
const withPoints = (game, { used = 0, redeemed = 0 } = {}) => ({
  totalPoints: game.totalPoints ?? null,
  used,
  redeemed,
  remaining: game.totalPoints == null ? null : game.totalPoints - used + redeemed,
});

module.exports = { pointsUsed, withPoints };
