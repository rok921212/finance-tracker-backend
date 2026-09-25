process.env.NODE_ENV = "test";
process.env.REGISTER_CODE = "test-register-code";
process.env.JWT_SECRET = "test-secret";
// Use the in-process cache: sharing the real Redis would mix test data with the app's cache
process.env.REDIS_URL = "";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

jest.mock("../services/cloudinary.js", () => {
  const actual = jest.requireActual("../services/cloudinary.js");
  return {
    ...actual,
    uploadScreenshot: jest.fn(async (buffer, hash) => ({ publicId: `payments/${hash}`, version: 1, existing: false })),
    uploadCashoutProof: jest.fn(async (buffer, hash) => ({ publicId: `payments/cashout/${hash}`, version: 1, existing: false })),
    destroy: jest.fn(async () => ({ result: "ok" })),
  };
});

const mongoose = require("mongoose");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../app.js");
const cloud = require("../services/cloudinary.js");
const User = require("../models/user.model.js");
const Game = require("../models/game.model.js");
const Payment = require("../models/payment.model.js");
const AuditLog = require("../models/auditLog.model.js");
const DeletedPayment = require("../models/deletedPayment.model.js");
const PaymentEdit = require("../models/paymentEdit.model.js");

let mongod;
let userA, userB, adminTok, juwa, fireKirin, disabledGame;

// Minimal AVIF header: size + 'ftyp' + 'avif' brand + ispe box with 800x600
const avif = (seed = 0) => {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(28, 0);
  buf.write("ftypavif", 4, "ascii");
  buf.write("ispe", 32, "ascii");
  buf.writeUInt32BE(800, 40);
  buf.writeUInt32BE(600, 44);
  buf.writeUInt32BE(seed, 56);
  return buf;
};
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const register = async (username) => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username, password: "secret123", adminAuthCode: "test-register-code" });
  expect(res.status).toBe(201);
  return { token: res.body.token, id: res.body.user.id };
};

const auth = (tok) => ({ Authorization: `Bearer ${tok}` });

