const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const mongoose = require("mongoose");
const env = require("./config/env.js");
const app = require("./app.js");
const log = require("./utils/logger.js");

// Log every write to MongoDB (what was saved/changed/deleted); reads are left out to keep logs readable.
// Set LOG_DB=false to turn off, LOG_DB=all to include reads too.
const WRITE_OPS = /^(insert|update|replace|delete|findOneAndUpdate|findOneAndReplace|findOneAndDelete|bulkWrite|createIndex)/;
if (process.env.LOG_DB !== "false") {
  mongoose.set("debug", (collection, method, ...args) => {
    if (process.env.LOG_DB !== "all" && !WRITE_OPS.test(method)) return;
    log.info(`db ${collection}.${method}`, { args: log.compact(args) });
  });
}

if (!env.MONGO_URI) {
  console.error("MONGO_URI is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

mongoose
  .connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    // Compress traffic between the API and MongoDB (zlib is built into the driver)
    compressors: ["zlib"],
    // One small instance: a few sockets are plenty (driver default is 100)
    maxPoolSize: 10,
  })
  .then(() => {
    log.info("Connected to MongoDB");
    app.listen(env.PORT, () => log.info(`Server running on port ${env.PORT}`));
  })
  .catch((err) => {
    console.error("Connection error:", err.message);
    process.exit(1);
  });
