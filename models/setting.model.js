const mongoose = require("mongoose");

// Site-wide singletons by key, e.g. "popupBanner"
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Setting", settingSchema);