// Required fields get defaults unless a test passes them (null = omit the field)
const submit = (tok, fields, file = avif(), name = "shot.avif", cashoutProof = null) => {
  const req = request(app).post("/api/payments").set(auth(tok));
  Object.entries({ redeemed: "0", paymentMethod: "cashapp", player: "Player One", ...fields }).forEach(([k, v]) => v !== null && req.field(k, String(v)));
  if (file) req.attach("screenshot", file, name);
  if (cashoutProof) req.attach("cashoutProof", cashoutProof, "cashout.png");
  return req;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Payment.syncIndexes(), Game.syncIndexes()]);

  [juwa, fireKirin, disabledGame] = await Game.create([
    { name: "Juwa", slug: "juwa", sortOrder: 0 },
    { name: "Fire Kirin", slug: "fire-kirin", sortOrder: 1 },
    { name: "Old Game", slug: "old-game", sortOrder: 2, active: false },
  ]);

  userA = await register("alice");
  userB = await register("bob");

  await User.create({ username: "boss", password: await bcrypt.hash("adminpass123", 10), role: "admin" });
  const res = await request(app).post("/api/auth/admin/login").send({ username: "boss", password: "adminpass123" });
  expect(res.status).toBe(200);
  adminTok = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe("auth", () => {
  test("login and /me return role", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "alice", password: "secret123" });
    expect(res.status).toBe(200);
    const me = await request(app).get("/api/auth/me").set(auth(res.body.token));
    expect(me.body.user).toMatchObject({ username: "alice", role: "user" });
  });

  test("register rejects wrong code", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ username: "mallory", password: "secret123", adminAuthCode: "nope" });
    expect(res.status).toBe(400);
  });

  test("admin login rejects a normal user", async () => {
    const res = await request(app).post("/api/auth/admin/login").send({ username: "alice", password: "secret123" });
    expect(res.status).toBe(403);
  });

  test("normal user gets 403 on admin APIs, anonymous gets 401", async () => {
    for (const path of ["/api/admin/summary", "/api/admin/payments", "/api/admin/users", "/api/admin/games", "/api/admin/audit"]) {
      expect((await request(app).get(path).set(auth(userA.token))).status).toBe(403);
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});

describe("games", () => {
  test("only active games are listed", async () => {
    const res = await request(app).get("/api/games").set(auth(userA.token));
    expect(res.body.map((g) => g.name)).toEqual(["Juwa", "Fire Kirin"]);
  });
});

describe("payment creation", () => {
  test("stores integer cents and compact metadata", async () => {
    const res = await submit(userA.token, { date: "2026-09-20", deposit: "500.5", loaded: "450", redeemed: "120.25", gameId: juwa._id });
    expect(res.status).toBe(201);
    const p = await Payment.findById(res.body.payment.id).lean();
    expect(p.deposit).toBe(50050);
    expect(p.loaded).toBe(45000);
    expect(p.redeemed).toBe(12025);
    expect(p.screenshot.publicId).toBe(`payments/${p.screenshotHash}`);
    expect(Object.keys(p).sort()).toEqual(
      ["_id", "createdAt", "date", "deposit", "gameId", "loaded", "redeemed", "cashout", "paymentMethod", "player", "screenshot", "screenshotHash", "updatedAt", "userId"].sort()
    );
  });

  test("0.1 + 0.2 style amounts stay exact", async () => {
    const res = await submit(userA.token, { date: "2026-09-19", deposit: "0.10", loaded: "0.20", gameId: juwa._id }, avif(99));
    expect(res.status).toBe(201);
  });

  test("the payment screenshot is optional", async () => {
    const base = { date: "2026-09-19", deposit: "7", loaded: "7", gameId: fireKirin._id };
    const a = await submit(userA.token, base, null);
    const b = await submit(userA.token, base, null);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const doc = await Payment.findById(a.body.payment.id).lean();
    expect(doc.screenshot).toBeUndefined();
    expect(doc.screenshotHash).toBeUndefined();

    const mine = await request(app).get(`/api/payments/${a.body.payment.id}`).set(auth(userA.token));
    expect(mine.body).toMatchObject({ thumb: null, screenshot: null });
    // Two entries without a screenshot are not flagged as sharing one
    const adm = await request(app).get(`/api/admin/payments/${a.body.payment.id}`).set(auth(adminTok));
    expect(adm.body.sameScreenshot).toEqual([]);

    await Payment.deleteMany({ _id: { $in: [a.body.payment.id, b.body.payment.id] } });
  });

  test("rejects disabled game, bad amounts, bad dates", async () => {
    const base = { date: "2026-09-20", deposit: "10", loaded: "10", gameId: juwa._id };
    expect((await submit(userA.token, { ...base, gameId: disabledGame._id }, avif(1))).body.code).toBe("GAME_UNAVAILABLE");
    expect((await submit(userA.token, { ...base, deposit: "-5" }, avif(2))).body.code).toBe("INVALID_AMOUNT");
    expect((await submit(userA.token, { ...base, deposit: "1.234" }, avif(3))).body.code).toBe("INVALID_AMOUNT");
    expect((await submit(userA.token, { ...base, redeemed: "-1" }, avif(3))).body.code).toBe("INVALID_AMOUNT");
    expect((await submit(userA.token, { ...base, date: "2026-02-31" }, avif(4))).body.code).toBe("INVALID_DATE");
    expect((await submit(userA.token, { ...base, date: "2099-01-01" }, avif(5))).body.code).toBe("INVALID_DATE");
  });

  test("payment method and player are required and validated", async () => {
    const base = { date: "2026-09-17", deposit: "5", loaded: "5", gameId: juwa._id };
    expect((await submit(userA.token, { ...base, paymentMethod: null }, avif(701))).body.code).toBe("INVALID_PAYMENT_METHOD");
    expect((await submit(userA.token, { ...base, paymentMethod: "bitcoin" }, avif(702))).body.code).toBe("INVALID_PAYMENT_METHOD");
    expect((await submit(userA.token, { ...base, player: null }, avif(703))).body.code).toBe("PLAYER_REQUIRED");
    expect((await submit(userA.token, { ...base, player: "x".repeat(61) }, avif(704))).body.code).toBe("INVALID_PLAYER");
    for (const m of ["cashapp", "venmo", "paypal", "zelle", "applepay", "chime"]) {
      const ok = await submit(userA.token, { ...base, paymentMethod: m, player: "  Lucky77 " }, avif(710 + m.length));
      expect(ok.status).toBe(201);
      const doc = await Payment.findById(ok.body.payment.id).lean();
      expect(doc).toMatchObject({ paymentMethod: m, player: "Lucky77" });
      await Payment.deleteOne({ _id: doc._id });
    }
  });

  test("redeemed is required; 0 is allowed", async () => {
    const base = { date: "2026-09-17", deposit: "5", loaded: "5", gameId: juwa._id };
    expect((await submit(userA.token, { ...base, redeemed: null }, avif(501))).body.code).toBe("REDEEMED_REQUIRED");
    expect((await submit(userA.token, { ...base, redeemed: " " }, avif(502))).body.code).toBe("REDEEMED_REQUIRED");
    const ok = await submit(userA.token, { ...base, redeemed: "0" }, avif(503));
    expect(ok.status).toBe(201);
    await Payment.deleteOne({ _id: ok.body.payment.id });
  });

  test("cashout is optional, and so is its screenshot (stored separately)", async () => {
    const base = { date: "2026-09-17", deposit: "5", loaded: "5", redeemed: "20", gameId: juwa._id };
    expect((await submit(userA.token, { ...base, cashout: "-1" }, avif(602))).body.code).toBe("INVALID_AMOUNT");
    const fake = await submit(userA.token, { ...base, cashout: "1" }, avif(603), "shot.avif", Buffer.from("not an image at all, text"));
    expect(fake.body.code).toBe("UNSUPPORTED_TYPE");

    // Cashout without a screenshot is fine
    cloud.uploadCashoutProof.mockClear();
    const noShot = await submit(userA.token, { ...base, cashout: "12.50" }, avif(601));
    expect(noShot.status).toBe(201);
    expect(cloud.uploadCashoutProof).not.toHaveBeenCalled();
    const bare = await Payment.findById(noShot.body.payment.id).lean();
    expect(bare.cashout).toBe(1250);
    expect(bare.cashoutProof).toBeUndefined();

    // With a screenshot it is uploaded to payments/cashout/ and exposed like the payment screenshot
    const res = await submit(userA.token, { ...base, cashout: "12.50" }, avif(604), "shot.avif", png());
    expect(res.status).toBe(201);
    expect(cloud.uploadCashoutProof).toHaveBeenCalledTimes(1);
    const p = await Payment.findById(res.body.payment.id).lean();
    expect(p.cashoutProof.publicId).toBe(`payments/cashout/${p.cashoutProofHash}`);
    const mine = await request(app).get(`/api/payments/${p._id}`).set(auth(userA.token));
    expect(mine.body.cashout).toBe(1250);
    expect(mine.body.cashoutProof).toContain("payments/cashout/");
    expect(mine.body.cashoutThumb).toContain("payments/cashout/");
    const adm = await request(app).get(`/api/admin/payments/${p._id}`).set(auth(adminTok));
    expect(adm.body.cashoutProof).toContain("payments/cashout/");

    // Empty cashout means 0
    const none = await submit(userA.token, { ...base }, avif(605));
    expect((await Payment.findById(none.body.payment.id).lean()).cashout).toBe(0);

    await Payment.deleteMany({ _id: { $in: [p._id, noShot.body.payment.id, none.body.payment.id] } });
  });

  test("rejects a fake .avif whose bytes are text", async () => {
    const res = await submit(
      userA.token,
      { date: "2026-09-20", deposit: "1", loaded: "1", gameId: juwa._id },
      Buffer.from("this is not an image at all, just text"),
      "fake.avif"
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_TYPE");
  });

  test("rejects files over 5MB", async () => {
    const big = Buffer.concat([avif(7), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await submit(userA.token, { date: "2026-09-20", deposit: "1", loaded: "1", gameId: juwa._id }, big);
    expect(res.status).toBe(413);
  });

  test("duplicate screenshot needs confirmation and reuses the Cloudinary asset", async () => {
    const fields = { date: "2026-09-21", deposit: "300", loaded: "300", gameId: fireKirin._id };
    const file = avif(42);
    cloud.uploadScreenshot.mockClear();
    expect((await submit(userA.token, fields, file)).status).toBe(201);
    expect(cloud.uploadScreenshot).toHaveBeenCalledTimes(1);

    const dup = await submit(userA.token, fields, file);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_SCREENSHOT");
    expect(dup.body.existing.id).toBeDefined();

    const ok = await submit(userA.token, { ...fields, allowDuplicate: "true" }, file);
    expect(ok.status).toBe(201);
    expect(cloud.uploadScreenshot).toHaveBeenCalledTimes(1); // reused, not re-uploaded

    // Another user uploading identical bytes also reuses the asset without a prompt
    const other = await submit(userB.token, fields, file);
    expect(other.status).toBe(201);
    expect(cloud.uploadScreenshot).toHaveBeenCalledTimes(1);
    const ids = await Payment.distinct("screenshot.publicId", { screenshotHash: (await Payment.findById(ok.body.payment.id)).screenshotHash });
    expect(ids).toHaveLength(1);
  });

  test("cleans up the uploaded asset if the database write fails", async () => {
    cloud.destroy.mockClear();
    const spy = jest.spyOn(Payment, "create").mockRejectedValueOnce(new Error("db down"));
    const res = await submit(userA.token, { date: "2026-09-20", deposit: "1", loaded: "1", gameId: juwa._id }, avif(1234));
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal server error");
    expect(cloud.destroy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("accepts PNG", async () => {
    const res = await submit(userB.token, { date: "2026-09-18", deposit: "700", loaded: "650", gameId: juwa._id }, png(), "a.png");
    expect(res.status).toBe(201);
  });
});

describe("user data isolation", () => {
  test("users only see their own payments", async () => {
    const mine = await request(app).get("/api/payments").set(auth(userA.token));
    const theirs = await request(app).get("/api/payments").set(auth(userB.token));
    expect(mine.body.items.length).toBeGreaterThan(0);
    const bobIds = theirs.body.items.map((i) => String(i.id));
    expect(mine.body.items.some((i) => bobIds.includes(String(i.id)))).toBe(false);

    const res = await request(app).get(`/api/payments/${bobIds[0]}`).set(auth(userA.token));
    expect(res.status).toBe(404);
  });

  test("user summary uses aggregation totals", async () => {
    const res = await request(app).get("/api/payments/summary").set(auth(userB.token));
    expect(res.body).toEqual({
      totalDeposit: 100000,
      totalLoaded: 95000,
      totalRedeemed: 0,
      totalCashout: 0,
      redeemedByGame: [
        { gameId: String(fireKirin._id), game: "Fire Kirin", redeemed: 0 },
        { gameId: String(juwa._id), game: "Juwa", redeemed: 0 },
      ],
    });
  });

  test("list items are compact", async () => {
    const res = await request(app).get("/api/payments?limit=500").set(auth(userA.token));
    expect(res.body.items.length).toBeLessThanOrEqual(50);
    const item = res.body.items[0];
    expect(Object.keys(item).sort()).toEqual(["date", "deposit", "game", "id", "loaded", "redeemed", "cashout", "paymentMethod", "player", "thumb", "cashoutThumb"].sort());
  });
});

describe("admin", () => {
  test("summary totals match data", async () => {
    const res = await request(app).get("/api/admin/summary").set(auth(adminTok));
    const all = await Payment.find().lean();
    expect(res.body.count).toBe(all.length);
    expect(res.body.totalDeposit).toBe(all.reduce((s, p) => s + p.deposit, 0));
    expect(res.body.totalUsers).toBe(3);
    expect(res.body.edited).toBe(0);
    expect(res.body).not.toHaveProperty("pending");
  });

  test("filters by game, user and date; pagination is capped", async () => {
    const byGame = await request(app).get(`/api/admin/payments?gameId=${fireKirin._id}`).set(auth(adminTok));
    expect(byGame.body.items.every((i) => i.game === "Fire Kirin")).toBe(true);
    expect(byGame.body.items[0].user.username).toBeDefined();

    const byUser = await request(app).get(`/api/admin/payments?search=bo`).set(auth(adminTok));
    expect(byUser.body.items.every((i) => i.user.username === "bob")).toBe(true);

    const byDate = await request(app).get("/api/admin/payments?dateFrom=2026-09-20&dateTo=2026-09-20").set(auth(adminTok));
    expect(byDate.body.items.every((i) => String(i.date).startsWith("2026-09-20"))).toBe(true);
    expect(byDate.body.total).toBe(1);

    const capped = await request(app).get("/api/admin/payments?limit=10000").set(auth(adminTok));
    expect(capped.body.items.length).toBeLessThanOrEqual(100);

    expect((await request(app).get("/api/admin/payments?gameId=notanid").set(auth(adminTok))).status).toBe(400);
  });

  test("verify / reject no longer exist; detail has no review fields", async () => {
    const [p1] = await Payment.find({ userId: userB.id }).sort({ date: 1 });
    expect((await request(app).patch(`/api/admin/payments/${p1._id}/verify`).set(auth(adminTok))).status).toBe(404);
    expect((await request(app).patch(`/api/admin/payments/${p1._id}/reject`).set(auth(adminTok)).send({ reason: "x" })).status).toBe(404);

    const detail = await request(app).get(`/api/admin/payments/${p1._id}`).set(auth(adminTok));
    expect(detail.body.screenshot).toContain("res.cloudinary.com");
    for (const k of ["status", "verifiedBy", "verifiedAt", "rejectionReason"]) expect(detail.body).not.toHaveProperty(k);
  });

  test("users list includes per-user totals; user summary works", async () => {
    const res = await request(app).get("/api/admin/users").set(auth(adminTok));
    const bob = res.body.items.find((u) => u.username === "bob");
    expect(bob).toMatchObject({ count: 2, totalDeposit: 100000, edited: 0 });
    expect(bob.role).toBe("user");
    expect(res.body.items.find((u) => u.username === "boss")).toMatchObject({ role: "admin", count: 0 });

    const s = await request(app).get(`/api/admin/users/${userB.id}/summary`).set(auth(adminTok));
    expect(s.body).toMatchObject({ username: "bob", role: "user", count: 2 });
  });

  test("games summary groups by game", async () => {
    const res = await request(app).get("/api/admin/games/summary").set(auth(adminTok));
    const byName = Object.fromEntries(res.body.map((r) => [r.game, r]));
    const juwaCount = await Payment.countDocuments({ gameId: juwa._id });
    expect(byName.Juwa.count).toBe(juwaCount);
  });

  test("game management: create, rename, disable, reorder (with audit)", async () => {
    const c = await request(app).post("/api/admin/games").set(auth(adminTok)).send({ name: "Orion Stars" });
    expect(c.status).toBe(201);
    expect((await request(app).post("/api/admin/games").set(auth(adminTok)).send({ name: "orion stars" })).status).toBe(409);

    await request(app).patch(`/api/admin/games/${juwa._id}`).set(auth(adminTok)).send({ active: false });
    const active = await request(app).get("/api/games").set(auth(userA.token));
    expect(active.body.map((g) => g.name)).not.toContain("Juwa");

    // Historical payments still show the disabled game's name
    const hist = await request(app).get("/api/payments").set(auth(userA.token));
    expect(hist.body.items.some((i) => i.game === "Juwa")).toBe(true);

    await request(app).post(`/api/admin/games/${c.body.id}/move`).set(auth(adminTok)).send({ direction: "up" });
    const all = await request(app).get("/api/admin/games").set(auth(adminTok));
    const names = all.body.map((g) => g.name);
    expect(names.indexOf("Orion Stars")).toBeLessThan(names.indexOf("Old Game"));

    expect(await AuditLog.countDocuments({ action: "game.create" })).toBe(1);
    expect(await AuditLog.countDocuments({ action: "game.toggle" })).toBe(1);
    const audit = await request(app).get("/api/admin/audit").set(auth(adminTok));
    expect(audit.body.items[0].admin).toBe("boss");
  });

  test("CSV export respects filters", async () => {
    const res = await request(app)
      .get("/api/admin/payments/export.csv?search=bob&dateFrom=2026-09-18&dateTo=2026-09-18")
      .set(auth(adminTok));
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("Created At,Edited At");
    expect(lines[0]).not.toContain("Status");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("bob");
    expect(lines[1]).toContain("700.00");
  });

  test("payment method and player filters narrow the list and exports; PDF export works", async () => {
    const res = await submit(userA.token, { date: "2026-09-19", deposit: "12", loaded: "12", paymentMethod: "chime", player: "Zed Chimer", gameId: fireKirin._id }, avif(9401));
    expect(res.status).toBe(201);

    const byMethod = await request(app).get("/api/admin/payments?paymentMethod=chime").set(auth(adminTok));
    expect(byMethod.body.items.length).toBeGreaterThan(0);
    expect(byMethod.body.items.every((i) => i.paymentMethod === "chime")).toBe(true);
    const byPlayer = await request(app).get("/api/admin/payments?player=zed%20chi").set(auth(adminTok));
    expect(byPlayer.body.items.map((i) => i.player)).toEqual(["Zed Chimer"]);
    expect((await request(app).get("/api/admin/payments?paymentMethod=bitcoin").set(auth(adminTok))).status).toBe(400);

    const csv = await request(app).get("/api/admin/payments/export.csv?player=Zed").set(auth(adminTok));
    expect(csv.text.trim().split("\n")).toHaveLength(2);

    const pdf = await request(app)
      .get("/api/admin/payments/export.pdf?paymentMethod=chime")
      .set(auth(adminTok))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    expect((await request(app).get("/api/admin/payments/export.pdf").set(auth(userA.token))).status).toBe(403);

    await request(app).delete(`/api/admin/payments/${res.body.payment.id}`).set(auth(adminTok));
  });
});

describe("booking API (delta writes)", () => {
  test("create team, add/update/delete booking with delta responses", async () => {
    const h = auth(userA.token);
    const Booking = mongoose.model("bookingData");
    const created = await request(app)
      .post("/api/bookingData")
      .set(h)
      .send({ teamName: "Team (X)", bookings: [], userId: userB.id });
    expect(created.status).toBe(200);
    expect(Object.keys(created.body).sort()).toEqual(["_id", "bookings", "teamName"]);
    const team = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(String(team.userId)).toBe(userA.id); // userId in body is ignored

    const enc = encodeURIComponent("Team (X)");
    const add1 = await request(app)
      .post(`/api/bookingData/${enc}/bookings`)
      .set(h)
      .send({ date: "2026-09-01", entryFee: "100", hacker: 1 });
    expect(add1.status).toBe(200);
    expect(add1.body.booking).toMatchObject({ date: "2026-09-01", entryFee: 100, paid: false });
    expect(add1.body.booking._id).toBeDefined();
    expect(add1.body.booking.hacker).toBeUndefined();
    await request(app).post(`/api/bookingData/${enc}/bookings`).set(h).send({ date: "2026-09-02", entryFee: 200 });
    await request(app).post(`/api/bookingData/${enc}/bookings`).set(h).send({ date: "2026-09-03", entryFee: 300 });

    // Update sends back only the changed fields and leaves the rest untouched
    const upd = await request(app).put(`/api/bookingData/${enc}/bookings/1`).set(h).send({ paid: true });
    expect(upd.body).toEqual({ index: 1, changes: { paid: true } });
    let doc = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(doc.bookings[1]).toMatchObject({ date: "2026-09-02", entryFee: 200, paid: true });

    expect((await request(app).put(`/api/bookingData/${enc}/bookings/9`).set(h).send({ paid: true })).status).toBe(400);
    expect((await request(app).put(`/api/bookingData/nope/bookings/0`).set(h).send({ paid: true })).status).toBe(404);
    doc = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(doc.bookings).toHaveLength(3); // out-of-range update did not create entries

    // Delete by index removes exactly that element (middle, then first)
    expect((await request(app).delete(`/api/bookingData/${enc}/bookings/1`).set(h)).body).toEqual({ index: 1 });
    doc = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(doc.bookings.map((b) => b.date)).toEqual(["2026-09-01", "2026-09-03"]);
    await request(app).delete(`/api/bookingData/${enc}/bookings/0`).set(h);
    doc = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(doc.bookings.map((b) => b.date)).toEqual(["2026-09-03"]);
    expect((await request(app).delete(`/api/bookingData/${enc}/bookings/5`).set(h)).status).toBe(400);
    await request(app).delete(`/api/bookingData/${enc}/bookings/0`).set(h);
    doc = await Booking.findOne({ teamName: "Team (X)" }).lean();
    expect(doc.bookings).toEqual([]); // deleting the last element

    const list = await request(app).get("/api/bookingData").set(h);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].userId).toBeUndefined();
    expect((await request(app).get("/api/bookingData").set(auth(userB.token))).body).toHaveLength(0);
    expect((await request(app).delete(`/api/bookingData/${enc}`).set(h)).status).toBe(200);
    expect((await request(app).get("/api/bookingData").set(h)).body).toHaveLength(0);
  });
});

describe("caching", () => {
  test("ETag revalidation returns 304 with no body until data changes", async () => {
    const h = auth(userA.token);
    const first = await request(app).get("/api/payments/summary").set(h);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeDefined();
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const again = await request(app).get("/api/payments/summary").set(h).set("If-None-Match", first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.headers["x-cache"]).toBe("HIT");
    expect(again.text).toBe("");

    // A write bumps the version: the old ETag no longer matches and fresh data is returned
    await submit(userA.token, { date: "2026-09-15", deposit: "1", loaded: "1", gameId: fireKirin._id }, avif(777));
    const after = await request(app).get("/api/payments/summary").set(h).set("If-None-Match", first.headers.etag);
    expect(after.status).toBe(200);
    expect(after.body.totalDeposit).toBe(first.body.totalDeposit + 100);
  });

  test("cache is per user", async () => {
    const a = await request(app).get("/api/payments/summary").set(auth(userA.token));
    const b = await request(app).get("/api/payments/summary").set(auth(userB.token));
    expect(a.body).not.toEqual(b.body);
    const bAgain = await request(app)
      .get("/api/payments/summary")
      .set(auth(userB.token))
      .set("If-None-Match", a.headers.etag);
    expect(bAgain.status).toBe(200);
  });

  test("admin summary is invalidated by a new entry", async () => {
    const h = auth(adminTok);
    const before = await request(app).get("/api/admin/summary").set(h);
    await Game.updateOne({ _id: juwa._id }, { $set: { active: true } });
    const created = await submit(userB.token, { date: "2026-09-10", deposit: "3", loaded: "3", gameId: juwa._id }, avif(5150));
    expect(created.status).toBe(201);
    const after = await request(app).get("/api/admin/summary").set(h).set("If-None-Match", before.headers.etag);
    expect(after.status).toBe(200);
    expect(after.body.count).toBe(before.body.count + 1);
    await Payment.deleteOne({ _id: created.body.payment.id });
    await Game.updateOne({ _id: juwa._id }, { $set: { active: false } });
  });

  test("game list is cached and invalidated by game changes", async () => {
    const r1 = await request(app).get("/api/games").set(auth(userA.token));
    expect(r1.headers["cache-control"]).toBe("private, no-cache"); // always revalidated
    await request(app).post("/api/admin/games").set(auth(adminTok)).send({ name: "Panda Master" });
    const r2 = await request(app).get("/api/games").set(auth(userA.token));
    expect(r2.body.map((g) => g.name)).toContain("Panda Master");
  });
});

describe("delta sync", () => {
  const changesUrl = (base, sync, extra = "") =>
    `${base}?since=${encodeURIComponent(sync.cursor)}&v=${encodeURIComponent(sync.version)}${extra}`;

  test("user list carries a sync token; changes returns only changed rows", async () => {
    const h = auth(userB.token);
    const list = await request(app).get("/api/payments").set(h);
    const sync = list.body.sync;
    expect(sync.version).toBeDefined();

    // Nothing changed: 204 without touching the database
    const none = await request(app).get(changesUrl("/api/payments/changes", sync)).set(h);
    expect(none.status).toBe(204);

    const created = await submit(
      userB.token,
      { date: "2026-09-16", deposit: "5", loaded: "5", gameId: fireKirin._id },
      avif(888)
    );
    const ch = await request(app).get(changesUrl("/api/payments/changes", sync)).set(h);
    expect(ch.status).toBe(200);
    expect(ch.body.version).not.toBe(sync.version);
    const ids = ch.body.items.map((i) => String(i.id));
    expect(ids).toContain(String(created.body.payment.id));
    const mine = await Payment.find({ userId: userB.id }).select("_id").lean();
    expect(ids.every((id) => mine.some((m) => String(m._id) === id))).toBe(true);
    expect(ch.body.items[0]).toHaveProperty("createdAt");
    expect(ch.body.items[0]).toHaveProperty("match", true);
  });

  test("admin changes carry a user's edit with the editedAt marker", async () => {
    const h = auth(adminTok);
    const list = await request(app).get(`/api/admin/payments?userId=${userB.id}`).set(h);
    const target = await Payment.findOne({ userId: userB.id }).lean();
    const edited = request(app).patch(`/api/payments/${target._id}`).set(auth(userB.token));
    const fields = {
      date: target.date.toISOString().slice(0, 10),
      deposit: String(target.deposit / 100 + 1),
      loaded: String(target.loaded / 100),
      redeemed: String((target.redeemed || 0) / 100),
      paymentMethod: target.paymentMethod,
      player: target.player,
      gameId: String(target.gameId),
    };
    Object.entries(fields).forEach(([k, v]) => edited.field(k, v));
    // Keeping a game that has since been disabled is allowed
    expect((await edited).status).toBe(200);

    const ch = await request(app).get(changesUrl("/api/admin/payments/changes", list.body.sync, `&userId=${userB.id}`)).set(h);
    const row = ch.body.items.find((i) => String(i.id) === String(target._id));
    expect(row).toMatchObject({ match: true, deposit: target.deposit + 100 });
    expect(row.editedAt).toBeDefined();
    expect(row.user.username).toBe("bob");
    expect(row).not.toHaveProperty("status");
    // Restore bob's data for later tests
    await Payment.updateOne({ _id: target._id }, { $set: { deposit: target.deposit }, $unset: { editedAt: 1 } });
    await PaymentEdit.deleteMany({ paymentId: target._id });
  });

  test("rejects a bad cursor and is admin-only", async () => {
    expect((await request(app).get("/api/payments/changes?since=garbage").set(auth(userA.token))).status).toBe(400);
    const url = `/api/admin/payments/changes?since=${new Date().toISOString()}`;
    expect((await request(app).get(url).set(auth(userA.token))).status).toBe(403);
  });
});

describe("user role management", () => {
  const adminLogin = (username, password) => request(app).post("/api/auth/admin/login").send({ username, password });

  test("admin creates users with a role; validation and duplicates are rejected", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set(auth(adminTok))
      .send({ username: "  carol  ", password: "carolpass1", role: "admin", adminAuth: "test-register-code" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: "carol", role: "admin", count: 0 });
    expect((await adminLogin("carol", "carolpass1")).status).toBe(200);

    const plain = await request(app).post("/api/admin/users").set(auth(adminTok)).send({ username: "dave", password: "davepass1" });
    expect(plain.body.role).toBe("user");
    expect((await adminLogin("dave", "davepass1")).status).toBe(403);

    const post = (body) => request(app).post("/api/admin/users").set(auth(adminTok)).send(body);
    expect((await post({ username: "carol", password: "whatever1" })).status).toBe(409);
    expect((await post({ username: "erin", password: "erinpass1", role: "root" })).status).toBe(400);
    expect((await post({ username: "ab", password: "erinpass1" })).status).toBe(400);
    expect((await post({ username: "erin", password: "123" })).status).toBe(400);

    expect(await AuditLog.countDocuments({ action: "user.create" })).toBe(2);
  });

  test("only admins can create users or change roles", async () => {
    const create = await request(app).post("/api/admin/users").set(auth(userA.token)).send({ username: "sneaky", password: "sneaky123", role: "admin" });
    expect(create.status).toBe(403);
    const promote = await request(app).patch(`/api/admin/users/${userA.id}/role`).set(auth(userA.token)).send({ role: "admin" });
    expect(promote.status).toBe(403);
    expect((await User.findById(userA.id).lean()).role).toBe("user");
  });

  test("granting or removing admin needs the admin auth code", async () => {
    const setRole = (id, body) => request(app).patch(`/api/admin/users/${id}/role`).set(auth(adminTok)).send(body);
    for (const adminAuth of [undefined, "", "wrong-code"]) {
      const res = await setRole(userB.id, { role: "admin", adminAuth });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("INVALID_AUTH_CODE");
    }
    expect((await User.findById(userB.id).lean()).role).toBe("user");

    const post = (body) => request(app).post("/api/admin/users").set(auth(adminTok)).send(body);
    const noCode = await post({ username: "frank", password: "frankpass1", role: "admin" });
    expect(noCode.status).toBe(403);
    expect(noCode.body.code).toBe("INVALID_AUTH_CODE");
    expect(await User.exists({ username: "frank" })).toBeNull();
    // Plain users need no code
    expect((await post({ username: "frank", password: "frankpass1" })).status).toBe(201);
  });

  test("promote and demote, with self-demote and last-admin guards", async () => {
    const setRole = (id, role, tok = adminTok, adminAuth = "test-register-code") =>
      request(app).patch(`/api/admin/users/${id}/role`).set(auth(tok)).send({ role, adminAuth });

    const up = await setRole(userB.id, "admin");
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ username: "bob", role: "admin" });
    expect((await adminLogin("bob", "secret123")).status).toBe(200);

    const down = await setRole(userB.id, "user");
    expect(down.body.role).toBe("user");
    expect((await adminLogin("bob", "secret123")).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: "user.role" })).toBe(2);

    // No-op change writes nothing
    await setRole(userB.id, "user");
    expect(await AuditLog.countDocuments({ action: "user.role" })).toBe(2);

    expect((await setRole(userB.id, "superuser")).status).toBe(400);
    expect((await setRole("notanid", "admin")).status).toBe(400);
    expect((await setRole(new mongoose.Types.ObjectId(), "admin")).status).toBe(404);

    const boss = await User.findOne({ username: "boss" }).lean();
    const self = await setRole(boss._id, "user");
    expect(self.status).toBe(400);
    expect(self.body.code).toBe("SELF_DEMOTE");

    // Another admin can demote a non-last admin, and a demoted admin loses API access immediately
    const carolTok = (await adminLogin("carol", "carolpass1")).body.token;
    expect((await setRole(boss._id, "user", carolTok)).status).toBe(200);
    expect((await request(app).get("/api/admin/users").set(auth(adminTok))).status).toBe(403);
    expect((await setRole(boss._id, "admin", carolTok)).status).toBe(200);
  });
});

