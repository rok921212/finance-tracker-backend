require("dotenv").config({ quiet: true });

// Anything not explicitly development/test is treated as production (Render does not set NODE_ENV)
const isProd = !["development", "test"].includes(process.env.NODE_ENV);
const isTest = process.env.NODE_ENV === "test";

const env = {
  isProd,
  isTest,
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI,
  JWT_SECRET: process.env.JWT_SECRET || (isProd ? undefined : "dev-only-jwt-secret"),
  REGISTER_CODE: process.env.REGISTER_CODE,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "dj181g1it",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  FRONTEND_ORIGINS: (process.env.FRONTEND_ORIGINS || (isProd ? "" : "http://localhost:3001,http://localhost:3000"))
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  // Optional cache backends (see services/cache.js); falls back to in-memory
  REDIS_URL: process.env.REDIS_URL,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
};

// Fail fast in production rather than silently running with insecure defaults
if (isProd) {
  const required = ["MONGO_URI", "JWT_SECRET", "REGISTER_CODE", "FRONTEND_ORIGINS", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const missing = required.filter((k) => !env[k] || env[k].length === 0);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

module.exports = env;
