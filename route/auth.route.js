const express = require("express");
const router = express.Router();
const { register, login, adminLogin, setAdminRole, getCurrentUser } = require("../controllers/auth.controller.js");
const authMiddleware = require("../middleware/auth.middleware.js");

// Public routes
router.post("/register", register);
router.post("/login", login);
router.post("/admin/login", adminLogin);
router.post("/admin/set-role", setAdminRole);

// Protected routes
router.get("/me", authMiddleware, getCurrentUser);

module.exports = router;