describe("admin auth-code role endpoint", () => {
  const setRole = (body) => request(app).post("/api/auth/admin/set-role").send(body);
  const base = { username: "alice", password: "secret123", adminAuth: "test-register-code" };

  test("rejects a bad code or bad credentials without changing the role", async () => {
    expect((await setRole({ ...base, adminAuth: "wrong", setAdmin: "true" })).status).toBe(403);
    expect((await setRole({ ...base, adminAuth: undefined, setAdmin: "true" })).status).toBe(403);
    expect((await setRole({ ...base, password: "nope123", setAdmin: "true" })).status).toBe(401);
    expect((await setRole({ ...base, setAdmin: "maybe" })).status).toBe(400);
    expect((await setRole({ ...base, username: "", setAdmin: true })).status).toBe(400);
    expect((await User.findById(userA.id).lean()).role).toBe("user");
  });

  test("setAdmin true grants admin and signs in; false removes it", async () => {
    const up = await setRole({ ...base, setAdmin: "true" });
    expect(up.status).toBe(200);
    expect(up.body.user.role).toBe("admin");
    const me = await request(app).get("/api/auth/me").set(auth(up.body.token));
    expect(me.body.user.role).toBe("admin");
    expect((await request(app).get("/api/admin/users").set(auth(up.body.token))).status).toBe(200);
    expect((await request(app).post("/api/auth/admin/login").send({ username: "alice", password: "secret123" })).status).toBe(200);

    const audit = await AuditLog.findOne({ action: "user.role", "metadata.via": "auth-code" }).lean();
    expect(audit.metadata).toMatchObject({ username: "alice", from: "user", to: "admin" });

    const down = await setRole({ ...base, setAdmin: false });
    expect(down.status).toBe(200);
    expect(down.body.token).toBeUndefined();
    expect(down.body.user.role).toBe("user");
    expect((await request(app).post("/api/auth/admin/login").send({ username: "alice", password: "secret123" })).status).toBe(403);
  });

  test("cannot remove the last admin", async () => {
    const others = await User.find({ role: "admin", username: { $ne: "boss" } }).select("_id").lean();
    await User.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { role: "user" } });
    try {
      const res = await setRole({ username: "boss", password: "adminpass123", adminAuth: "test-register-code", setAdmin: "false" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("LAST_ADMIN");
      expect((await User.findOne({ username: "boss" }).lean()).role).toBe("admin");
    } finally {
      await User.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { role: "admin" } });
    }
  });
});

