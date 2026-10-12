const express = require("express");
const authMiddleware = require("../middleware/auth.middleware.js");
const requireAdmin = require("../middleware/requireAdmin.js");
const { asyncHandler } = require("../utils/httpError.js");
const admin = require("../controllers/admin.controller.js");
const games = require("../controllers/game.controller.js");
const banner = require("../controllers/banner.controller.js");
const tags = require("../controllers/tag.controller.js");
const { uploadSingleImage } = require("../middleware/uploadImage.js");

const router = express.Router();

// Backend-enforced: every admin API requires a valid token AND the admin role in the database
router.use(authMiddleware, requireAdmin);

router.get("/summary", asyncHandler(admin.summary));

router.get("/payments", asyncHandler(admin.listPayments));
router.get("/payments/export.csv", asyncHandler(admin.exportCsv));
router.get("/payments/export.pdf", asyncHandler(admin.exportPdf));
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
router.post("/games/:id/image", uploadSingleImage("image"), asyncHandler(games.uploadGameImage));
router.delete("/games/:id/image", asyncHandler(games.removeGameImage));

router.get("/banner", asyncHandler(banner.adminGetBanner));
router.post("/banner", uploadSingleImage("image"), asyncHandler(banner.adminUploadBanner));
router.patch("/banner", asyncHandler(banner.adminUpdateBanner));
router.delete("/banner", asyncHandler(banner.adminDeleteBanner));

const optionalQr = uploadSingleImage("qr", { required: false });
router.get("/tags", asyncHandler(tags.adminListTags));
router.post("/tags", optionalQr, asyncHandler(tags.createTag));
router.patch("/tags/:id", optionalQr, asyncHandler(tags.updateTag));
router.delete("/tags/:id", asyncHandler(tags.deleteTag));
router.post("/tags/:id/move", asyncHandler(tags.moveTag));

router.get("/audit", asyncHandler(admin.listAudit));

module.exports = router;
