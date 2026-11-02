const mongoose = require("mongoose");

// A login for a game's backend (admin only). A game can have several. The password is stored
// encrypted (services/secretBox.js) and is only returned by the admin "reveal" endpoint.
const boxSchema = new mongoose.Schema(
  { iv: { type: String, required: true }, tag: { type: String, required: true }, data: { type: String, required: true } },
  { _id: false }
);

const gameCredentialSchema = new mongoose.Schema(
  {
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true },
    label: { type: String, trim: true, maxlength: 60 },
    username: { type: String, trim: true, required: true, maxlength: 100 },
    password: { type: boxSchema, required: true },
    notes: { type: String, trim: true, maxlength: 300 },
    // Optional links: the game backend's admin panel and the player-facing game page
    adminUrl: { type: String, trim: true, maxlength: 500 },
    gameUrl: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, versionKey: false }
);

gameCredentialSchema.index({ gameId: 1, createdAt: 1 });

module.exports = mongoose.model("GameCredential", gameCredentialSchema);