describe("editing entries", () => {
  let base;
  const makeBase = () => ({ date: "2026-09-16", deposit: "20", loaded: "18", redeemed: "10", paymentMethod: "venmo", player: "Ace", gameId: juwa._id });
  const edit = (tok, id, fields, file = null, cashoutProof = null) => {
    const req = request(app).patch(`/api/payments/${id}`).set(auth(tok));
    Object.entries(fields).forEach(([k, v]) => v !== null && req.field(k, String(v)));
    if (file) req.attach("screenshot", file, "shot.avif");
    if (cashoutProof) req.attach("cashoutProof", cashoutProof, "cashout.png");
    return req;
  };
  let id;

  beforeAll(async () => {
    // An earlier test disables Juwa; this block needs it active
    await Game.updateOne({ _id: juwa._id }, { $set: { active: true } });
    base = makeBase();
    const res = await submit(userA.token, base, avif(901));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    id = res.body.payment.id;
  });
  afterAll(async () => {
    await Payment.deleteOne({ _id: id });
    await Game.updateOne({ _id: juwa._id }, { $set: { active: false } });
  });

  test("updates fields and keeps the screenshot when none is sent", async () => {
    const before = await Payment.findById(id).lean();
    const res = await edit(userA.token, id, { ...base, deposit: "25.50", paymentMethod: "zelle", player: "Ace2", gameId: fireKirin._id });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ deposit: 2550, paymentMethod: "zelle", player: "Ace2", game: "Fire Kirin" });
    expect(res.body.payment.editedAt).toBeDefined();
    expect(res.body.payment).not.toHaveProperty("status");

    // Logged field by field; the game is stored by name
    const log = await PaymentEdit.findOne({ paymentId: id }).lean();
    expect(String(log.userId)).toBe(userA.id);
    expect(log.changes).toEqual([
      { field: "game", from: "Juwa", to: "Fire Kirin" },
      { field: "player", from: "Ace", to: "Ace2" },
      { field: "paymentMethod", from: "venmo", to: "zelle" },
      { field: "deposit", from: 2000, to: 2550 },
    ]);
    const after = await Payment.findById(id).lean();
    expect(after.screenshotHash).toBe(before.screenshotHash);
    const detail = await request(app).get(`/api/payments/${id}`).set(auth(userA.token));
    expect(String(detail.body.gameId)).toBe(String(fireKirin._id));
  });

  test("validates like create, and other users get 404", async () => {
    expect((await edit(userA.token, id, { ...base, paymentMethod: "cash" })).body.code).toBe("INVALID_PAYMENT_METHOD");
    expect((await edit(userA.token, id, { ...base, redeemed: null })).body.code).toBe("REDEEMED_REQUIRED");
    expect((await edit(userA.token, id, { ...base, gameId: disabledGame._id })).body.code).toBe("GAME_UNAVAILABLE");
    expect((await edit(userB.token, id, base)).status).toBe(404);
    expect((await edit(userA.token, id, base, Buffer.from("text, not an image at all"))).body.code).toBe("UNSUPPORTED_TYPE");
  });

  test("replaces the screenshot and adds, keeps, then replaces the cashout screenshot", async () => {
    const res = await edit(userA.token, id, { ...base, cashout: "4" }, avif(902), png());
    expect(res.status).toBe(200);
    let doc = await Payment.findById(id).lean();
    expect(doc.cashout).toBe(400);
    expect(doc.cashoutProof.publicId).toContain("payments/cashout/");
    expect(doc.screenshot.publicId).toBe(`payments/${doc.screenshotHash}`);
    const first = doc.cashoutProof.publicId;

    // Not sending a new screenshot keeps the current one, even with cashout 0
    expect((await edit(userA.token, id, { ...base, cashout: "0" })).status).toBe(200);
    doc = await Payment.findById(id).lean();
    expect(doc.cashout).toBe(0);
    expect(doc.cashoutProof.publicId).toBe(first);

    // A different image replaces it, and the old asset is cleaned up
    cloud.destroy.mockClear();
    const png2 = Buffer.concat([png(), Buffer.from("different")]);
    expect((await edit(userA.token, id, { ...base, cashout: "5" }, null, png2)).status).toBe(200);
    doc = await Payment.findById(id).lean();
    expect(doc.cashoutProof.publicId).not.toBe(first);
    expect(cloud.destroy).toHaveBeenCalledWith(first);
  });

  test("image changes are logged; a no-op edit logs nothing", async () => {
    const logs = await PaymentEdit.find({ paymentId: id }).sort({ createdAt: 1, _id: 1 }).lean();
    const fields = logs.map((l) => l.changes.map((c) => c.field));
    // Screenshot + first cashout screenshot, then only the cashout amount, then a replaced cashout screenshot
    expect(fields[1]).toEqual(expect.arrayContaining(["screenshot", "cashoutProof", "cashout"]));
    expect(logs[1].changes.find((c) => c.field === "screenshot").to).toBe("replaced");
    expect(logs[1].changes.find((c) => c.field === "cashoutProof").to).toBe("added");
    expect(fields[2]).toEqual(["cashout"]);
    expect(logs[3].changes).toEqual([
      { field: "cashout", from: 0, to: 500 },
      { field: "cashoutProof", from: null, to: "replaced" },
    ]);

    const before = await Payment.findById(id).lean();
    const same = await edit(userA.token, id, { ...base, cashout: "5" });
    expect(same.status).toBe(200);
    expect(await PaymentEdit.countDocuments({ paymentId: id })).toBe(logs.length);
    expect((await Payment.findById(id).lean()).editedAt).toEqual(before.editedAt);
  });

  test("admin sees a user's edits: what changed and when", async () => {
    expect((await edit(userA.token, id, { ...base, cashout: "5", deposit: "21" })).status).toBe(200);

    const res = await request(app).get(`/api/admin/edits?userId=${userA.id}`).set(auth(adminTok));
    expect(res.status).toBe(200);
    const [latest] = res.body.items;
    expect(latest).toMatchObject({
      paymentId: id,
      game: "Juwa",
      user: { id: userA.id, username: "alice" },
      changes: [{ field: "deposit", from: 2000, to: 2100 }],
    });
    expect(String(latest.paymentDate)).toMatch(/^2026-09-16/);
    expect(new Date(latest.createdAt).getTime()).toBeGreaterThan(Date.now() - 60000);

    const byEntry = await request(app).get(`/api/admin/edits?paymentId=${id}`).set(auth(adminTok));
    expect(byEntry.body.total).toBe(await PaymentEdit.countDocuments({ paymentId: id }));
    expect((await request(app).get(`/api/admin/edits?userId=${userB.id}`).set(auth(adminTok))).body.total).toBe(0);
    expect((await request(app).get("/api/admin/edits?userId=bad").set(auth(adminTok))).status).toBe(400);
    expect((await request(app).get("/api/admin/edits").set(auth(userA.token))).status).toBe(403);
  });

  test("permanently deleting an entry removes its edit history", async () => {
    expect((await request(app).delete(`/api/admin/payments/${id}`).set(auth(adminTok))).status).toBe(200);
    expect(await PaymentEdit.countDocuments({ paymentId: id })).toBe(0);
  });
});

