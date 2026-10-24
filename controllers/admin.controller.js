const bcrypt = require("bcryptjs");
const { REGISTER_CODE } = require("../config/env.js");
const Payment = require("../models/payment.model.js");
const { PAYMENT_METHODS } = Payment;
const User = require("../models/user.model.js");
const AuditLog = require("../models/auditLog.model.js");
const cloud = require("../services/cloudinary.js");
const { HttpError } = require("../utils/httpError.js");
const { toObjectId, escapeRegex, parsePagination, pageResult } = require("../utils/validation.js");
const { buildPaymentFilter, listParam } = require("../utils/paymentFilters.js");
const { toListItem, gameLookup, cleanupAssets, summaryTotals } = require("./payment.controller.js");
const DeletedPayment = require("../models/deletedPayment.model.js");
const PaymentEdit = require("../models/paymentEdit.model.js");
const BookingData = require("../models/booking.model.js");
const PDFDocument = require("pdfkit");
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
    const [[row], breakdowns, totalUsers] = await Promise.all([
      Payment.aggregate([{ $match: match }, { $group: totalsGroup }]),
      summaryTotals(match),
      // Every account created so far, admins included
      User.countDocuments(),
    ]);
    return { ...cleanTotals(row), ...breakdowns, totalUsers };
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

