const express = require("express");
const rateLimit = require("express-rate-limit");
const env = require("../config/env.js");
const authMiddleware = require("../middleware/auth.middleware.js");
const { uploadScreenshot, uploadOptionalScreenshot } = require("../middleware/uploadScreenshot.js");
const { asyncHandler } = require("../utils/httpError.js");
const {
  createPayment,
  updatePayment,
  listMyPayments,
  myChanges,
  mySummary,
  getMyPayment,
  deleteMyPayment,
} = require("../controllers/payment.controller.js");

const router = express.Router();

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { message: "Too many entries submitted. Please try again later.", code: "RATE_LIMITED" },
});

// Every route is scoped to the authenticated user (req.userId)
router.use(authMiddleware);

router.post("/", createLimiter, uploadScreenshot, asyncHandler(createPayment));
router.get("/", asyncHandler(listMyPayments));
router.get("/summary", asyncHandler(mySummary));
router.get("/changes", asyncHandler(myChanges));
router.get("/:id", asyncHandler(getMyPayment));
router.patch("/:id", createLimiter, uploadOptionalScreenshot, asyncHandler(updatePayment));
router.delete("/:id", asyncHandler(deleteMyPayment));

module.exports = router;