describe("deleting entries", () => {
  const changesUrl = (base, sync) => `${base}?since=${encodeURIComponent(sync.cursor)}&v=${encodeURIComponent(sync.version)}`;
  let id;

  beforeAll(async () => {
    await Game.updateOne({ _id: juwa._id }, { $set: { active: true } });
    const res = await submit(userA.token, { date: "2026-09-17", deposit: "40", loaded: "40", redeemed: "7", gameId: juwa._id }, avif(4242));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    id = String(res.body.payment.id);
  });
  afterAll(() => Game.updateOne({ _id: juwa._id }, { $set: { active: false } }));

  test("user delete hides the entry on the user side only", async () => {
    const h = auth(userA.token);
    const list = await request(app).get("/api/payments").set(h);
    expect(list.body.items.map((i) => String(i.id))).toContain(id);
    const before = await request(app).get("/api/payments/summary").set(h);

    // Another user can't touch it
    expect((await request(app).delete(`/api/payments/${id}`).set(auth(userB.token))).status).toBe(404);

    const del = await request(app).delete(`/api/payments/${id}`).set(h);
    expect(del.status).toBe(200);
    expect((await request(app).delete(`/api/payments/${id}`).set(h)).status).toBe(404); // already deleted

    // Gone from the user's list, summary, detail and edit - with a fresh body, not a stale cached one
    const after = await request(app).get("/api/payments").set(h).set("If-None-Match", list.headers.etag);
    expect(after.status).toBe(200);
    expect(after.body.items.map((i) => String(i.id))).not.toContain(id);
    const sum = await request(app).get("/api/payments/summary").set(h);
    expect(sum.body.totalDeposit).toBe(before.body.totalDeposit - 4000);
    expect((await request(app).get(`/api/payments/${id}`).set(h)).status).toBe(404);
    expect((await request(app).patch(`/api/payments/${id}`).set(h).field("deposit", "1")).status).toBe(404);

    // The user's delta feed tells open pages to drop it
    const ch = await request(app).get(changesUrl("/api/payments/changes", list.body.sync)).set(h);
    expect(ch.body.items.find((i) => String(i.id) === id)).toMatchObject({ match: false });

    // The admin still sees it, flagged
    const admin = await request(app).get("/api/admin/payments").set(auth(adminTok));
    const row = admin.body.items.find((i) => String(i.id) === id);
    expect(row.userDeletedAt).toBeDefined();
    const detail = await request(app).get(`/api/admin/payments/${id}`).set(auth(adminTok));
    expect(detail.body.userDeletedAt).toBeDefined();
  });

  test("only an admin can delete permanently; delta feeds get a tombstone", async () => {
    expect((await request(app).delete(`/api/admin/payments/${id}`).set(auth(userA.token))).status).toBe(403);

    const adminList = await request(app).get("/api/admin/payments").set(auth(adminTok));
    const userList = await request(app).get("/api/payments").set(auth(userA.token));

    const del = await request(app).delete(`/api/admin/payments/${id}`).set(auth(adminTok));
    expect(del.status).toBe(200);
    expect(await Payment.exists({ _id: id })).toBeNull();
    expect(await DeletedPayment.exists({ paymentId: id })).not.toBeNull();
    expect(await AuditLog.exists({ action: "payment.delete", targetId: id })).not.toBeNull();
    expect((await request(app).delete(`/api/admin/payments/${id}`).set(auth(adminTok))).status).toBe(404);

    for (const [url, tok, sync] of [
      ["/api/admin/payments/changes", adminTok, adminList.body.sync],
      ["/api/payments/changes", userA.token, userList.body.sync],
    ]) {
      const ch = await request(app).get(changesUrl(url, sync)).set(auth(tok));
      expect(ch.status).toBe(200);
      expect(ch.body.items.find((i) => String(i.id) === id)).toMatchObject({ deleted: true, match: false });
    }

    const after = await request(app).get("/api/admin/payments").set(auth(adminTok)).set("If-None-Match", adminList.headers.etag);
    expect(after.status).toBe(200);
    expect(after.body.items.map((i) => String(i.id))).not.toContain(id);
  });
});

