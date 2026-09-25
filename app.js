const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const env = require("./config/env.js");
const bookingRoute = require("./route/bookingData.route.js");
const authRoute = require("./route/auth.route.js");
const gameRoute = require("./route/game.route.js");
const paymentRoute = require("./route/payment.route.js");
const adminRoute = require("./route/admin.route.js");
const eventsRoute = require("./route/events.route.js");
const { cacheStats } = require("./services/cache.js");
const errorHandler = require("./middleware/errorHandler.js");
const requestLogger = require("./middleware/requestLogger.js");

const app = express();

// Render sits behind a proxy; needed for correct client IPs in rate limiting
app.set("trust proxy", 1);
app.disable("x-powered-by");

// First, so every request is logged, including ones rejected by later middleware
app.use(requestLogger);

// JSON-only API: skip the headers that only matter for HTML documents (CSP, COEP/COOP, etc.).
// They were ~450 bytes on every response, including each bodiless 204/304 poll.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xPermittedCrossDomainPolicies: false,
    xXssProtection: false,
  })
);
// Never compress the event stream: gzip would buffer each small event until a chunk fills up
app.use(
  compression({
    filter: (req, res) => !String(res.getHeader("Content-Type") || "").startsWith("text/event-stream") && compression.filter(req, res),
  })
);
const blockedOrigins = new Set();
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser clients (no Origin header) and configured frontends
      if (!origin || env.FRONTEND_ORIGINS.includes(origin.toLowerCase())) return cb(null, true);
      // Logged once per origin: shows exactly what to add to FRONTEND_ORIGINS
      if (!blockedOrigins.has(origin)) {
        blockedOrigins.add(origin);
        console.warn(`[cors] blocked origin ${origin} (not in FRONTEND_ORIGINS)`);
      }
      cb(null, false);
    },
    // Let the browser read ETags and data versions (kept until a pushed bump moves them), and
    // cache preflights for 2h (Chrome's maximum) so authenticated GETs rarely need an OPTIONS call
    exposedHeaders: ["ETag", "X-Cache-Versions", "X-Data-Versions"],
    maxAge: 7200,
  })
);
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
});
app.use(["/api/auth/login", "/api/auth/register", "/api/auth/admin/login", "/api/auth/admin/set-role"], authLimiter);

// Auth routes (public)
app.use("/api/auth", authRoute);

// Booking routes
app.use("/api/bookingData", bookingRoute);

// Payments / games / admin
app.use("/api/games", gameRoute);
app.use("/api/payments", paymentRoute);
app.use("/api/admin", adminRoute);
app.use("/api/events", eventsRoute);

// Includes cache counters (hits, misses, Redis fallbacks...) for monitoring; no user data
app.get("/api/health", (req, res) => res.json({ ok: true, cache: cacheStats() }));

app.use("/api", (req, res) => res.status(404).json({ message: "Not found", code: "NOT_FOUND" }));
app.use(errorHandler);

module.exports = app;
