const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env.js");
const User = require("../models/user.model.js");

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.locals.authError = "no token";
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    // The account must still exist, and its password must not have been reset since the token
    // was issued (tokens from before tokenVersion existed carry no "tv" and count as 0)
    const user = await User.findById(decoded.userId).select("username tokenVersion").lean();
    if (!user || (user.tokenVersion || 0) !== (decoded.tv || 0)) {
      res.locals.authError = user ? "token version outdated" : "user no longer exists";
      return res.status(401).json({ message: "Session expired" });
    }

    // Add user info to request (username from the database, so renames apply at once)
    req.userId = decoded.userId;
    req.username = user.username;

    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      // e.g. "invalid signature" = token signed with a different JWT_SECRET
      res.locals.authError = `invalid token: ${error.message}`;
      return res.status(401).json({ message: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      res.locals.authError = `token expired at ${error.expiredAt.toISOString()}`;
      return res.status(401).json({ message: "Token expired" });
    }
    console.error("Auth middleware error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = authMiddleware;
