const bookingData = require("../models/booking.model.js");
const { escapeRegex } = require("../utils/validation.js");
const { sendCached, bump, deps, formatVersions } = require("../services/cache.js");

// Fields a client may write on a booking; anything else in the body is ignored
const BOOKING_FIELDS = [
  "customerName",
  "date",
  "time",
  "server",
  "entryFee",
  "winning",
  "discription",
  "caster",
  "casterCost",
  "production",
  "productionCost",
  "paid",
];

// Only what the UI renders; userId, timestamps and __v are never sent
const TEAM_FIELDS = "teamName bookings";

const teamFilter = (userId, teamName) => ({
  teamName: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, "i") },
  userId: userId,
});

const pickBookingFields = (body) => {
  const out = {};
  for (const k of BOOKING_FIELDS) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
};

// Cast values through the schema (e.g. "150" -> 150) without touching the database
const castBooking = (fields) => new bookingData().bookings.create(fields).toObject();

const parseIndex = (value) => {
  const i = Number(value);
  return Number.isInteger(i) && i >= 0 ? i : null;
};

const serverError = (res, error) => {
  console.error("Booking error:", error);
  res.status(500).json({ message: "Internal server error" });
};

const createTeam = async (req, res) => {
  try {
    const { teamName } = req.body;
    const userId = req.userId;

    if (typeof teamName !== "string" || !teamName.trim()) {
      return res.status(400).json({ message: "Team name is required" });
    }

    // Check if team already exists for this user
    if (await bookingData.exists(teamFilter(userId, teamName))) {
      return res.status(400).json({ message: "Team already exists" });
    }

    const bookings = Array.isArray(req.body.bookings) ? req.body.bookings.map(pickBookingFields) : [];
    const newTeam = await bookingData.create({ teamName, bookings, userId });
    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json({ _id: newTeam._id, teamName: newTeam.teamName, bookings: newTeam.bookings });
  } catch (error) {
    serverError(res, error);
  }
};

// Full list: cached per user and revalidated with ETag, so repeat loads cost a 304
const findTeams = async (req, res) => {
  try {
    const userId = req.userId;
    await sendCached(
      req,
      res,
      { name: "teams", deps: [deps.userBookings(userId)], scope: String(userId) },
      () => bookingData.find({ userId: userId }).select(TEAM_FIELDS).lean(),
    );
  } catch (error) {
    serverError(res, error);
  }
};

const deleteTeam = async (req, res) => {
  try {
    const { teamName } = req.params;
    const userId = req.userId;

    const result = await bookingData.deleteOne(teamFilter(userId, teamName));
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Team not found" });
    }

    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json({ message: "Team deleted successfully" });
  } catch (error) {
    serverError(res, error);
  }
};

const updateTeam = async (req, res) => {
  try {
    const { teamName } = req.params;
    const userId = req.userId;

    // Only the provided top-level fields are $set
    const update = {};
    if (typeof req.body.teamName === "string" && req.body.teamName.trim()) update.teamName = req.body.teamName;
    if (Array.isArray(req.body.bookings)) update.bookings = req.body.bookings.map(pickBookingFields);

    const updatedTeam = await bookingData
      .findOneAndUpdate(teamFilter(userId, teamName), { $set: update }, { new: true, projection: TEAM_FIELDS })
      .lean();

    if (!updatedTeam) {
      return res.status(404).json({ message: "Team not found" });
    }

    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json(updatedTeam);
  } catch (error) {
    serverError(res, error);
  }
};

// Delta write: $push one booking; responds with just that booking
const addBookingToTeam = async (req, res) => {
  try {
    const { teamName } = req.params;
    const userId = req.userId;

    const booking = castBooking(pickBookingFields(req.body));
    const result = await bookingData.updateOne(teamFilter(userId, teamName), { $push: { bookings: booking } });
    if (!result.matchedCount) {
      return res.status(404).json({ message: "Team not found" });
    }

    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json({ booking });
  } catch (error) {
    serverError(res, error);
  }
};

// Delta write: $set only the changed fields of one booking; responds with only those fields
const updateBookingInTeam = async (req, res) => {
  try {
    const { teamName } = req.params;
    const index = parseIndex(req.params.bookingIndex);
    const userId = req.userId;
    if (index === null) {
      return res.status(400).json({ message: "Invalid booking index" });
    }

    const fields = pickBookingFields(req.body);
    const casted = castBooking(fields);
    const changes = {};
    const $set = {};
    for (const k of Object.keys(fields)) {
      changes[k] = casted[k];
      $set[`bookings.${index}.${k}`] = casted[k];
    }
    if (!Object.keys($set).length) {
      return res.status(400).json({ message: "No booking fields to update" });
    }

    // The index must exist, so an out-of-range index is a no-op instead of creating a sparse entry
    const filter = { ...teamFilter(userId, teamName), [`bookings.${index}`]: { $exists: true } };
    const result = await bookingData.updateOne(filter, { $set });
    if (!result.matchedCount) {
      const teamExists = await bookingData.exists(teamFilter(userId, teamName));
      return teamExists
        ? res.status(400).json({ message: "Invalid booking index" })
        : res.status(404).json({ message: "Team not found" });
    }

    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json({ index, changes });
  } catch (error) {
    serverError(res, error);
  }
};

// Delta write: remove one array element atomically, without loading the team
const deleteBookingFromTeam = async (req, res) => {
  try {
    const { teamName } = req.params;
    const index = parseIndex(req.params.bookingIndex);
    const userId = req.userId;
    if (index === null) {
      return res.status(400).json({ message: "Invalid booking index" });
    }

    const filter = { ...teamFilter(userId, teamName), [`bookings.${index}`]: { $exists: true } };
    const result = await bookingData.updateOne(filter, [
      {
        $set: {
          bookings: {
            $concatArrays: [
              { $slice: ["$bookings", index] },
              { $slice: ["$bookings", index + 1, { $max: [1, { $size: "$bookings" }] }] },
            ],
          },
        },
      },
    ]);
    if (!result.matchedCount) {
      const teamExists = await bookingData.exists(teamFilter(userId, teamName));
      return teamExists
        ? res.status(400).json({ message: "Invalid booking index" })
        : res.status(404).json({ message: "Team not found" });
    }

    res.set("X-Data-Versions", formatVersions(await bump(deps.userBookings(userId))));
    res.status(200).json({ index });
  } catch (error) {
    serverError(res, error);
  }
};

module.exports = {
  createTeam,
  findTeams,
  deleteTeam,
  updateTeam,
  addBookingToTeam,
  updateBookingInTeam,
  deleteBookingFromTeam,
};
