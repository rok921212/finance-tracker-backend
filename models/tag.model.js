const mongoose = require("mongoose");
const { PAYMENT_METHODS } = require("./payment.model.js");

// A payment tag players pay to (e.g. Cash App "$payme"), shown on the public /tags page
const tagSchema = new mongoose.Schema(
  {
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    // The copyable text: cashtag, email, phone...
    handle: { type: String, required: true, trim: true, maxlength: 100 },
    name: { type: String, trim: true, maxlength: 60, default: "" },
    note: { type: String, trim: true, maxlength: 200, default: "" },
    // Uploaded QR code (Cloudinary ref, like Game.image)
    qr: {
      type: new mongoose.Schema({ publicId: String, version: Number }, { _id: false }),
      default: null,
    },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Public page: find({active:true}) grouped by method, in admin order
tagSchema.index({ active: 1, method: 1, sortOrder: 1 });

module.exports = mongoose.model("Tag", tagSchema);
