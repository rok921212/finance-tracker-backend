const express = require("express");
const authMiddleware = require("../middleware/auth.middleware.js");
const { asyncHandler } = require("../utils/httpError.js");
const { listActiveGames } = require("../controllers/game.controller.js");

const router = express.Router();

router.get("/", authMiddleware, asyncHandler(listActiveGames));

module.exports = router;
