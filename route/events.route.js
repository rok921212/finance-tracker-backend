const express = require("express");
const authMiddleware = require("../middleware/auth.middleware.js");
const { asyncHandler } = require("../utils/httpError.js");
const { openStream } = require("../controllers/events.controller.js");

const router = express.Router();

// One long-lived stream per open tab: data-version bumps are pushed instead of polled
router.get("/", authMiddleware, asyncHandler(openStream));

module.exports = router;