describe("cashout totals", () => {
  let id;
  beforeAll(() => Game.updateOne({ _id: juwa._id }, { $set: { active: true } }));
  afterAll(async () => {
    if (id) await Payment.deleteOne({ _id: id });
    await Game.updateOne({ _id: juwa._id }, { $set: { active: false } });
  });

  test("cashout is its own total; redeemed is not reduced by it", async () => {
    const base = { date: "2026-09-18", deposit: "50", loaded: "50", gameId: juwa._id };
    const before = (await request(app).get("/api/payments/summary").set(auth(userB.token))).body;
    const res = await submit(userB.token, { ...base, redeemed: "30", cashout: "45.50" }, avif(7002), "shot.avif", png());
    expect(res.status).toBe(201);
    id = res.body.payment.id;

    const list = await request(app).get("/api/payments").set(auth(userB.token));
    const row = list.body.items.find((i) => String(i.id) === String(id));
    expect(row).toMatchObject({ redeemed: 3000, cashout: 4550 });
    expect(row.cashoutThumb).toContain("payments/cashout/");

    const after = (await request(app).get("/api/payments/summary").set(auth(userB.token))).body;
    expect(after.totalRedeemed - before.totalRedeemed).toBe(3000);
    expect(after.totalCashout - before.totalCashout).toBe(4550);
    const juwaRow = after.redeemedByGame.find((g) => g.gameId === String(juwa._id));
    expect(juwaRow.redeemed).toBeGreaterThanOrEqual(3000);
  });
});

