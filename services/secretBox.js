const crypto = require("crypto");
const env = require("../config/env.js");
const { HttpError } = require("../utils/httpError.js");

// AES-256-GCM encryption for secrets that must be shown again later (game backend passwords).
// The key comes from CREDENTIALS_KEY (any long random string; it is hashed to 32 bytes). Outside
// production a development key is derived from JWT_SECRET so local setups work without extra config.
// Changing CREDENTIALS_KEY makes every stored password unreadable.

const ALGO = "aes-256-gcm";

const keyOf = () => {
  const raw = env.CREDENTIALS_KEY || (env.isProd ? null : `dev-credentials:${env.JWT_SECRET}`);
  if (!raw) throw new HttpError(503, "Credential storage is not configured (set CREDENTIALS_KEY)", "CREDENTIALS_DISABLED");
  return crypto.createHash("sha256").update(String(raw)).digest();
};

/** plaintext -> { iv, tag, data } (base64 strings) */
const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyOf(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
};

/** { iv, tag, data } -> plaintext; throws if the key changed or the data was tampered with */
const decrypt = (box) => {
  try {
    const decipher = crypto.createDecipheriv(ALGO, keyOf(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, "Stored password can't be decrypted (was CREDENTIALS_KEY changed?)", "DECRYPT_FAILED");
  }
};

module.exports = { encrypt, decrypt };
