"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const PASSWORD_BYTES_MIN = 12;
const PASSWORD_BYTES_MAX = 256;
const CURRENT_SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, CURRENT_SCRYPT_OPTIONS);
  return "scrypt$2$" + salt.toString("hex") + "$" + derivedKey.toString("hex");
}

async function verifyPassword(password, passwordHash) {
  if (typeof passwordHash !== "string") return false;
  const parts = passwordHash.split("$");
  const legacy = parts.length === 3 && parts[0] === "scrypt";
  const current = parts.length === 4 && parts[0] === "scrypt" && parts[1] === "2";
  const saltHex = legacy ? parts[1] : current ? parts[2] : "";
  const keyHex = legacy ? parts[2] : current ? parts[3] : "";
  if (!/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(keyHex)) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = legacy
    ? await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)
    : await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, CURRENT_SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(expected, actual);
}

function validateCredentials(body, options) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Enter a valid email address and password.";
  }
  const loginName = typeof body.email === "string" ? body.email.trim() : "";
  const isEmail = loginName.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginName);
  if (!isEmail) {
    return "Enter a valid email address.";
  }
  if (typeof body.password !== "string"
      || Buffer.byteLength(body.password, "utf8") < PASSWORD_BYTES_MIN
      || Buffer.byteLength(body.password, "utf8") > PASSWORD_BYTES_MAX) {
    return "Use a password that is at least 12 characters long.";
  }
  if (options && options.requireName) {
    for (const field of ["firstName", "lastName"]) {
      if (typeof body[field] !== "string" || !body[field].trim() || body[field].trim().length > 80) {
        return field === "firstName" ? "Enter your first name (up to 80 characters)." : "Enter your last name (up to 80 characters).";
      }
    }
  }
  return null;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { hashPassword, hashSessionToken, validateCredentials, verifyPassword };