// Every backend username in use (case variants merged), most used first. Honours the other
// filters but not the username filter itself, so the list doesn't shrink to the picked names.
const gameUsernames = async (req, res) => {
  await sendCached(req, res, { name: "admin-game-usernames", deps: [deps.payments] }, async () => {
    const match = await buildPaymentFilter({ ...req.query, gameUsername: undefined });
    const rows = await Payment.aggregate([
      { $match: { ...match, gameUsername: { $nin: [null, ""] } } },
      { $group: { _id: { $toLower: "$gameUsername" }, name: { $first: "$gameUsername" }, count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 500 },
    ]);
    return rows.map((r) => ({ name: r.name, count: r.count }));
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

const METHOD_LABELS = { cashapp: "Cash App", venmo: "Venmo", paypal: "PayPal", zelle: "Zelle", applepay: "Apple Pay", chime: "Chime" };
const paymentMethodLabel = (m) => METHOD_LABELS[m] || "";

const day = (d) => d.toISOString().slice(0, 10);
const iso = (d) => (d ? d.toISOString() : "");

// Every column the exports can include. The admin picks a subset with ?columns=date,player,...
// (none = all). `money` columns are summed into the PDF total rows; `pdf: false` columns are CSV-only,
// `inCsv: false` ones PDF-only. csv/pdf give the cell for each format when they differ; `short` is the
// PDF header label when the full one is too wide; widths are relative (scaled to the page).
// Payment Method is CSV-only because the PDF is split into one section per method.
const EXPORT_COLUMNS = [
  { key: "id", label: "Payment ID", pdf: false, value: (p) => p._id },
  { key: "date", label: "Date", width: 72, value: (p) => day(p.date) },
  { key: "user", label: "User", width: 90, value: (p) => (p.user ? p.user.username : "") },
  { key: "player", label: "Player", width: 95, value: (p) => p.player || "" },
  { key: "game", label: "Game", width: 105, value: (p) => (p.game ? p.game.name : "") },
  { key: "gameUsername", label: "Backend Username", short: "Backend User", width: 95, value: (p) => p.gameUsername || "" },
  { key: "paymentMethod", label: "Payment Method", pdf: false, csv: (p) => p.paymentMethod || "", value: (p) => paymentMethodLabel(p.paymentMethod) },
  { key: "paymentTag", label: "Payment Tag", width: 90, value: (p) => p.paymentTag || "" },
  { key: "deposit", label: "Deposit", width: 70, money: true, value: (p) => p.deposit },
  { key: "loaded", label: "Loaded", width: 70, money: true, value: (p) => p.loaded },
  { key: "redeemed", label: "Redeemed", width: 70, money: true, value: (p) => p.redeemed || 0 },
  { key: "cashout", label: "Cashout", width: 70, money: true, value: (p) => p.cashout || 0 },
  { key: "cashoutMethod", label: "Cashout Method", short: "Cashout Via", width: 82, csv: (p) => p.cashoutMethod || "", value: (p) => paymentMethodLabel(p.cashoutMethod) },
  // PDF: clickable "Photo" / "Cashout" buttons; the full URLs are listed on the Image Links page
  { key: "links", label: "Images", width: 100, inCsv: false, value: () => "" },
  { key: "notes", label: "Notes", pdf: false, value: (p) => p.notes || "" },
  { key: "createdAt", label: "Created At", pdf: false, value: (p) => iso(p.createdAt) },
  { key: "editedAt", label: "Edited At", pdf: false, value: (p) => iso(p.editedAt) },
  { key: "screenshotUrl", label: "Screenshot URL", pdf: false, value: (p) => cloud.fullUrl(p.screenshot) || "" },
  { key: "cashoutProofUrl", label: "Cashout Proof URL", pdf: false, value: (p) => cloud.fullUrl(p.cashoutProof) || "" },
];

// ?columns=a,b,c -> those columns in the standard order; unknown keys are ignored, none/empty = all
const pickColumns = (raw) => {
  const wanted = new Set(listParam(raw, 100));
  const picked = EXPORT_COLUMNS.filter((c) => wanted.has(c.key));
  return picked.length ? picked : EXPORT_COLUMNS;
};

// ?filename= -> a safe download name without extension; falls back to payments-YYYY-MM-DD
const exportFilename = (raw, ext) => {
  const name = String(raw ?? "")
    .replace(/\.(csv|pdf)$/i, "")
    .replace(/[^\w.\- ]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return `${name || `payments-${new Date().toISOString().slice(0, 10)}`}.${ext}`;
};

const cellOf = (c, p, format) => {
  const v = format === "csv" && c.csv ? c.csv(p) : c.value(p);
  return c.money ? centsToString(v) : v;
};

const exportCursor = (match) =>
  Payment.aggregate([{ $match: match }, { $sort: { date: -1, _id: -1 } }, ...gameLookup, ...userLookup]).cursor({ batchSize: 500 });

// Streams CSV for the currently filtered payments; never buffers the full result set
const exportCsv = async (req, res) => {
  const match = await buildPaymentFilter(req.query);
  let columns = pickColumns(req.query.columns).filter((c) => c.inCsv !== false);
  if (!columns.length) columns = EXPORT_COLUMNS.filter((c) => c.inCsv !== false);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(req.query.filename, "csv")}"`);
  res.write(columns.map((c) => csvCell(c.label)).join(",") + "\n");

  for await (const p of exportCursor(match)) {
    const row = columns.map((c) => csvCell(cellOf(c, p, "csv")));
    if (!res.write(row.join(",") + "\n")) await new Promise((r) => res.once("drain", r));
  }
  res.end();
};

// ---- PDF report ----

const PDF = {
  ink: "#111827",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  zebra: "#f9fafb",
  head: "#1f2937",
  accent: "#dc2626",
  photo: "#2563eb",
  cashout: "#d97706",
  link: "#1d4ed8",
};
// Colour of each method's section ("" = entries without a method)
const METHOD_COLORS = { cashapp: "#00a650", venmo: "#008cff", paypal: "#003087", zelle: "#6d1ed4", applepay: "#111827", chime: "#16a34a", "": "#6b7280" };
const methodTitle = (m) => paymentMethodLabel(m) || "No payment method";
const entries = (n) => `${n} ${n === 1 ? "entry" : "entries"}`;

// "$1,234.56" for the PDF (the CSV keeps plain 1234.56)
const money = (c) => {
  const s = centsToString(c);
  return (s.startsWith("-") ? "-$" : "$") + s.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

// Count and totals per payment method, in section order
const methodStats = async (match) => {
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ["$paymentMethod", ""] },
        count: { $sum: 1 },
        deposit: { $sum: "$deposit" },
        loaded: { $sum: "$loaded" },
        redeemed: { $sum: { $ifNull: ["$redeemed", 0] } },
        cashout: { $sum: { $ifNull: ["$cashout", 0] } },
      },
    },
  ]);
  const order = (m) => (m ? PAYMENT_METHODS.indexOf(m) : PAYMENT_METHODS.length);
  return rows.sort((a, b) => order(a._id) - order(b._id));
};

// PDF order: grouped by payment method (PAYMENT_METHODS order, entries without one last), newest first in each group
const pdfCursor = (match) =>
  Payment.aggregate([
    { $match: match },
    { $addFields: { _methodOrder: { $indexOfArray: [PAYMENT_METHODS, { $ifNull: ["$paymentMethod", ""] }] } } },
    { $addFields: { _methodOrder: { $cond: [{ $lt: ["$_methodOrder", 0] }, PAYMENT_METHODS.length, "$_methodOrder"] } } },
    { $sort: { _methodOrder: 1, date: -1, _id: -1 } },
    ...gameLookup,
    ...userLookup,
  ])
    .allowDiskUse(true)
    .cursor({ batchSize: 500 });

