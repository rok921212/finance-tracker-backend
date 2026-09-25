const express = require("express");
const authMiddleware = require("../middleware/auth.middleware.js");
const requireAdmin = require("../middleware/requireAdmin.js");
const { asyncHandler } = require("../utils/httpError.js");
const admin = require("../controllers/admin.controller.js");
const games = require("../controllers/game.controller.js");

const router = express.Router();

// Backend-enforced: every admin API requires a valid token AND the admin role in the database
router.use(authMiddleware, requireAdmin);

router.get("/summary", asyncHandler(admin.summary));

router.get("/payments", asyncHandler(admin.listPayments));
router.get("/payments/export.csv", asyncHandler(admin.exportCsv));
router.get("/payments/changes", asyncHandler(admin.paymentChanges));
router.get("/payments/:id", asyncHandler(admin.getPayment));
router.delete("/payments/:id", asyncHandler(admin.deletePayment));
router.get("/edits", asyncHandler(admin.listEdits));

router.get("/users", asyncHandler(admin.listUsers));
router.post("/users", asyncHandler(admin.createUser));
router.patch("/users/:id/role", asyncHandler(admin.updateUserRole));
router.patch("/users/:id", asyncHandler(admin.updateUser));
router.delete("/users/:id", asyncHandler(admin.deleteUser));
router.get("/users/:id/summary", asyncHandler(admin.userSummary));

router.get("/games", asyncHandler(games.adminListGames));
router.get("/games/summary", asyncHandler(admin.gamesSummary));
router.post("/games", asyncHandler(games.createGame));
router.patch("/games/:id", asyncHandler(games.updateGame));
router.post("/games/:id/move", asyncHandler(games.moveGame));

router.get("/audit", asyncHandler(admin.listAudit));

module.exports = router;