describe("game points pool", () => {
  let game;
  const pointsOf = async () => {
    const res = await request(app).get("/api/admin/games").set(auth(adminTok));
    return res.body.find((g) => g.id === String(game._id));
  };

  beforeAll(async () => {
    game = await Game.create({ name: "Ultra Panda", slug: "ultra-panda", sortOrder: 9 });
  });

  test("admin sets total points; loaded entries use them up; edits and deletes give them back", async () => {
    expect(await pointsOf()).toMatchObject({ totalPoints: null, used: 0, remaining: null });

    const set = await request(app).patch(`/api/admin/games/${game._id}`).set(auth(adminTok)).send({ totalPoints: "100" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ totalPoints: 10000, used: 0, remaining: 10000 });
    expect((await request(app).patch(`/api/admin/games/${game._id}`).set(auth(adminTok)).send({ totalPoints: "-5" })).status).toBe(400);

    const base = { date: "2026-09-18", deposit: "60", gameId: game._id };
    const ok = await submit(userA.token, { ...base, loaded: "60" }, avif(9101));
    expect(ok.status).toBe(201);
    expect(await pointsOf()).toMatchObject({ used: 6000, remaining: 4000 });

    // Users see the pool too
    const games = await request(app).get("/api/games").set(auth(userA.token));
    expect(games.body.find((g) => g.id === String(game._id))).toMatchObject({ totalPoints: 10000, remaining: 4000 });

    const over = await submit(userA.token, { ...base, loaded: "40.01" }, avif(9102));
    expect(over.status).toBe(400);
    expect(over.body.code).toBe("INSUFFICIENT_GAME_POINTS");

    // Editing "loaded" down gives points back; the entry's own old amount isn't counted twice
    const lower = request(app).patch(`/api/payments/${ok.body.payment.id}`).set(auth(userA.token));
    Object.entries({ ...base, loaded: "25", redeemed: "0", paymentMethod: "cashapp", player: "Player One" }).forEach(([k, v]) =>
      lower.field(k, String(v))
    );
    expect((await lower).status).toBe(200);
    expect(await pointsOf()).toMatchObject({ used: 2500, remaining: 7500 });

    await request(app).delete(`/api/admin/payments/${ok.body.payment.id}`).set(auth(adminTok));
    expect(await pointsOf()).toMatchObject({ used: 0, remaining: 10000 });

    // Blank = unlimited again
    const clear = await request(app).patch(`/api/admin/games/${game._id}`).set(auth(adminTok)).send({ totalPoints: "" });
    expect(clear.body).toMatchObject({ totalPoints: null, remaining: null });
  });

  test("redeemed points go back into the game's pool and are reported separately", async () => {
    await request(app).patch(`/api/admin/games/${game._id}`).set(auth(adminTok)).send({ totalPoints: "100" });
    const ok = await submit(userA.token, { date: "2026-09-18", deposit: "50", loaded: "50", redeemed: "20", gameId: game._id }, avif(9111));
    expect(ok.status).toBe(201);
    expect(await pointsOf()).toMatchObject({ totalPoints: 10000, used: 5000, redeemed: 2000, remaining: 7000 });
    const games = await request(app).get("/api/games").set(auth(userA.token));
    expect(games.body.find((g) => g.id === String(game._id))).toMatchObject({ remaining: 7000 });

    // The returned points can be loaded again
    const more = await submit(userA.token, { date: "2026-09-18", deposit: "70", loaded: "70", gameId: game._id }, avif(9112));
    expect(more.status).toBe(201);
    expect(await pointsOf()).toMatchObject({ used: 12000, redeemed: 2000, remaining: 0 });

    await request(app).delete(`/api/admin/payments/${ok.body.payment.id}`).set(auth(adminTok));
    await request(app).delete(`/api/admin/payments/${more.body.payment.id}`).set(auth(adminTok));
    await request(app).patch(`/api/admin/games/${game._id}`).set(auth(adminTok)).send({ totalPoints: "" });
  });
});

describe("user list sorting and player filter", () => {
  let sorter;
  const list = (query) => request(app).get(`/api/payments?${query}`).set(auth(sorter.token));
  const players = (res) => res.body.items.map((i) => i.player);
  const deposits = (res) => res.body.items.map((i) => i.deposit);

  beforeAll(async () => {
    await Game.updateOne({ _id: juwa._id }, { $set: { active: true } });
    sorter = await register("sortuser");
    const base = { date: "2026-09-12", loaded: "1", gameId: juwa._id };
    for (const [player, deposit, redeemed] of [["Superman", "10", "4"], ["SUPERMAN", "30", "1"], ["superman2", "20", "9"], ["batman", "5", "0"]]) {
      const res = await submit(sorter.token, { ...base, player, deposit, redeemed }, null);
      expect(res.status).toBe(201);
    }
  });
  afterAll(() => Game.updateOne({ _id: juwa._id }, { $set: { active: false } }));

  test("sorts by deposit high to low and low to high", async () => {
    expect(deposits(await list("sort=deposit&order=desc"))).toEqual([3000, 2000, 1000, 500]);
    expect(deposits(await list("sort=deposit&order=asc"))).toEqual([500, 1000, 2000, 3000]);
  });

  test("sorts by redeemed, and by player name ignoring case (A-Z by default)", async () => {
    expect((await list("sort=redeemed")).body.items.map((i) => i.redeemed)).toEqual([900, 400, 100, 0]);
    const byName = players(await list("sort=player"));
    expect(byName[0]).toBe("batman");
    expect(byName[3]).toBe("superman2");
    expect(players(await list("sort=player&order=desc"))[0]).toBe("superman2");
  });

  test("player filter matches the exact name in any case, not longer names", async () => {
    const res = await list("player=superman&sort=deposit");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(players(res)).toEqual(["SUPERMAN", "Superman"]);
    // Regex characters are taken literally
    expect((await list("player=super.*")).body.total).toBe(0);
  });

  test("summary follows the player filter", async () => {
    const all = await request(app).get("/api/payments/summary").set(auth(sorter.token));
    const sup = await request(app).get("/api/payments/summary?player=SuperMan").set(auth(sorter.token));
    expect(all.body.totalDeposit).toBe(6500);
    expect(sup.body.totalDeposit).toBe(4000);
    expect(sup.body.totalRedeemed).toBe(500);
  });

  test("admin totals include redeemed", async () => {
    const summary = await request(app).get(`/api/admin/users/${sorter.id}/summary`).set(auth(adminTok));
    expect(summary.body).toMatchObject({ count: 4, totalDeposit: 6500, totalRedeemed: 1400 });
    const users = await request(app).get("/api/admin/users?search=sortuser").set(auth(adminTok));
    expect(users.body.items[0]).toMatchObject({ username: "sortuser", totalRedeemed: 1400 });
    const overall = await request(app).get(`/api/admin/summary?userId=${sorter.id}`).set(auth(adminTok));
    expect(overall.body.totalRedeemed).toBe(1400);
    const games = await request(app).get(`/api/admin/games/summary?userId=${sorter.id}`).set(auth(adminTok));
    expect(games.body.find((g) => g.game === "Juwa").totalRedeemed).toBe(1400);
  });

  test("rejects unknown sort fields and orders", async () => {
    expect((await list("sort=password")).status).toBe(400);
    expect((await list("sort=deposit&order=sideways")).status).toBe(400);
  });
});

