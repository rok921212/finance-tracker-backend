const mongoose = require("mongoose");

const cents = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: "Amount must be an integer number of cents" },
};

const PAYMENT_METHODS = ["cashapp", "venmo", "paypal", "zelle", "applepay"];

const paymentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true },
    // Required for new entries (enforced in the controller); older entries have none
    paymentMethod: { type: String, enum: PAYMENT_METHODS },
    // Name the player used to load points
    player: { type: String, trim: true, maxlength: 60 },
    // Calendar day, stored as UTC midnight
    date: { type: Date, required: true },
    // Money is stored as integer minor units (cents) to avoid floating point errors
    deposit: cents,
    loaded: cents,
    // Cashed out; optional on entry, older entries have none (treated as 0)
    redeemed: { ...cents, required: false, default: 0 },
    // Cashout amount (optional, 0 when none), with an optional screenshot as proof
    cashout: { ...cents, required: false, default: 0 },
    cashoutProof: {
      type: new mongoose.Schema({ publicId: { type: String, required: true }, version: Number }, { _id: false }),
      required: false,
    },
    cashoutProofHash: { type: String },
    // Optional payment screenshot. Only the Cloudinary reference is stored; URLs are derived on read
    screenshot: {
      type: new mongoose.Schema({ publicId: { type: String, required: true }, version: Number }, { _id: false }),
      required: false,
    },
    screenshotHash: { type: String },
    // Last time the user edited the entry; the full history is in PaymentEdit
    editedAt: { type: Date },
    // Set when the user deletes the entry: hidden on the user side only, the admin keeps
    // seeing it (so entries can't be removed to cheat). Only an admin deletes permanently.
    userDeletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

// Indexes match the real query patterns: per-user history, admin filters, dedup lookup
paymentSchema.index({ userId: 1, date: -1 });
paymentSchema.index({ gameId: 1, date: -1 });
paymentSchema.index({ date: -1 });
// Dedup / reuse lookups by image hash. Partial: entries without that image take no index space
const hasField = (field) => ({ partialFilterExpression: { [field]: { $exists: true } } });
paymentSchema.index({ screenshotHash: 1 }, hasField("screenshotHash"));
paymentSchema.index({ cashoutProofHash: 1 }, hasField("cashoutProofHash"));
// Delta sync ("what changed since X") for a user and for the admin view
paymentSchema.index({ userId: 1, updatedAt: 1 });
paymentSchema.index({ updatedAt: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
