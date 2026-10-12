const mongoose = require("mongoose");

// One slice of the public Wheel of Fortune (/wheel), in admin order
const wheelSegmentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 40 },
    // Reward text shown under the label, e.g. "$50" or "10 Free Spins"; empty = label only
    amount: { type: String, trim: true, maxlength: 30, default: "" },
    color: { type: String, match: /^#[0-9a-fA-F]{6}$/, default: "#dc2626" },
    // Optional picture inside the slice (Cloudinary ref, like Tag.qr)
    image: {
      type: new mongoose.Schema({ publicId: String, version: Number }, { _id: false }),
      default: null,
    },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

wheelSegmentSchema.index({ active: 1, sortOrder: 1 });

module.exports = mongoose.model("WheelSegment", wheelSegmentSchema);
