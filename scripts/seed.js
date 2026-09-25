// Idempotent seed: initial games + the single admin account (from ADMIN_USERNAME / ADMIN_PASSWORD)
const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const env = require("../config/env.js");
const Game = require("../models/game.model.js");
const User = require("../models/user.model.js");

const INITIAL_GAMES = ["Juwa", "Orion Stars", "VBlink", "Ultra Panda", "Fire Kirin", "Panda Master", "Game Room"];

const run = async () => {
  if (!env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(env.MONGO_URI);

  // Migration: "tips" was renamed to "cashout" (amount + optional screenshot). Idempotent.
  const renamed = await mongoose.connection.db.collection("payments").updateMany(
    { $or: [{ tips: { $exists: true } }, { tipsProof: { $exists: true } }, { tipsProofHash: { $exists: true } }] },
    { $rename: { tips: "cashout", tipsProof: "cashoutProof", tipsProofHash: "cashoutProofHash" } }
  );
  if (renamed.modifiedCount) console.log(`Migrated tips -> cashout on ${renamed.modifiedCount} payment(s)`);

  // Storage cleanup: unused user text fields and version keys the schemas no longer write. Idempotent.
  const userCleanup = await User.collection.updateMany(
    { $or: [{ textField1: { $exists: true } }, { textField2: { $exists: true } }, { textField3: { $exists: true } }, { textField4: { $exists: true } }, { __v: { $exists: true } }] },
    { $unset: { textField1: "", textField2: "", textField3: "", textField4: "", __v: "" } }
  );
  if (userCleanup.modifiedCount) console.log(`Removed unused fields from ${userCleanup.modifiedCount} user(s)`);
  const bookingCleanup = await require("../models/booking.model.js").collection.updateMany(
    { __v: { $exists: true } },
    { $unset: { __v: "" } }
  );
  if (bookingCleanup.modifiedCount) console.log(`Removed version keys from ${bookingCleanup.modifiedCount} booking team(s)`);

  for (const [i, name] of INITIAL_GAMES.entries()) {
    const slug = Game.slugify(name);
    const res = await Game.updateOne(
      { slug },
      { $setOnInsert: { name, slug, active: true, sortOrder: i } },
      { upsert: true }
    );
    console.log(`${res.upsertedCount ? "Created" : "Exists "} game: ${name}`);
  }

  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    if (env.ADMIN_PASSWORD.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters");
    const password = await bcrypt.hash(env.ADMIN_PASSWORD, 10);
    await User.updateOne(
      { username: env.ADMIN_USERNAME },
      { $set: { password, role: "admin" }, $setOnInsert: { username: env.ADMIN_USERNAME } },
      { upsert: true }
    );
    console.log(`Admin account ready: ${env.ADMIN_USERNAME}`);
  } else {
    console.log("ADMIN_USERNAME / ADMIN_PASSWORD not set; skipping admin account");
  }

  // Build indexes for the new collections
  await Promise.all([
    Game.syncIndexes(),
    require("../models/payment.model.js").syncIndexes(),
    require("../models/auditLog.model.js").syncIndexes(),
    require("../models/booking.model.js").syncIndexes(),
    require("../models/deletedPayment.model.js").syncIndexes(),
  ]);
  // Games may have changed outside the API: invalidate cached game lists
  await require("../services/cache.js").bump("games");
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Seed failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
