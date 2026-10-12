const mongoose = require("mongoose");

const RETENTION_DAYS = 90;

// One public spin: what the visitor won. Only a hash of the IP is kept (for the cooldown)
const wheelSpinSchema = new mongoose.Schema(
  {
    segmentId: { type: mongoose.Schema.Types.ObjectId, ref: "WheelSegment" },
    label: { type: String, default: "" },
    amount: { type: String, default: "" },
    // True when the admin had picked where the wheel lands
    forced: { type: Boolean, default: false },
    ipHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

wheelSpinSchema.index({ ipHash: 1, createdAt: -1 });
wheelSpinSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model("WheelSpin", wheelSpinSchema);
