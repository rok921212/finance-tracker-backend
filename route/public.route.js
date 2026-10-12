const express = require("express");
const rateLimit = require("express-rate-limit");
const env = require("../config/env.js");
const { asyncHandler } = require("../utils/httpError.js");
const { listPublicGames } = require("../controllers/game.controller.js");
const { getPublicBanner } = require("../controllers/banner.controller.js");
const { listPublicTags } = require("../controllers/tag.controller.js");
const { getPublicWheel, spinWheel } = require("../controllers/wheel.controller.js");

const router = express.Router();

// No login: anyone with the public link can read these, so keep a per-IP ceiling
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => env.isTest,
    message: { message: "Too many requests. Please try again later.", code: "RATE_LIMITED" },
  })
);

router.get("/games", asyncHandler(listPublicGames));
router.get("/banner", asyncHandler(getPublicBanner));
router.get("/tags", asyncHandler(listPublicTags));
router.get("/wheel", asyncHandler(getPublicWheel));

// Spinning writes to the database: a much tighter per-IP ceiling than the reads above
const spinLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { message: "Too many spins. Please slow down.", code: "RATE_LIMITED" },
});
router.post("/wheel/spin", spinLimit, asyncHandler(spinWheel));

module.exports = router;
