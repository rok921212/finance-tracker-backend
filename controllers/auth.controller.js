const User = require("../models/user.model.js");
const AuditLog = require("../models/auditLog.model.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, REGISTER_CODE } = require("../config/env.js");
const { sendCached, bump, deps } = require("../services/cache.js");

const signToken = (user) =>
  jwt.sign({ userId: user._id, username: user.username, tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: "24h" });

const publicUser = (user) => ({ id: user._id, username: user.username, role: user.role || "user" });

// Register a new user
const register = async (req, res) => {
  try {
    const { username, password, adminAuthCode } = req.body;

    // Validate input
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    if (username.length < 3) {
      return res.status(400).json({ message: "Username must be at least 3 characters" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    // Validate registration code (kept as `adminAuthCode` for frontend compatibility)
    if (!adminAuthCode) {
      return res.status(400).json({ message: "Admin auth code is required" });
    }

    if (!REGISTER_CODE || adminAuthCode !== REGISTER_CODE) {
      return res.status(400).json({ message: "Invalid admin auth code" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: "Username already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Self-registered accounts are always regular users
    const user = new User({
      username,
      password: hashedPassword,
      role: "user",
    });

    await user.save();
    await bump(deps.users);

    res.status(201).json({
      message: "User registered successfully",
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const checkCredentials = async (username, password) => {
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return null;
  }
  const user = await User.findOne({ username });
  if (!user) return null;
  const isPasswordValid = await bcrypt.compare(password, user.password);
  return isPasswordValid ? user : null;
};

// Login user
const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const user = await checkCredentials(username, password);
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({
      message: "Login successful",
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Admin login: same credential check, but only succeeds for the admin role
const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const user = await checkCredentials(username, password);
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ message: "This account does not have admin access" });
    }

    res.json({
      message: "Login successful",
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const parseSetAdmin = (v) => {
  if (v === true || v === "true") return "admin";
  if (v === false || v === "false") return "user";
  return null;
};

// Grant/remove admin on an existing account using its own credentials plus the registration code
const setAdminRole = async (req, res) => {
  try {
    const { username, password, adminAuth, setAdmin } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }
    const role = parseSetAdmin(setAdmin);
    if (!role) {
      return res.status(400).json({ message: "setAdmin must be true or false", code: "INVALID_SET_ADMIN" });
    }
    // Checked before credentials so this endpoint can't be used to probe passwords
    if (!REGISTER_CODE || adminAuth !== REGISTER_CODE) {
      return res.status(403).json({ message: "Invalid admin auth code", code: "INVALID_AUTH_CODE" });
    }

    const user = await checkCredentials(username, password);
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const from = user.role || "user";
    if (from !== role) {
      if (role === "user" && (await User.countDocuments({ role: "admin" })) <= 1) {
        return res.status(400).json({ message: "At least one admin account is required", code: "LAST_ADMIN" });
      }
      user.role = role;
      await user.save();
      await Promise.all([
        AuditLog.record(user._id, "user.role", "user", user._id, { username: user.username, from, to: role, via: "auth-code" }),
        bump(deps.users, deps.user(user._id)),
      ]);
    }

    if (role === "user") {
      return res.json({ message: "Admin access removed", user: publicUser(user) });
    }
    res.json({ message: "Admin access granted", token: signToken(user), user: publicUser(user) });
  } catch (error) {
    console.error("Set admin role error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get current user (protected route)
const getCurrentUser = async (req, res) => {
  try {
    // Cached per account and pushed stale only when this account changes (e.g. its role)
    const userId = String(req.userId);
    await sendCached(req, res, { name: "me", deps: [deps.user(userId)], scope: userId }, async () => {
      const user = await User.findById(userId).select("username role").lean();
      if (!user) throw Object.assign(new Error("User not found"), { notFound: true });
      return { user: publicUser(user) };
    });
  } catch (error) {
    if (error.notFound) return res.status(404).json({ message: "User not found" });
    console.error("Get user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  register,
  login,
  adminLogin,
  setAdminRole,
  getCurrentUser,
};
