const User = require("../models/user.model.js");

// Role is always checked against the database, never trusted from the token alone
const requireAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).select("role").lean();
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required", code: "FORBIDDEN" });
    }
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireAdmin;
