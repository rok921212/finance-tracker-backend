const mongoose = require("mongoose");
const { bump, deps } = require("../services/cache.js");

const auditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: {
      type: String,
      required: true,
      enum: ["payment.verify", "payment.reject", "payment.delete", "game.create", "game.update", "game.toggle", "game.image", "game.delete", "banner.update", "tag.create", "tag.update", "tag.delete", "wheel.config", "wheel.create", "wheel.update", "wheel.delete","user.create", "user.role", "user.update", "user.delete", "credential.create", "credential.update", "credential.delete", "credential.reveal"],
    },
    targetType: { type: String, enum: ["payment", "game", "user", "setting", "tag", "wheel", "credential"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

auditLogSchema.index({ createdAt: -1 });

auditLogSchema.statics.record = async function (adminId, action, targetType, targetId, metadata) {
  const entry = await this.create({ adminId, action, targetType, targetId, metadata });
  await bump(deps.audit);
  return entry;
};

module.exports = mongoose.model("AuditLog", auditLogSchema);