// Streams a PDF report of the currently filtered payments (same filters as the list and CSV): summary
// cards, one section per payment method with its subtotal, the grand total, then a page listing every
// image link in full (the table itself only has small "Photo" / "Cashout" buttons)
const exportPdf = async (req, res) => {
  const match = await buildPaymentFilter(req.query);
  const stats = await methodStats(match);
  let picked = pickColumns(req.query.columns).filter((c) => c.pdf !== false);
  if (!picked.length) picked = EXPORT_COLUMNS.filter((c) => c.pdf !== false);
  // Row number first: the Image Links page refers back to it
  const columns = [{ key: "no", label: "#", width: 30, value: () => "" }, ...picked];
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(req.query.filename, "pdf")}"`);

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, bottom: 42, left: 30, right: 30 },
    info: { Title: "Payments Report" },
  });
  doc.pipe(res);
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const pageWidth = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const generated = `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const ROW_H = 18;
  let y;

  // Footer on every page. The bottom margin is lifted while drawing it so pdfkit doesn't start a new page.
  let pageNo = 0;
  const footer = () => {
    pageNo += 1;
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 26;
    doc.moveTo(left, fy - 7).lineTo(left + pageWidth, fy - 7).lineWidth(0.5).strokeColor(PDF.line).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(PDF.muted);
    doc.text(`Payments Report  ·  Generated ${generated}`, left, fy, { width: pageWidth / 2, lineBreak: false });
    doc.text(`Page ${pageNo}`, left + pageWidth / 2, fy, { width: pageWidth / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = margin;
  };
  footer();
  doc.on("pageAdded", footer);

  // What to redraw at the top of a continuation page (section heading, table header)
  let onNewPage = () => {};
  const ensureRoom = (h) => {
    if (y + h > bottom()) {
      doc.addPage();
      y = top;
      onNewPage();
    }
  };

  // One line of text, vertically centred in a row of height `h`
  const cellText = (text, x, w, { bold = false, color = PDF.ink, align = "left", size = 8, h = ROW_H } = {}) =>
    doc
      .fillColor(color)
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .text(String(text ?? ""), x + 4, y + (h - size) / 2 + 0.5, { width: w - 8, align, lineBreak: false, ellipsis: true, height: h });
  const rule = (atY) => doc.moveTo(left, atY).lineTo(left + pageWidth, atY).lineWidth(0.4).strokeColor(PDF.line).stroke();

  // ---- title band, summary cards, per-method chips (the filters used are not printed) ----
  doc.rect(0, 0, doc.page.width, 62).fill(PDF.head);
  doc.rect(0, 62, doc.page.width, 3).fill(PDF.accent);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(20).text("Payments Report", left, 21, { lineBreak: false });
  doc.fillColor("#d1d5db").font("Helvetica").fontSize(9).text(`Generated ${generated}`, left, 28, { width: pageWidth, align: "right", lineBreak: false });

  y = 84;

  const all = stats.reduce(
    (t, s) => ({ count: t.count + s.count, deposit: t.deposit + s.deposit, loaded: t.loaded + s.loaded, redeemed: t.redeemed + s.redeemed, cashout: t.cashout + s.cashout }),
    { count: 0, deposit: 0, loaded: 0, redeemed: 0, cashout: 0 }
  );
  const cards = [
    ["Entries", String(all.count), PDF.ink],
    ["Deposit", money(all.deposit), "#059669"],
    ["Loaded", money(all.loaded), "#2563eb"],
    ["Redeemed", money(all.redeemed), "#7c3aed"],
    ["Cashout", money(all.cashout), "#d97706"],
  ];
  const gap = 10;
  const cardW = (pageWidth - gap * (cards.length - 1)) / cards.length;
  const cardH = 48;
  cards.forEach(([label, value, color], i) => {
    const cx = left + i * (cardW + gap);
    doc.roundedRect(cx, y, cardW, cardH, 6).lineWidth(0.75).fillAndStroke(PDF.zebra, PDF.line);
    doc.rect(cx, y + 10, 3, cardH - 20).fill(color);
    doc.fillColor(PDF.muted).font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), cx + 12, y + 10, { width: cardW - 20, lineBreak: false });
    doc.fillColor(color).font("Helvetica-Bold").fontSize(15).text(value, cx + 12, y + 23, { width: cardW - 20, lineBreak: false, ellipsis: true });
  });
  y += cardH + 10;

  let chipX = left;
  stats.forEach((s) => {
    const label = `${methodTitle(s._id)}   ${entries(s.count)}  ·  ${money(s.deposit)}`;
    doc.font("Helvetica").fontSize(8);
    const w = doc.widthOfString(label) + 24;
    if (chipX + w > left + pageWidth) {
      chipX = left;
      y += 22;
    }
    doc.roundedRect(chipX, y, w, 17, 8.5).lineWidth(0.75).fillAndStroke("#ffffff", PDF.line);
    doc.circle(chipX + 10, y + 8.5, 3.2).fill(METHOD_COLORS[s._id] || PDF.muted);
    doc.fillColor(PDF.ink).font("Helvetica").fontSize(8).text(label, chipX + 17, y + 5, { lineBreak: false });
    chipX += w + 6;
  });
  y += 30;

  if (!stats.length) {
    doc.fillColor(PDF.muted).font("Helvetica").fontSize(11).text("No entries match these filters.", left, y, { width: pageWidth, align: "center" });
    doc.end();
    return;
  }

  // ---- tables, one per payment method ----
  const scale = pageWidth / columns.reduce((s, c) => s + c.width, 0);
  const widths = columns.map((c) => c.width * scale);
  const moneyCols = columns.filter((c) => c.money);
  const zeroSums = () => Object.fromEntries(moneyCols.map((c) => [c.key, 0]));

  const tableHeader = () => {
    doc.rect(left, y, pageWidth, ROW_H).fill(PDF.head);
    let x = left;
    columns.forEach((c, i) => {
      cellText((c.short || c.label).toUpperCase(), x, widths[i], { bold: true, color: "#ffffff", align: c.money ? "right" : "left", size: 6.8 });
      x += widths[i];
    });
    y += ROW_H;
  };

  let section = null; // { method, stat } being drawn
  const SECTION_H = 26;
  const sectionHeading = (continued = false) => {
    const color = METHOD_COLORS[section.method] || PDF.muted;
    doc.save();
    doc.rect(left, y, pageWidth, SECTION_H).fillOpacity(0.08).fill(color);
    doc.restore();
    doc.rect(left, y, 4, SECTION_H).fill(color);
    doc.fillColor(color).font("Helvetica-Bold").fontSize(12).text(methodTitle(section.method) + (continued ? "  (continued)" : ""), left + 14, y + 8, { width: pageWidth / 2, lineBreak: false });
    const s = section.stat;
    const summary = `${entries(s.count)}   ·   Deposit ${money(s.deposit)}   ·   Loaded ${money(s.loaded)}`;
    doc.fillColor(PDF.muted).font("Helvetica").fontSize(8.5).text(summary, left + pageWidth / 2, y + 9.5, { width: pageWidth / 2 - 12, align: "right", lineBreak: false });
    y += SECTION_H + 4;
  };

  // Subtotal / grand total: the label spans the text columns before the first money column (after #),
  // sums go under the money columns
  const firstMoney = columns.findIndex((c) => c.money);
  const labelEnd = firstMoney < 0 ? columns.length : firstMoney;
  const labelWidth = widths.slice(1, labelEnd).reduce((s, w) => s + w, 0);
  const sumRow = (label, count, sums, { dark = false } = {}) => {
    ensureRoom(ROW_H);
    doc.rect(left, y, pageWidth, ROW_H).fill(dark ? PDF.head : "#f3f4f6");
    const color = dark ? "#ffffff" : PDF.ink;
    if (labelWidth) cellText(`${label}   ·   ${entries(count)}`, left + widths[0], labelWidth, { bold: true, color });
    let x = left;
    columns.forEach((c, i) => {
      if (c.money) cellText(money(sums[c.key]), x, widths[i], { bold: true, color, align: "right" });
      x += widths[i];
    });
    y += ROW_H;
  };

  // Small rounded buttons that open the images; every link is also listed on the Image Links page
  const links = [];
  const IMAGE_BUTTONS = [
    { label: "Photo", type: "Payment screenshot", color: PDF.photo, url: (p) => cloud.fullUrl(p.screenshot) },
    { label: "Cashout", type: "Cashout proof", color: PDF.cashout, url: (p) => cloud.fullUrl(p.cashoutProof) },
  ];
  const imageButtons = (p, no, x, w) => {
    const items = IMAGE_BUTTONS.map((b) => ({ ...b, url: b.url(p) })).filter((b) => b.url);
    if (!items.length) return cellText("-", x, w, { color: PDF.faint });
    let bx = x + 4;
    items.forEach((b) => {
      links.push({ no, date: day(p.date), player: p.player || "", backend: p.gameUsername || "", type: b.type, color: b.color, url: b.url });
      doc.font("Helvetica-Bold").fontSize(6.5);
      const bw = doc.widthOfString(b.label) + 10;
      const bh = 11;
      const by = y + (ROW_H - bh) / 2;
      if (bx + bw > x + w) return; // no room for another button in a narrow column
      doc.roundedRect(bx, by, bw, bh, 5.5).fill(b.color);
      doc.fillColor("#ffffff").text(b.label, bx, by + 2.7, { width: bw, align: "center", lineBreak: false });
      doc.link(bx, by, bw, bh, b.url);
      bx += bw + 4;
    });
  };

  const dataRow = (p, no, zebra) => {
    if (zebra) doc.rect(left, y, pageWidth, ROW_H).fill(PDF.zebra);
    let x = left;
    columns.forEach((c, i) => {
      if (c.key === "no") cellText(no, x, widths[i], { color: PDF.muted, size: 7.5 });
      else if (c.key === "links") imageButtons(p, no, x, widths[i]);
      else if (c.money) {
        const v = c.value(p);
        cellText(money(v), x, widths[i], { align: "right", color: v ? PDF.ink : PDF.faint });
      } else cellText(c.value(p), x, widths[i]);
      x += widths[i];
    });
    rule(y + ROW_H);
    y += ROW_H;
  };

  onNewPage = () => {
    if (section) sectionHeading(true);
    tableHeader();
  };

  let no = 0;
  let groupCount = 0;
  let groupSums = zeroSums();
  const totals = zeroSums();
  const closeSection = () => {
    if (section) sumRow(`${methodTitle(section.method)} subtotal`, groupCount, groupSums);
    section = null;
  };

  for await (const p of pdfCursor(match)) {
    const method = p.paymentMethod || "";
    if (!section || section.method !== method) {
      closeSection();
      if (no) y += 14;
      // Keep the heading with its table header and first rows
      ensureRoom(SECTION_H + 4 + ROW_H * 3);
      section = { method, stat: stats.find((s) => s._id === method) || { count: 0, deposit: 0, loaded: 0 } };
      groupCount = 0;
      groupSums = zeroSums();
      sectionHeading();
      tableHeader();
    }
    ensureRoom(ROW_H);
    no += 1;
    groupCount += 1;
    moneyCols.forEach((c) => {
      totals[c.key] += c.value(p);
      groupSums[c.key] += c.value(p);
    });
    dataRow(p, no, groupCount % 2 === 0);
  }
  closeSection();
  onNewPage = tableHeader;
  y += 14;
  sumRow("Grand total", no, totals, { dark: true });

  // ---- Image Links page: every link in full, to click or copy ----
  if (links.length) {
    const lcols = [
      ["#", 30],
      ["Date", 62],
      ["Player", 110],
      ["Backend Username", 110],
      ["Image", 100],
    ];
    const fixed = lcols.reduce((s, [, w]) => s + w, 0);
    lcols.push(["Link (click or copy)", pageWidth - fixed]);
    const linksHeader = () => {
      doc.rect(left, y, pageWidth, ROW_H).fill(PDF.head);
      let x = left;
      lcols.forEach(([label, w]) => {
        cellText(label.toUpperCase(), x, w, { bold: true, color: "#ffffff", size: 6.8 });
        x += w;
      });
      y += ROW_H;
    };
    onNewPage = linksHeader;
    doc.addPage();
    y = top;
    doc.fillColor(PDF.ink).font("Helvetica-Bold").fontSize(16).text("Image Links", left, y, { lineBreak: false });
    doc
      .fillColor(PDF.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("The full link of every image in the report. Click one to open it, or select it to copy. # matches the row number in the tables.", left, y + 22, { lineBreak: false });
    y += 42;
    linksHeader();

    const urlW = lcols[lcols.length - 1][1] - 8;
    links.forEach((l, i) => {
      doc.font("Helvetica").fontSize(7);
      const h = Math.max(ROW_H, doc.heightOfString(l.url, { width: urlW }) + 9);
      ensureRoom(h);
      if (i % 2) doc.rect(left, y, pageWidth, h).fill(PDF.zebra);
      let x = left;
      [l.no, l.date, l.player, l.backend].forEach((v, j) => {
        cellText(v, x, lcols[j][1], { color: j ? PDF.ink : PDF.muted, h });
        x += lcols[j][1];
      });
      doc.circle(x + 8, y + h / 2, 2.8).fill(l.color);
      cellText(l.type, x + 9, lcols[4][1] - 9, { h });
      x += lcols[4][1];
      doc.fillColor(PDF.link).font("Helvetica").fontSize(7).text(l.url, x + 4, y + 5, { width: urlW, link: l.url });
      rule(y + h);
      y += h;
    });
  }
  doc.end();
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
  gameUsernames,
  exportCsv,
  exportPdf,
  listAudit,
};
