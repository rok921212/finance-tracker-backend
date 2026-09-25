const mongoose = require("mongoose");

// One row per user edit of a payment: which fields changed, from what to what.
// Game names are stored as they were at edit time, so later renames don't rewrite history.
const paymentEditSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    changes: [
      new mongoose.Schema(
        { field: { type: String, required: true }, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed },
        { _id: false }
      ),
    ],
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

paymentEditSchema.index({ userId: 1, createdAt: -1 });
paymentEditSchema.index({ paymentId: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentEdit", paymentEditSchema);
