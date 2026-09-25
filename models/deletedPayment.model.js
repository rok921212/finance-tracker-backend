const mongoose = require("mongoose");

// Tombstone for a permanently deleted payment, so delta-sync clients learn it is gone.
// Kept for TOMBSTONE_TTL_S; a client whose cursor is older than that does a full reload instead.
const TOMBSTONE_TTL_S = 7 * 24 * 60 * 60;

const deletedPaymentSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deletedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false }
);

deletedPaymentSchema.index({ deletedAt: 1 }, { expireAfterSeconds: TOMBSTONE_TTL_S });
deletedPaymentSchema.index({ userId: 1, deletedAt: 1 });

module.exports = mongoose.model("DeletedPayment", deletedPaymentSchema);
module.exports.TOMBSTONE_TTL_S = TOMBSTONE_TTL_S;