describe("live data-version events", () => {
  const http = require("http");
  let server;
  const open = [];

  beforeAll((done) => {
    server = app.listen(0, done);
  });
  afterAll((done) => {
    open.forEach((s) => s.close());
    server.close(done);
  });

  // Minimal SSE client: collects parsed events and lets a test wait for one
  const stream = (tok, depList = []) =>
    new Promise((resolve, reject) => {
      const path = `/api/events?deps=${encodeURIComponent(depList.join(","))}`;
      const req = http.get({ port: server.address().port, path, headers: { ...auth(tok), "Accept-Encoding": "gzip" } }, (res) => {
        const events = [];
        let buf = "";
        let wake = () => {};
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
          }
          wake();
        });
        const s = {
          res,
          events,
          close: () => req.destroy(),
          next: (pred, ms = 2000) =>
            new Promise((ok, fail) => {
              const timer = setTimeout(() => fail(new Error("no matching event: " + JSON.stringify(events))), ms);
              const check = () => {
                const hit = events.find(pred);
                if (hit) {
                  clearTimeout(timer);
                  ok(hit);
                }
              };
              wake = check;
              check();
            }),
        };
        open.push(s);
        resolve(s);
      });
      req.on("error", reject);
    });

  test("requires a valid token", async () => {
    expect((await request(app).get("/api/events")).status).toBe(401);
    expect((await request(app).get("/api/events").set(auth("garbage"))).status).toBe(401);
  });

  test("hello carries current versions of permitted deps only; the stream is not compressed", async () => {
    const s = await stream(userA.token, ["games", `payments:u:${userB.id}`, `bookings:u:${userB.id}`]);
    expect(s.res.headers["content-type"]).toContain("text/event-stream");
    expect(s.res.headers["content-encoding"]).toBeUndefined();
    const hello = await s.next((e) => e.event === "hello");
    expect(hello.data).toHaveProperty("games");
    expect(hello.data).toHaveProperty(`payments:u:${userA.id}`);
    expect(hello.data).not.toHaveProperty(`payments:u:${userB.id}`);
    expect(hello.data).not.toHaveProperty(`bookings:u:${userB.id}`);
    s.close();
  });

  test("a write is pushed to who may see it, never another user's private deps", async () => {
    const [a, b, admin] = await Promise.all([stream(userA.token), stream(userB.token), stream(adminTok)]);
    await Promise.all([a, b, admin].map((s) => s.next((e) => e.event === "hello")));

    const res = await submit(userB.token, { date: "2026-09-12", deposit: "2", loaded: "2", gameId: fireKirin._id }, avif(6060));
    expect(res.status).toBe(201);

    const own = `payments:u:${userB.id}`;
    expect((await b.next((e) => e.event === "bump" && e.data[own])).data).toHaveProperty("payments");
    expect((await admin.next((e) => e.event === "bump" && e.data[own])).data).toHaveProperty("payments");
    const forA = await a.next((e) => e.event === "bump" && e.data.payments);
    expect(forA.data).not.toHaveProperty(own);

    // Bookings are private too
    await request(app).post("/api/bookingData").set(auth(userB.token)).send({ teamName: "Live Team", bookings: [] });
    await b.next((e) => e.event === "bump" && e.data[`bookings:u:${userB.id}`]);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.events.some((e) => e.data[`bookings:u:${userB.id}`])).toBe(false);

    await Payment.deleteOne({ _id: res.body.payment.id });
    [a, b, admin].forEach((s) => s.close());
  });

  test("responses carry the data versions they reflect; writes report the new ones", async () => {
    const games = await request(app).get("/api/games").set(auth(userA.token));
    expect(games.headers["x-cache-versions"]).toMatch(/^games=\d+,payments=\d+$/);

    const team = await request(app).post("/api/bookingData").set(auth(userA.token)).send({ teamName: "Versioned", bookings: [] });
    expect(team.headers["x-data-versions"]).toMatch(new RegExp(`^bookings:u:${userA.id}=[0-9]+$`));
    const list = await request(app).get("/api/bookingData").set(auth(userA.token));
    // The list now reflects exactly the version the write reported
    expect(list.headers["x-cache-versions"]).toBe(team.headers["x-data-versions"]);

    const me = await request(app).get("/api/auth/me").set(auth(userA.token));
    expect(me.body.user.username).toBe("alice");
    const again = await request(app).get("/api/auth/me").set(auth(userA.token)).set("If-None-Match", me.headers.etag);
    expect(again.status).toBe(304);
  });

  test("a role change is pushed to that account", async () => {
    const s = await stream(userB.token);
    await s.next((e) => e.event === "hello");
    await request(app).patch(`/api/admin/users/${userB.id}/role`).set(auth(adminTok)).send({ role: "admin", adminAuth: "test-register-code" });
    await s.next((e) => e.event === "bump" && e.data[`user:${userB.id}`]);
    await request(app).patch(`/api/admin/users/${userB.id}/role`).set(auth(adminTok)).send({ role: "user", adminAuth: "test-register-code" });
    s.close();
  });
});

describe("admin user management: edit, password reset, delete", () => {
  const login = (username, password) => request(app).post("/api/auth/login").send({ username, password });

  test("rename keeps the session; duplicate names are rejected", async () => {
    const hank = await register("hank");
    const r = await request(app).patch(`/api/admin/users/${hank.id}`).set(auth(adminTok)).send({ username: "  henry  " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: "henry", role: "user" });
    expect((await request(app).patch(`/api/admin/users/${hank.id}`).set(auth(adminTok)).send({ username: "alice" })).status).toBe(409);
    expect((await request(app).patch(`/api/admin/users/${hank.id}`).set(auth(adminTok)).send({ username: "ab" })).status).toBe(400);

    const me = await request(app).get("/api/payments/summary").set(auth(hank.token));
    expect(me.status).toBe(200);
    const list = await request(app).get("/api/admin/users?search=henry").set(auth(adminTok));
    expect(list.body.items.map((u) => u.username)).toContain("henry");
  });

  test("password reset signs the user out everywhere", async () => {
    const erin = await register("erin");
    expect((await request(app).patch(`/api/admin/users/${erin.id}`).set(auth(adminTok)).send({ password: "123" })).status).toBe(400);
    const r = await request(app).patch(`/api/admin/users/${erin.id}`).set(auth(adminTok)).send({ password: "newpass99" });
    expect(r.status).toBe(200);

    expect((await request(app).get("/api/payments/summary").set(auth(erin.token))).status).toBe(401);
    expect((await login("erin", "secret123")).status).toBe(401);
    const ok = await login("erin", "newpass99");
    expect(ok.status).toBe(200);
    expect((await request(app).get("/api/payments/summary").set(auth(ok.body.token))).status).toBe(200);

    const log = await AuditLog.findOne({ action: "user.update", targetId: erin.id }).lean();
    expect(log.metadata.password).toBe(true);
    expect(JSON.stringify(log.metadata)).not.toContain("newpass99");
  });

  test("changing or deleting another admin needs the admin auth code; self-delete is refused", async () => {
    const c = await request(app)
      .post("/api/admin/users")
      .set(auth(adminTok))
      .send({ username: "ivan", password: "ivanpass1", role: "admin", adminAuth: "test-register-code" });
    const ivanId = c.body.id;
    expect((await request(app).patch(`/api/admin/users/${ivanId}`).set(auth(adminTok)).send({ username: "ivan2" })).status).toBe(403);
    const ok = await request(app)
      .patch(`/api/admin/users/${ivanId}`)
      .set(auth(adminTok))
      .send({ username: "ivan2", adminAuth: "test-register-code" });
    expect(ok.status).toBe(200);

    expect((await request(app).delete(`/api/admin/users/${ivanId}`).set(auth(adminTok))).status).toBe(403);
    expect((await request(app).delete(`/api/admin/users/${ivanId}`).set(auth(adminTok)).send({ adminAuth: "test-register-code" })).status).toBe(200);

    const boss = await User.findOne({ username: "boss" }).lean();
    const self = await request(app).delete(`/api/admin/users/${boss._id}`).set(auth(adminTok));
    expect(self.status).toBe(400);
    expect(self.body.code).toBe("SELF_DELETE");
  });

  test("deleting a user removes their entries, ends their session and returns game points", async () => {
    const game = await Game.create({ name: "Delete Test", slug: "delete-test", sortOrder: 20, totalPoints: 100000 });
    const gina = await register("gina");
    const sub = await submit(gina.token, { date: "2026-09-18", deposit: "70", loaded: "70", gameId: game._id }, avif(9301));
    expect(sub.status).toBe(201);
    const usedOf = async () =>
      (await request(app).get("/api/admin/games").set(auth(adminTok))).body.find((g) => g.id === String(game._id)).used;
    expect(await usedOf()).toBe(7000);

    const del = await request(app).delete(`/api/admin/users/${gina.id}`).set(auth(adminTok));
    expect(del.status).toBe(200);
    expect(del.body.entries).toBe(1);

    expect(await User.exists({ _id: gina.id })).toBeNull();
    expect(await Payment.countDocuments({ userId: gina.id })).toBe(0);
    expect(await DeletedPayment.countDocuments({ userId: gina.id })).toBe(1);
    expect(await usedOf()).toBe(0);
    expect((await request(app).get("/api/payments/summary").set(auth(gina.token))).status).toBe(401);
    expect(await AuditLog.countDocuments({ action: "user.delete", targetId: gina.id })).toBe(1);
    expect((await request(app).delete(`/api/admin/users/${gina.id}`).set(auth(adminTok))).status).toBe(404);
  });
});
