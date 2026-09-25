const bcrypt = require("bcryptjs");
const { REGISTER_CODE } = require("../config/env.js");
const Payment = require("../models/payment.model.js");
const User = require("../models/user.model.js");
const AuditLog = require("../models/auditLog.model.js");
const cloud = require("../services/cloudinary.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId, escapeRegex, parsePagination, pageResult } = require("../utils/validation.js");
const { buildPaymentFilter } = require("../utils/paymentFilters.js");
const { toListItem, gameLookup, cleanupAssets } = require("./payment.controller.js");
const DeletedPayment = require("../models/deletedPayment.model.js");
const PaymentEdit = require("../models/paymentEdit.model.js");
const BookingData = require("../models/booking.model.js");
const { sendCached, bump, deps } = require("../services/cache.js");
const { listProject, syncToken, sendChanges } = require("../utils/delta.js");

// Admin table thumbnails are shown at 32-40px, so an 80px image is plenty
const toAdminListItem = (p) => toListItem(p, 80);

const userLookup = [
  {
    $lookup: {
      from: "users",
      localField: "userId",
      foreignField: "_id",
      as: "user",
      pipeline: [{ $project: { username: 1 } }],
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
];

const totalsGroup = {
  _id: null,
  count: { $sum: 1 },
  totalDeposit: { $sum: "$deposit" },
  totalLoaded: { $sum: "$loaded" },
  // Older entries have no redeemed amount (treated as 0)
  totalRedeemed: { $sum: { $ifNull: ["$redeemed", 0] } },
  edited: { $sum: { $cond: [{ $ifNull: ["$editedAt", false] }, 1, 0] } },
};

const emptyTotals = { count: 0, totalDeposit: 0, totalLoaded: 0, totalRedeemed: 0, edited: 0 };
const cleanTotals = (row) => {
  if (!row) return { ...emptyTotals };
  const { _id, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
};

const summary = async (req, res) => {
  await sendCached(req, res, { name: "admin-summary", deps: [deps.payments, deps.users] }, async () => {
    const match = await buildPaymentFilter(req.query);
    const [[row], totalUsers] = await Promise.all([
      Payment.aggregate([{ $match: match }, { $group: totalsGroup }]),
      // Every account created so far, admins included
      User.countDocuments(),
    ]);
    return { ...cleanTotals(row), totalUsers };
  });
};

const listPayments = async (req, res) => {
  const opts = { name: "admin-payments", deps: [deps.payments, deps.games, deps.users] };
  await sendCached(req, res, opts, async () => {
    const sync = await syncToken(deps.payments); // read before querying
    const match = await buildPaymentFilter(req.query);
    const pg = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const [items, total] = await Promise.all([
      Payment.aggregate([
        { $match: match },
        { $sort: { date: -1, _id: -1 } },
        { $skip: pg.skip },
        { $limit: pg.limit },
        listProject,
        ...gameLookup,
        ...userLookup,
      ]),
      Payment.countDocuments(match),
    ]);
    return { ...pageResult(items.map(toAdminListItem), total, pg), sync };
  });
};

// Delta sync for the admin payment list, honouring the same filters
const paymentChanges = async (req, res) => {
  await sendChanges(req, res, {
    dep: deps.payments,
    match: await buildPaymentFilter(req.query),
    toItem: toAdminListItem,
    extraStages: [...gameLookup, ...userLookup],
  });
};

const getPayment = async (req, res) => {
  const id = toObjectId(req.params.id, "payment id");
  const opts = { name: "admin-payment", deps: [deps.payments, deps.games], scope: String(id) };
  await sendCached(req, res, opts, () => paymentDetail(id));
};

const paymentDetail = async (id) => {
  const [p] = await Payment.aggregate([
    { $match: { _id: id } },
    ...gameLookup,
    ...userLookup,
  ]);
  if (!p) throw new HttpError(404, "Payment not found", "NOT_FOUND");

  // Other payments sharing the same screenshot, so the admin can spot reuse
  const sameScreenshot = p.screenshotHash
    ? await Payment.find({ screenshotHash: p.screenshotHash, _id: { $ne: p._id } })
        .select("_id userId date")
        .limit(10)
        .lean()
    : [];

  return {
    ...toListItem(p),
    screenshot: cloud.fullUrl(p.screenshot),
    cashoutProof: cloud.fullUrl(p.cashoutProof),
    createdAt: p.createdAt,
    sameScreenshot: sameScreenshot.map((s) => ({ id: s._id, userId: s.userId, date: s.date })),
  };
};

// Permanent delete (admin only). A tombstone tells delta-sync clients the row is gone.
const deletePayment = async (req, res) => {
  const id = toObjectId(req.params.id, "payment id");
  const adminId = toObjectId(req.userId, "admin");
  const p = await Payment.findOneAndDelete({ _id: id }).lean();
  if (!p) throw new HttpError(404, "Payment not found", "NOT_FOUND");

  // Tombstone before the version bump, so a client syncing in between can't miss the delete
  await DeletedPayment.create({ paymentId: p._id, userId: p.userId });
  await PaymentEdit.deleteMany({ paymentId: p._id });
  await bump(deps.payments, deps.userPayments(p.userId));
  await AuditLog.record(adminId, "payment.delete", "payment", id, {
    userId: p.userId,
    gameId: p.gameId,
    date: p.date,
    deposit: p.deposit,
    loaded: p.loaded,
    redeemed: p.redeemed || 0,
    edited: !!p.editedAt,
    userDeleted: !!p.userDeletedAt,
  });
  // Images no other payment uses any more
  await cleanupAssets([
    p.screenshot && { publicId: p.screenshot.publicId, field: "screenshot" },
    p.cashoutProof && { publicId: p.cashoutProof.publicId, field: "cashoutProof" },
  ]);
  res.json({ message: "Entry permanently deleted", id });
};

// Users page: paginate users first, then aggregate only that page's payments (uses userId index)
const listUsers = async (req, res) => {
  const pg = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const match = {};
  if (req.query.search && String(req.query.search).trim()) {
    match.username = { $regex: escapeRegex(String(req.query.search).trim().slice(0, 30)), $options: "i" };
  }
  await sendCached(req, res, { name: "admin-users", deps: [deps.payments, deps.users] }, async () => {
    const [users, total] = await Promise.all([
      User.aggregate([
        { $match: match },
        { $sort: { username: 1 } },
        { $skip: pg.skip },
        { $limit: pg.limit },
        {
          $lookup: {
            from: "payments",
            let: { uid: "$_id" },
            pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$uid"] } } }, { $group: totalsGroup }],
            as: "totals",
          },
        },
        { $project: { username: 1, role: 1, createdAt: 1, totals: { $arrayElemAt: ["$totals", 0] } } },
      ]),
      User.countDocuments(match),
    ]);
    return pageResult(
      users.map((u) => ({
        id: u._id,
        username: u.username,
        role: u.role || "user",
        createdAt: u.createdAt,
        ...cleanTotals(u.totals),
      })),
      total,
      pg,
    );
  });
};

const userSummary = async (req, res) => {
  const userId = toObjectId(req.params.id, "user id");
  const opts = { name: "admin-user", deps: [deps.userPayments(userId), deps.users], scope: String(userId) };
  await sendCached(req, res, opts, async () => {
    const user = await User.findById(userId).select("username createdAt role").lean();
    if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
    const [row] = await Payment.aggregate([{ $match: { userId } }, { $group: totalsGroup }]);
    return { id: user._id, username: user.username, role: user.role || "user", createdAt: user.createdAt, ...cleanTotals(row) };
  });
};

const ROLES = ["user", "admin"];
// Granting or removing admin access also needs the admin auth code (REGISTER_CODE), not just an admin session
const requireAdminAuth = (code) => {
  if (!REGISTER_CODE || typeof code !== "string" || code !== REGISTER_CODE) {
    throw new HttpError(403, "Invalid admin auth code", "INVALID_AUTH_CODE");
  }
};

const cleanRole = (role) => {
  if (!ROLES.includes(role)) throw new HttpError(400, "Role must be 'user' or 'admin'", "INVALID_ROLE");
  return role;
};

// Same username/password rules as self-registration
const cleanUsername = (value) => {
  const username = typeof value === "string" ? value.trim() : "";
  if (username.length < 3 || username.length > 30) {
    throw new HttpError(400, "Username must be 3-30 characters", "INVALID_USERNAME");
  }
  return username;
};

const cleanPassword = (password) => {
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters", "INVALID_PASSWORD");
  }
  return password;
};

// Admin-created accounts: the role is chosen
const createUser = async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = cleanPassword(req.body.password);
  const role = cleanRole(req.body.role ?? "user");
  if (role === "admin") requireAdminAuth(req.body.adminAuth);
  if (await User.exists({ username })) throw new HttpError(409, "Username already exists", "USERNAME_EXISTS");

  const user = await User.create({ username, password: await bcrypt.hash(password, 10), role });
  await Promise.all([AuditLog.record(req.userId, "user.create", "user", user._id, { username, role }), bump(deps.users)]);
  res.status(201).json({ id: user._id, username, role, createdAt: user.createdAt, ...emptyTotals });
};

const updateUserRole = async (req, res) => {
  const id = toObjectId(req.params.id, "user id");
  const role = cleanRole(req.body.role);
  const user = await User.findById(id).select("username role");
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");

  const from = user.role || "user";
  if (from !== role) {
    requireAdminAuth(req.body.adminAuth);
    if (role === "user") {
      if (String(id) === String(req.userId)) {
        throw new HttpError(400, "You cannot remove your own admin access", "SELF_DEMOTE");
      }
      if ((await User.countDocuments({ role: "admin" })) <= 1) {
        throw new HttpError(400, "At least one admin account is required", "LAST_ADMIN");
      }
    }
    user.role = role;
    await user.save();
    await Promise.all([
      AuditLog.record(req.userId, "user.role", "user", id, { username: user.username, from, to: role }),
      bump(deps.users, deps.user(id)),
    ]);
  }
  res.json({ id: user._id, username: user.username, role });
};

// Rename and/or reset the password. Changing an admin account also needs the admin auth code.
// A password reset bumps tokenVersion, which signs the account out everywhere.
const updateUser = async (req, res) => {
  const id = toObjectId(req.params.id, "user id");
  const user = await User.findById(id).select("username role tokenVersion");
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (user.role === "admin") requireAdminAuth(req.body.adminAuth);

  const changes = {};
  if (req.body.username !== undefined) {
    const username = cleanUsername(req.body.username);
    if (username !== user.username) {
      if (await User.exists({ username, _id: { $ne: id } })) {
        throw new HttpError(409, "Username already exists", "USERNAME_EXISTS");
      }
      changes.username = { from: user.username, to: username };
      user.username = username;
    }
  }
  if (req.body.password !== undefined && req.body.password !== "") {
    user.password = await bcrypt.hash(cleanPassword(req.body.password), 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    changes.password = true; // never the password itself
  }

  if (Object.keys(changes).length) {
    try {
      await user.save();
    } catch (err) {
      // Unique index race: someone took the name between the check and the save
      if (err && err.code === 11000) throw new HttpError(409, "Username already exists", "USERNAME_EXISTS");
      throw err;
    }
    await Promise.all([
      AuditLog.record(req.userId, "user.update", "user", id, { username: user.username, ...changes }),
      bump(deps.users, deps.user(id)),
    ]);
  }
  res.json({ id: user._id, username: user.username, role: user.role || "user" });
};

// Permanent: the account and everything it owns (entries, edit history, bookings, unused images).
// Tombstones let open admin views drop the entries via delta sync.
const deleteUser = async (req, res) => {
  const id = toObjectId(req.params.id, "user id");
  if (String(id) === String(req.userId)) {
    throw new HttpError(400, "You cannot delete your own account", "SELF_DELETE");
  }
  const user = await User.findById(id).select("username role").lean();
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (user.role === "admin") {
    requireAdminAuth(req.body && req.body.adminAuth);
    if ((await User.countDocuments({ role: "admin" })) <= 1) {
      throw new HttpError(400, "At least one admin account is required", "LAST_ADMIN");
    }
  }

  const payments = await Payment.find({ userId: id }).select("_id screenshot cashoutProof").lean();
  if (payments.length) {
    await DeletedPayment.insertMany(payments.map((p) => ({ paymentId: p._id, userId: id })));
  }
  await Promise.all([
    Payment.deleteMany({ userId: id }),
    PaymentEdit.deleteMany({ userId: id }),
    BookingData.deleteMany({ userId: id }),
  ]);
  await User.deleteOne({ _id: id });

  await Promise.all([
    AuditLog.record(req.userId, "user.delete", "user", id, { username: user.username, role: user.role || "user", entries: payments.length }),
    bump(deps.users, deps.user(id), deps.payments, deps.userPayments(id), deps.userBookings(id)),
  ]);
  await cleanupAssets(
    payments.flatMap((p) => [
      p.screenshot && { publicId: p.screenshot.publicId, field: "screenshot" },
      p.cashoutProof && { publicId: p.cashoutProof.publicId, field: "cashoutProof" },
    ]),
  );
  res.json({ message: "User deleted", id, entries: payments.length });
};

const gamesSummary = async (req, res) => {
  await sendCached(req, res, { name: "admin-games-summary", deps: [deps.payments, deps.games] }, async () => {
    const match = await buildPaymentFilter(req.query);
    const rows = await Payment.aggregate([
      { $match: match },
      { $group: { ...totalsGroup, _id: "$gameId" } },
      {
        $lookup: {
          from: "games",
          localField: "_id",
          foreignField: "_id",
          as: "game",
          pipeline: [{ $project: { name: 1, active: 1 } }],
        },
      },
      { $unwind: { path: "$game", preserveNullAndEmptyArrays: true } },
      { $sort: { totalDeposit: -1 } },
    ]);
    return rows.map((r) => ({
      gameId: r._id,
      game: r.game ? r.game.name : "(deleted)",
      active: r.game ? r.game.active : false,
      count: r.count,
      totalDeposit: r.totalDeposit,
      totalLoaded: r.totalLoaded,
      totalRedeemed: r.totalRedeemed,
      edited: r.edited,
    }));
  });
};

const centsToString = (c) => {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Streams CSV for the currently filtered payments; never buffers the full result set
const exportCsv = async (req, res) => {
  const match = await buildPaymentFilter(req.query);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="payments-${stamp}.csv"`);
  res.write("Payment ID,Date,User,Player,Payment Method,Game,Deposit,Loaded,Redeemed,Cashout,Created At,Edited At\n");

  const cursor = Payment.aggregate([
    { $match: match },
    { $sort: { date: -1, _id: -1 } },
    ...gameLookup,
    ...userLookup,
  ]).cursor({ batchSize: 500 });
  for await (const p of cursor) {
    const row = [
      p._id,
      p.date.toISOString().slice(0, 10),
      p.user ? p.user.username : "",
      p.player || "",
      p.paymentMethod || "",
      p.game ? p.game.name : "",
      centsToString(p.deposit),
      centsToString(p.loaded),
      centsToString(p.redeemed || 0),
      centsToString(p.cashout || 0),
      p.createdAt ? p.createdAt.toISOString() : "",
      p.editedAt ? p.editedAt.toISOString() : "",
    ].map(csvCell);
    if (!res.write(row.join(",") + "\n")) await new Promise((r) => res.once("drain", r));
  }
  res.end();
};

// Users' edits to their entries (what changed, when), newest first; filter by user and/or entry
const listEdits = async (req, res) => {
  const match = {};
  if (req.query.userId) match.userId = toObjectId(req.query.userId, "userId");
  if (req.query.paymentId) match.paymentId = toObjectId(req.query.paymentId, "paymentId");
  const pg = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  await sendCached(req, res, { name: "admin-edits", deps: [deps.payments, deps.games] }, async () => {
    const [items, total] = await Promise.all([
      PaymentEdit.aggregate([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: pg.skip },
        { $limit: pg.limit },
        {
          $lookup: {
            from: "payments",
            localField: "paymentId",
            foreignField: "_id",
            as: "payment",
            pipeline: [{ $project: { date: 1, gameId: 1 } }, ...gameLookup],
          },
        },
        { $unwind: { path: "$payment", preserveNullAndEmptyArrays: true } },
        ...userLookup,
      ]),
      PaymentEdit.countDocuments(match),
    ]);
    return pageResult(
      items.map((e) => ({
        id: e._id,
        paymentId: e.paymentId,
        paymentDate: e.payment ? e.payment.date : null,
        game: e.payment && e.payment.game ? e.payment.game.name : null,
        user: e.user ? { id: e.user._id, username: e.user.username } : null,
        changes: e.changes,
        createdAt: e.createdAt,
      })),
      total,
      pg,
    );
  });
};

const listAudit = async (req, res) => {
  await sendCached(req, res, { name: "admin-audit", deps: [deps.audit, deps.users] }, async () => {
    const pg = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const [items, total] = await Promise.all([
      AuditLog.aggregate([
        { $sort: { createdAt: -1 } },
        { $skip: pg.skip },
        { $limit: pg.limit },
        {
          $lookup: {
            from: "users",
            localField: "adminId",
            foreignField: "_id",
            as: "admin",
            pipeline: [{ $project: { username: 1 } }],
          },
        },
      ]),
      AuditLog.estimatedDocumentCount(),
    ]);
    return pageResult(
      items.map((a) => ({
        id: a._id,
        admin: a.admin[0] ? a.admin[0].username : null,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        metadata: a.metadata,
        createdAt: a.createdAt,
      })),
      total,
      pg,
    );
  });
};

module.exports = {
  summary,
  deletePayment,
  listPayments,
  paymentChanges,
  getPayment,
  listEdits,
  listUsers,
  userSummary,
  createUser,
  updateUserRole,
  updateUser,
  deleteUser,
  gamesSummary,
  exportCsv,
  listAudit,
};
