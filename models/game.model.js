const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Points pool in cents; each entry's "loaded" is taken from it. null = unlimited
    totalPoints: { type: Number, default: null, min: 0 },
  },
  { timestamps: true }
);

// Active-game dropdown: find({active:true}).sort({sortOrder:1})
gameSchema.index({ active: 1, sortOrder: 1 });

gameSchema.statics.slugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

module.exports = mongoose.model("Game", gameSchema);
