"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Pool } = require("pg");
const { WebSocketServer, WebSocket } = require("ws");
const { hashPassword, hashSessionToken, validateCredentials, verifyPassword } = require("./auth.cjs");

const ROOT = path.resolve(__dirname, "../frontend");
const MAX_BODY_BYTES = 128 * 1024;
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const CHAT_RATE_WINDOW_MS = 60 * 1000;
const CHAT_RATE_MAX_MESSAGES = 30;
const SESSION_DAYS = 30;
const SESSION_COOKIE = "astro_session";
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const DUMMY_PASSWORD_HASH = "scrypt$2$" + "0".repeat(32) + "$" + "0".repeat(128);
const GOOGLE_STATE_COOKIE = "astro_google_state";
const GOOGLE_STATE_TTL_SECONDS = 600;
const EMAIL_VERIFICATION_TTL_HOURS = 1;
let googleKeysCache = null;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function validateEnquiry(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "The enquiry must be a JSON object.";
  }
  if (body.enquiryType !== "consultation" && body.enquiryType !== "contact") {
    return "Choose a valid enquiry type.";
  }
  if (body.privacyConsent !== true) {
    return "Privacy consent is required.";
  }
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) {
    return "Enter a name of 1 to 100 characters.";
  }
  if (typeof body.mobile !== "string" || !/^\+?[0-9]{7,15}$/.test(body.mobile.trim().replace(/[\s()-]/g, ""))) {
    return "Enter a valid mobile number.";
  }
  if (body.preferredLanguage !== "Hindi" && body.preferredLanguage !== "English") {
    return "Choose Hindi or English.";
  }
  if (body.message !== undefined && body.message !== null
      && (typeof body.message !== "string" || body.message.length > 1000)) {
    return "The message must be 1000 characters or fewer.";
  }
  if (body.enquiryType === "contact") {
    return typeof body.message === "string" && body.message.trim()
      ? null
      : "A contact message is required.";
  }
  if (!["Kundli Analysis", "Vedic Astrology Consultation", "Spiritual Guidance", "Vastu Consultation"].includes(body.consultationType)) {
    return "Choose a valid consultation type.";
  }
  if (typeof body.preferredDate !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(body.preferredDate)
      || Number.isNaN(Date.parse(body.preferredDate))
      || new Date(body.preferredDate).toISOString().slice(0, 10) !== body.preferredDate) {
    return "Enter a valid preferred date.";
  }
  if (typeof body.preferredTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.preferredTime)) {
    return "Enter a valid preferred time.";
  }
  return null;
}

function validatePoojaEnquiry(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "The pooja request must be a JSON object.";
  if (body.privacyConsent !== true) return "Privacy consent is required.";
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return "Enter a name of 1 to 100 characters.";
  if (typeof body.mobile !== "string" || !/^\+?[0-9]{7,15}$/.test(body.mobile.trim().replace(/[\s()-]/g, ""))) return "Enter a valid mobile number.";
  if (typeof body.address !== "string" || !body.address.trim() || body.address.trim().length > 500) return "Enter an address of 1 to 500 characters.";
  if (body.preferredLanguage !== "Hindi" && body.preferredLanguage !== "English") return "Choose Hindi or English.";
  if (!["वास्तु पूजा", "कालसर्प पूजा", "महामृत्युंजय जप अनुष्ठान", "ग्रह शांति", "ग्रह दोष निवारण", "पितृदोष निवारण"].includes(body.poojaType)) return "Choose a valid pooja.";
  if (body.mode !== "Online" && body.mode !== "Offline") return "Choose online or offline pooja.";
  if (typeof body.preferredDate !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(body.preferredDate)
      || Number.isNaN(Date.parse(body.preferredDate))
      || new Date(body.preferredDate).toISOString().slice(0, 10) !== body.preferredDate) return "Enter a valid preferred date.";
  if (typeof body.preferredTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.preferredTime)) return "Enter a valid preferred time.";
  return null;
}

function validateArticle(body) {
  const fields = ["slug", "title_en", "title_hi", "excerpt_en", "excerpt_hi", "content_en", "content_hi"];
  if (!body || typeof body !== "object" || Array.isArray(body)
      || fields.some((field) => typeof body[field] !== "string" || !body[field].trim())) {
    return "Complete all article fields in both languages.";
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug) || body.slug.length > 100) {
    return "Use a URL-friendly article slug with lowercase letters, numbers and hyphens.";
  }
  if (body.title_en.length > 180 || body.title_hi.length > 180
      || body.excerpt_en.length > 500 || body.excerpt_hi.length > 500
      || body.content_en.length > 50000 || body.content_hi.length > 50000) {
    return "Article titles, excerpts or content exceed the allowed length.";
  }
  if (typeof body.published !== "boolean") {
    return "Choose whether this article should be published.";
  }
  return null;
}

function cookieValue(request, name) {
  const cookieHeader = request.headers.cookie || "";
  const pair = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return pair ? pair.slice(name.length + 1) : "";
}

function appendCookie(response, value) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), value] : value);
}

function secureCookieSuffix() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ? "; Secure" : "";
}

function setSessionCookie(response, token) {
  const secure = secureCookieSuffix();
  appendCookie(response, SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age="
    + (SESSION_DAYS * 24 * 60 * 60) + secure);
}

function clearSessionCookie(response) {
  const secure = secureCookieSuffix();
  appendCookie(response, SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure);
}

function setGoogleStateCookie(response, state) {
  const secure = secureCookieSuffix();
  appendCookie(response, GOOGLE_STATE_COOKIE + "=" + state + "; Path=/; HttpOnly; SameSite=Lax; Max-Age="
    + GOOGLE_STATE_TTL_SECONDS + secure);
}

function clearGoogleStateCookie(response) {
  const secure = secureCookieSuffix();
  appendCookie(response, GOOGLE_STATE_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure);
}

async function currentUser(request, pool) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.created_at
     FROM public.login_sessions s
     JOIN public.astro_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
       AND u.role = 'customer' AND u.email_verified_at IS NOT NULL`,
    [hashSessionToken(token)]
  );
  return result.rows[0] || null;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function rateLimited(pool, request, endpoint, response) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const ip = (typeof forwardedFor === "string" ? forwardedFor.split(",").map((part) => part.trim()).filter(Boolean).at(-1) : "")
    || request.socket.remoteAddress || "unknown";
  const bucketKey = crypto.createHash("sha256").update(endpoint + ":" + ip).digest("hex");
  const result = await pool.query(
    `INSERT INTO public.auth_rate_limits (bucket_key, window_started_at, attempts)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       attempts = CASE
         WHEN auth_rate_limits.window_started_at + ($2::double precision * INTERVAL '1 millisecond') <= NOW() THEN 1
         ELSE auth_rate_limits.attempts + 1
       END,
       window_started_at = CASE
         WHEN auth_rate_limits.window_started_at + ($2::double precision * INTERVAL '1 millisecond') <= NOW() THEN NOW()
         ELSE auth_rate_limits.window_started_at
       END
     RETURNING attempts, window_started_at`,
    [bucketKey, RATE_WINDOW_MS]
  );
  const row = result.rows[0];
  if (!row || row.attempts <= RATE_MAX_ATTEMPTS) return false;
  const retrySeconds = Math.max(1, Math.ceil((new Date(row.window_started_at).getTime() + RATE_WINDOW_MS - Date.now()) / 1000));
  response.setHeader("Retry-After", String(retrySeconds));
  sendJson(response, 429, { error: "Too many attempts. Please wait before trying again." });
  return true;
}

function articleValues(body) {
  return [
    body.slug.trim(),
    body.title_en.trim(),
    body.title_hi.trim(),
    body.excerpt_en.trim(),
    body.excerpt_hi.trim(),
    body.content_en.trim(),
    body.content_hi.trim(),
    body.published
  ];
}

async function createLoginSession(client, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  await client.query(
    "INSERT INTO public.login_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))",
    [tokenHash, userId, SESSION_DAYS]
  );
  return token;
}

function appOrigin(request) {
  if (process.env.PUBLIC_SITE_URL) {
    const configured = new URL(process.env.PUBLIC_SITE_URL);
    if (process.env.NODE_ENV === "production" && configured.protocol !== "https:") {
      throw new Error("PUBLIC_SITE_URL must use HTTPS in production.");
    }
    return configured.origin;
  }
  if (process.env.NODE_ENV === "production") throw new Error("PUBLIC_SITE_URL is required in production.");
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  if (!host || /[\s/\\@]/.test(host)) throw new Error("Could not determine the website origin.");
  const protocol = request.headers["x-forwarded-proto"] || (request.socket.encrypted ? "https" : "http");
  return new URL(protocol + "://" + host).origin;
}

function googleConfig(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google sign-in is not configured yet.");
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
    ? new URL(process.env.GOOGLE_REDIRECT_URI).href
    : new URL("/api/google/callback", appOrigin(request)).href;
  const redirect = new URL(redirectUri);
  if (process.env.NODE_ENV === "production" && redirect.protocol !== "https:") {
    throw new Error("Google redirect URI must use HTTPS in production.");
  }
  return { clientId, clientSecret, redirectUri };
}

function redirectTo(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function safeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function beginGoogleSignIn(request, response, pool) {
  let config;
  try {
    config = googleConfig(request);
  } catch {
    try {
      redirectTo(response, new URL("/login.html?auth=google_unconfigured", appOrigin(request)).href);
    } catch {
      sendJson(response, 503, { error: "Google sign-in is not configured yet." });
    }
    return;
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await pool.query(
    `INSERT INTO public.google_oauth_states (state_hash, nonce, code_verifier, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [hashSessionToken(state), nonce, verifier]
  );
  setGoogleStateCookie(response, state);
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  }).toString();
  redirectTo(response, authorization.href);
}

async function googleSigningKeys(forceRefresh = false) {
  if (!forceRefresh && googleKeysCache && googleKeysCache.expiresAt > Date.now()) return googleKeysCache.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Could not verify Google sign-in.");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("Google returned invalid signing keys.");
  const cacheHeader = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheHeader.match(/max-age=(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? Math.min(Number(maxAgeMatch[1]), 3600) : 300;
  googleKeysCache = { keys: body.keys, expiresAt: Date.now() + maxAgeSeconds * 1000 };
  return body.keys;
}

async function verifyGoogleIdToken(idToken, expectedNonce, clientId) {
  if (typeof idToken !== "string" || idToken.length > 20000) throw new Error("Google sign-in could not be verified.");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Google sign-in could not be verified.");
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Google sign-in could not be verified.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Google sign-in could not be verified.");
  let keys = await googleSigningKeys();
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    keys = await googleSigningKeys(true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  }
  if (!jwk) throw new Error("Google sign-in could not be verified.");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signature = Buffer.from(parts[2], "base64url");
  const signatureValid = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, signature);
  const now = Math.floor(Date.now() / 1000);
  const audienceValid = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  const authorizedPartyValid = !Array.isArray(claims.aud) || claims.aud.length <= 1 || claims.azp === clientId;
  const issuerValid = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!signatureValid || !issuerValid || !audienceValid || !authorizedPartyValid
      || !Number.isFinite(claims.exp) || claims.exp <= now
      || !Number.isFinite(claims.iat) || claims.iat > now + 60
      || !safeEqualText(claims.nonce, expectedNonce)
      || (claims.email_verified !== true && claims.email_verified !== "true")
      || typeof claims.sub !== "string" || !claims.sub
      || typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    throw new Error("Google sign-in could not be verified.");
  }
  return claims;
}

async function finishGoogleSignIn(request, response, requestUrl, pool) {
  const origin = appOrigin(request);
  const loginUrl = new URL("/login.html?auth=google_failed", origin).href;
  const state = requestUrl.searchParams.get("state") || "";
  const cookieState = cookieValue(request, GOOGLE_STATE_COOKIE);
  if (!safeEqualText(state, cookieState) || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    clearGoogleStateCookie(response);
    redirectTo(response, loginUrl);
    return;
  }
  const stored = await pool.query(
    `DELETE FROM public.google_oauth_states
     WHERE state_hash = $1 AND expires_at > NOW()
     RETURNING nonce, code_verifier`,
    [hashSessionToken(state)]
  );
  clearGoogleStateCookie(response);
  const pending = stored.rows[0];
  const code = requestUrl.searchParams.get("code");
  if (!pending || !code || requestUrl.searchParams.has("error")) {
    redirectTo(response, new URL("/login.html?auth=google_failed", origin).href);
    return;
  }
  try {
    const config = googleConfig(request);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: pending.code_verifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!tokenResponse.ok) throw new Error("Google token exchange failed.");
    const tokenBody = await tokenResponse.json();
    const claims = await verifyGoogleIdToken(tokenBody.id_token, pending.nonce, config.clientId);
    const userToken = await findOrCreateGoogleUser(pool, claims);
    setSessionCookie(response, userToken);
    redirectTo(response, new URL("/dashboard.html", origin).href);
  } catch (error) {
    console.error("Google sign-in failed:", error.message);
    redirectTo(response, loginUrl);
  }
}

async function findOrCreateGoogleUser(pool, claims) {
  const email = claims.email.trim().toLowerCase();
  const fallbackName = typeof claims.name === "string" ? claims.name.trim().split(/\s+/) : [];
  const firstName = String(claims.given_name || fallbackName[0] || email.split("@")[0]).trim().slice(0, 80);
  const lastName = String(claims.family_name || fallbackName.slice(1).join(" ") || "").trim().slice(0, 80);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [claims.sub]);
    let result = await client.query(
      "SELECT id, role, google_sub, email_verified_at FROM public.astro_users WHERE google_sub = $1 FOR UPDATE",
      [claims.sub]
    );
    let user = result.rows[0];
    if (!user) {
      result = await client.query(
        "SELECT id, role, google_sub, email_verified_at FROM public.astro_users WHERE lower(email) = $1 FOR UPDATE",
        [email]
      );
      user = result.rows[0];
    }
    if (user) {
      if (user.role !== "customer" || (user.google_sub && user.google_sub !== claims.sub)) {
        throw new Error("This account cannot be signed in with that Google account.");
      }
      if (!user.email_verified_at) {
        await client.query("DELETE FROM public.login_sessions WHERE user_id = $1", [user.id]);
      }
      await client.query(
        `UPDATE public.astro_users
         SET google_sub = $1, email_verified_at = COALESCE(email_verified_at, NOW()),
             password_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END,
             first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3)
         WHERE id = $4`,
        [claims.sub, firstName, lastName, user.id]
      );
    } else {
      result = await client.query(
        `INSERT INTO public.astro_users
           (first_name, last_name, email, password_hash, google_sub, email_verified_at, role)
         VALUES ($1, $2, $3, NULL, $4, NOW(), 'customer')
         RETURNING id`,
        [firstName, lastName, email, claims.sub]
      );
      user = result.rows[0];
    }
    const token = await createLoginSession(client, user.id);
    await client.query("COMMIT");
    return token;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function sendVerificationEmail(request, pool, user) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("Email verification is not configured yet.");
  const origin = appOrigin(request);
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  await pool.query("DELETE FROM public.email_verification_tokens WHERE user_id = $1", [user.id]);
  await pool.query(
    `INSERT INTO public.email_verification_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 hour'))`,
    [tokenHash, user.id, EMAIL_VERIFICATION_TTL_HOURS]
  );
  const verificationUrl = new URL("/api/verify-email", origin);
  verificationUrl.searchParams.set("token", token);
  const emailResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [user.email],
      subject: "Verify your Astro Alok Tripathi account",
      text: "Verify your email address within one hour: " + verificationUrl.href,
      html: '<p>Use this link to verify your email address. It expires in one hour.</p><p><a href="'
        + verificationUrl.href + '">Verify my email</a></p><p>If you did not create this account, you can ignore this message.</p>'
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!emailResponse.ok) {
    await pool.query("DELETE FROM public.email_verification_tokens WHERE token_hash = $1", [tokenHash]);
    throw new Error("Could not send the account verification email.");
  }
}

async function finishEmailVerification(request, response, requestUrl, pool) {
  const token = requestUrl.searchParams.get("token") || "";
  const origin = appOrigin(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    redirectTo(response, new URL("/login.html?verification=invalid", origin).href);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `DELETE FROM public.email_verification_tokens
       WHERE token_hash = $1 AND expires_at > NOW()
       RETURNING user_id`,
      [hashSessionToken(token)]
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      redirectTo(response, new URL("/login.html?verification=invalid", origin).href);
      return;
    }
    const updated = await client.query(
      `UPDATE public.astro_users SET email_verified_at = COALESCE(email_verified_at, NOW())
       WHERE id = $1 AND role = 'customer' RETURNING id`,
      [result.rows[0].user_id]
    );
    if (!updated.rows[0]) throw new Error("The account could not be verified.");
    await client.query("DELETE FROM public.login_sessions WHERE user_id = $1", [updated.rows[0].id]);
    const sessionToken = await createLoginSession(client, updated.rows[0].id);
    await client.query("COMMIT");
    setSessionCookie(response, sessionToken);
    redirectTo(response, new URL("/dashboard.html", origin).href);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireCustomerConversation(pool, customerId) {
  if (!/^\d+$/.test(String(customerId || ""))) return false;
  const result = await pool.query(
    `SELECT u.id
     FROM public.astro_users u
     JOIN public.astro_chat_consents c ON c.customer_id = u.id
     WHERE u.id = $1 AND u.role = 'customer'`,
    [customerId]
  );
  return result.rowCount > 0;
}

async function handleApi(request, response, requestUrl, pool, chatConnections) {
  const pathname = requestUrl.pathname;
  const method = request.method;
  if (pathname === "/api/google/start" && method === "GET") {
    if (await rateLimited(pool, request, pathname, response)) return;
    await beginGoogleSignIn(request, response, pool);
    return;
  }
  if (pathname === "/api/google/callback" && method === "GET") {
    response.setHeader("Referrer-Policy", "no-referrer");
    await finishGoogleSignIn(request, response, requestUrl, pool);
    return;
  }
  if (pathname === "/api/verify-email" && method === "GET") {
    response.setHeader("Referrer-Policy", "no-referrer");
    await finishEmailVerification(request, response, requestUrl, pool);
    return;
  }
  if (method === "POST" && !sameOrigin(request)) {
    sendJson(response, 403, { error: "This request must come from the website." });
    return;
  }
  if (method === "POST" && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "Content-Type must be application/json." });
    return;
  }
  if (pathname === "/api/me" && method === "GET") {
    const user = await currentUser(request, pool);
    if (user) {
      const token = cookieValue(request, SESSION_COOKIE);
      await pool.query(
        "UPDATE public.login_sessions SET expires_at = NOW() + ($2::int * INTERVAL '1 day') WHERE token_hash = $1",
        [hashSessionToken(token), SESSION_DAYS]
      );
      setSessionCookie(response, token);
    }
    sendJson(response, 200, { user: user ? { id: String(user.id), firstName: user.first_name, lastName: user.last_name, email: user.email, role: user.role, createdAt: user.created_at } : null });
    return;
  }
  if ((pathname === "/api/signup" || pathname === "/api/login") && method === "POST") {
    if (await rateLimited(pool, request, pathname, response)) return;
    const body = await readJson(request);
    const validationError = validateCredentials(body, { requireName: pathname === "/api/signup" });
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }
    if (pathname === "/api/signup" && body.privacyConsent !== true) {
      sendJson(response, 400, { error: "Please accept the Privacy Policy to create an account." });
      return;
    }
    const email = body.email.trim().toLowerCase();
    if (pathname === "/api/signup") {
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
        sendJson(response, 503, { error: "Email verification is not configured yet." });
        return;
      }
      const passwordHash = await hashPassword(body.password);
      let user;
      try {
        const inserted = await pool.query(
          `INSERT INTO public.astro_users
             (first_name, last_name, email, password_hash, role)
           VALUES ($1, $2, $3, $4, 'customer')
           RETURNING id, email`,
          [body.firstName.trim(), body.lastName.trim(), email, passwordHash]
        );
        user = inserted.rows[0];
      } catch (error) {
        if (error.code !== "23505") throw error;
        const existing = await pool.query(
          `SELECT id, email, password_hash, email_verified_at
           FROM public.astro_users WHERE lower(email) = $1`,
          [email]
        );
        if (existing.rows[0] && !existing.rows[0].email_verified_at && existing.rows[0].password_hash
            && await verifyPassword(body.password, existing.rows[0].password_hash)) {
          user = existing.rows[0];
        }
      }
      if (user) await sendVerificationEmail(request, pool, user);
      sendJson(response, 202, { ok: true });
      return;
    }
    const result = await pool.query(
      `SELECT id, email, role, password_hash, email_verified_at
       FROM public.astro_users WHERE email = $1 AND role = 'customer'`,
      [email]
    );
    const user = result.rows[0];
    const valid = await verifyPassword(body.password, user && user.password_hash || DUMMY_PASSWORD_HASH);
    if (!valid) {
      sendJson(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    if (!user.email_verified_at) {
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
        sendJson(response, 503, { error: "Email verification is not configured yet." });
        return;
      }
      if (user.password_hash) await sendVerificationEmail(request, pool, user);
      sendJson(response, 403, { error: "Verify your email address before signing in. Check your inbox for a verification link." });
      return;
    }
    const client = await pool.connect();
    try {
      if (user.password_hash.startsWith("scrypt$")) {
        const parts = user.password_hash.split("$");
        if (parts.length === 3) {
          await client.query("UPDATE public.astro_users SET password_hash = $1 WHERE id = $2", [await hashPassword(body.password), user.id]);
        }
      }
      const token = await createLoginSession(client, user.id);
      setSessionCookie(response, token);
      sendJson(response, 200, { user: { id: String(user.id), email: user.email, role: user.role } });
    } finally {
      client.release();
    }
    return;
  }
  if (pathname === "/api/password" && method === "POST") {
    if (await rateLimited(pool, request, pathname, response)) return;
    const user = await currentUser(request, pool);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to change your password." });
      return;
    }
    const body = await readJson(request);
    const validationError = validateCredentials({ email: user.email, password: body && body.newPassword });
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }
    if (!body || typeof body.confirmPassword !== "string") {
      sendJson(response, 400, { error: "Confirm your new password." });
      return;
    }
    if (body.newPassword !== body.confirmPassword) {
      sendJson(response, 400, { error: "New passwords do not match." });
      return;
    }
    const account = await pool.query(
      "SELECT password_hash FROM public.astro_users WHERE id = $1 AND role = 'customer'",
      [user.id]
    );
    if (!account.rows[0]) {
      sendJson(response, 401, { error: "Your account could not be verified." });
      return;
    }
    if (account.rows[0].password_hash) {
      const matches = typeof body.currentPassword === "string"
        && await verifyPassword(body.currentPassword, account.rows[0].password_hash);
      if (!matches) {
        sendJson(response, 401, { error: "Current password is incorrect." });
        return;
      }
    } else {
      const token = cookieValue(request, SESSION_COOKIE);
      const recentAuth = await pool.query(
        `SELECT 1 FROM public.login_sessions
         WHERE token_hash = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
        [hashSessionToken(token)]
      );
      if (recentAuth.rowCount === 0) {
        sendJson(response, 401, { error: "Sign in with Google again before setting a password." });
        return;
      }
    }
    const passwordHash = await hashPassword(body.newPassword);
    const token = cookieValue(request, SESSION_COOKIE);
    const tokenHash = hashSessionToken(token);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE public.astro_users SET password_hash = $1 WHERE id = $2", [passwordHash, user.id]);
      await client.query("DELETE FROM public.login_sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, tokenHash]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === "/api/logout" && method === "POST") {
    const token = cookieValue(request, SESSION_COOKIE);
    if (/^[a-f0-9]{64}$/.test(token)) {
      const user = await currentUser(request, pool);
      await pool.query("DELETE FROM public.login_sessions WHERE token_hash = $1", [hashSessionToken(token)]);
      if (user) {
        chatConnections.forEach((connection) => {
          if (String(connection.user.id) === String(user.id)) connection.socket.close(1008, "Signed out");
        });
      }
    }
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === "/api/pooja-enquiries" && method === "POST") {
    if (await rateLimited(pool, request, pathname, response)) return;
    const body = await readJson(request);
    const validationError = validatePoojaEnquiry(body);
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }
    await pool.query(
      `INSERT INTO public.pooja_enquiries
        (name, mobile, address, pooja_type, mode, preferred_language, preferred_date, preferred_time, privacy_consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
      [body.name.trim(), body.mobile.trim(), body.address.trim(), body.poojaType, body.mode, body.preferredLanguage, body.preferredDate, body.preferredTime]
    );
    sendJson(response, 201, { ok: true });
    return;
  }
  if (pathname === "/api/enquiries" && method === "POST") {
    const body = await readJson(request);
    const validationError = validateEnquiry(body);
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }
    const user = await currentUser(request, pool);
    await pool.query(
      `INSERT INTO public.consultation_enquiries
        (enquiry_type, user_id, name, mobile, preferred_language, consultation_type,
         preferred_date, preferred_time, message, privacy_consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        body.enquiryType,
        user ? user.id : null,
        body.name.trim(),
        body.mobile.trim(),
        body.preferredLanguage,
        body.enquiryType === "consultation" ? body.consultationType : null,
        body.enquiryType === "consultation" ? body.preferredDate : null,
        body.enquiryType === "consultation" ? body.preferredTime : null,
        body.message ? body.message.trim() : null,
        true
      ]
    );
    sendJson(response, 201, { ok: true });
    return;
  }
  if (pathname === "/api/enquiries" && method === "GET") {
    const user = await currentUser(request, pool);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to view your enquiries." });
      return;
    }
    const result = user.role === "admin"
      ? await pool.query(
        `SELECT e.id, e.enquiry_type, e.name, e.mobile, e.preferred_language,
                e.consultation_type, e.preferred_date, e.preferred_time, e.message,
                e.created_at, u.email
         FROM public.consultation_enquiries e
         LEFT JOIN public.astro_users u ON u.id = e.user_id
         ORDER BY e.created_at DESC LIMIT 500`
      )
      : await pool.query(
        `SELECT id, enquiry_type, name, mobile, preferred_language,
                consultation_type, preferred_date, preferred_time, message, created_at
         FROM public.consultation_enquiries
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [user.id]
      );
    sendJson(response, 200, { enquiries: result.rows });
    return;
  }
  if (pathname.startsWith("/api/chat/")) {
    const user = await currentUser(request, pool);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to use private chat." });
      return;
    }
    if (pathname === "/api/chat/consent" && method === "GET") {
      if (user.role === "admin") {
        sendJson(response, 200, { accepted: true });
        return;
      }
      const result = await pool.query(
        "SELECT 1 FROM public.astro_chat_consents WHERE customer_id = $1",
        [user.id]
      );
      sendJson(response, 200, { accepted: result.rowCount > 0 });
      return;
    }
    if (pathname === "/api/chat/consent" && method === "POST") {
      if (user.role !== "customer") {
        sendJson(response, 403, { error: "Only customer accounts can start a private chat." });
        return;
      }
      const body = await readJson(request);
      if (!body || body.consent !== true) {
        sendJson(response, 400, { error: "Chat privacy consent is required." });
        return;
      }
      await pool.query(
        "INSERT INTO public.astro_chat_consents (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING",
        [user.id]
      );
      sendJson(response, 200, { accepted: true });
      return;
    }
    if (pathname === "/api/chat/conversations" && method === "GET") {
      if (user.role !== "admin") {
        sendJson(response, 403, { error: "Only the astrologer can view the conversation list." });
        return;
      }
      const result = await pool.query(
        `SELECT DISTINCT ON (m.customer_id)
           m.customer_id::text AS customer_id, u.email, m.message, m.created_at
         FROM public.astro_chat_messages m
         JOIN public.astro_users u ON u.id = m.customer_id
         ORDER BY m.customer_id, m.id DESC`
      );
      sendJson(response, 200, { conversations: result.rows });
      return;
    }
    if (pathname === "/api/chat/messages" && method === "GET") {
      const requestedCustomerId = requestUrl.searchParams.get("customerId");
      const customerId = user.role === "admin" ? requestedCustomerId : String(user.id);
      if (user.role === "admin" && !(await requireCustomerConversation(pool, customerId))) {
        sendJson(response, 404, { error: "Chat conversation not found." });
        return;
      }
      if (user.role === "customer") {
        const consent = await pool.query(
          "SELECT 1 FROM public.astro_chat_consents WHERE customer_id = $1",
          [user.id]
        );
        if (consent.rowCount === 0) {
          sendJson(response, 403, { error: "Accept the chat privacy notice before using chat." });
          return;
        }
      }
      const result = await pool.query(
        `SELECT id::text AS id, customer_id::text AS customer_id,
                sender_id::text AS sender_id, message, created_at
         FROM (
           SELECT id, customer_id, sender_id, message, created_at
           FROM public.astro_chat_messages
           WHERE customer_id = $1
           ORDER BY id DESC
           LIMIT 100
         ) recent_messages
         ORDER BY id ASC`,
        [customerId]
      );
      sendJson(response, 200, { messages: result.rows });
      return;
    }
    sendJson(response, 404, { error: "Chat resource not found." });
    return;
  }
  if (pathname === "/api/feedback" && method === "GET") {
    const result = await pool.query(
      `SELECT id::text AS id, rating, message, created_at
       FROM public.astro_customer_feedback
       WHERE is_public = TRUE
       ORDER BY created_at DESC
       LIMIT 100`
    );
    sendJson(response, 200, { feedback: result.rows });
    return;
  }
  if (pathname === "/api/feedback/mine") {
    const user = await currentUser(request, pool);
    if (!user || user.role !== "customer") {
      sendJson(response, 401, { error: "Sign in with a customer account to manage feedback." });
      return;
    }
    if (method === "GET") {
      const result = await pool.query(
        `SELECT rating, message, public_consent
         FROM public.astro_customer_feedback
         WHERE customer_id = $1`,
        [user.id]
      );
      sendJson(response, 200, { feedback: result.rows[0] || null });
      return;
    }
    if (method === "POST") {
      const body = await readJson(request);
      const message = typeof body?.message === "string" ? body.message.trim() : "";
      if (!Number.isInteger(body?.rating) || body.rating < 1 || body.rating > 5
          || message.length < 10 || message.length > MAX_CHAT_MESSAGE_LENGTH
          || body.publicConsent !== true) {
        sendJson(response, 400, { error: "Choose a 1–5 star rating, write at least 10 characters, and agree to public display." });
        return;
      }
      const result = await pool.query(
        `INSERT INTO public.astro_customer_feedback
           (customer_id, rating, message, public_consent, is_public)
         VALUES ($1, $2, $3, TRUE, TRUE)
         ON CONFLICT (customer_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           message = EXCLUDED.message,
           public_consent = TRUE,
           is_public = TRUE,
           updated_at = NOW()
         RETURNING rating, message, public_consent`,
        [user.id, body.rating, message]
      );
      sendJson(response, 200, { feedback: result.rows[0] });
      return;
    }
    sendJson(response, 405, { error: "Use GET or POST for your feedback." });
    return;
  }
  if (pathname === "/api/articles" && method === "GET") {
    const result = await pool.query(
      `SELECT id, slug, title_en, title_hi, excerpt_en, excerpt_hi, content_en, content_hi, created_at
       FROM public.site_articles WHERE published = TRUE ORDER BY created_at DESC`
    );
    sendJson(response, 200, { articles: result.rows });
    return;
  }
  if (pathname.startsWith("/api/admin/")) {
    const user = await currentUser(request, pool);
    if (!user || user.role !== "admin") {
      sendJson(response, 403, { error: "This account does not have access to this resource." });
      return;
    }
    if (pathname === "/api/admin/articles" && method === "GET") {
      const result = await pool.query(
        `SELECT id, slug, title_en, title_hi, excerpt_en, excerpt_hi,
                content_en, content_hi, published, created_at, updated_at
         FROM public.site_articles ORDER BY updated_at DESC`
      );
      sendJson(response, 200, { articles: result.rows });
      return;
    }
    if (pathname === "/api/admin/feedback" && method === "GET") {
      const result = await pool.query(
        `SELECT f.id::text AS id, u.email, f.rating, f.message,
                f.is_public, f.created_at
         FROM public.astro_customer_feedback f
         JOIN public.astro_users u ON u.id = f.customer_id
         ORDER BY f.created_at DESC
         LIMIT 500`
      );
      sendJson(response, 200, { feedback: result.rows });
      return;
    }
    const feedbackMatch = pathname.match(/^\/api\/admin\/feedback\/(\d+)$/);
    if (feedbackMatch && method === "DELETE") {
      const result = await pool.query(
        "DELETE FROM public.astro_customer_feedback WHERE id = $1 RETURNING id",
        [feedbackMatch[1]]
      );
      if (result.rowCount === 0) {
        sendJson(response, 404, { error: "Feedback not found." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    const articleMatch = pathname.match(/^\/api\/admin\/articles\/(\d+)$/);
    if (pathname === "/api/admin/articles" && method === "POST") {
      const body = await readJson(request);
      const validationError = validateArticle(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      const result = await pool.query(
        `INSERT INTO public.site_articles
          (slug, title_en, title_hi, excerpt_en, excerpt_hi, content_en, content_hi, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        articleValues(body)
      );
      sendJson(response, 201, { id: result.rows[0].id });
      return;
    }
    if (articleMatch && method === "PUT") {
      const body = await readJson(request);
      const validationError = validateArticle(body);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      const result = await pool.query(
        `UPDATE public.site_articles SET
           slug = $1, title_en = $2, title_hi = $3, excerpt_en = $4, excerpt_hi = $5,
           content_en = $6, content_hi = $7, published = $8, updated_at = NOW()
         WHERE id = $9 RETURNING id`,
        articleValues(body).concat(articleMatch[1])
      );
      if (result.rowCount === 0) {
        sendJson(response, 404, { error: "Article not found." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (articleMatch && method === "DELETE") {
      const result = await pool.query("DELETE FROM public.site_articles WHERE id = $1 RETURNING id", [articleMatch[1]]);
      if (result.rowCount === 0) {
        sendJson(response, 404, { error: "Article not found." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Admin resource not found." });
    return;
  }
  sendJson(response, 404, { error: "API endpoint not found." });
}

function staticFileFor(pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules" || segment === "database")) {
    return null;
  }
  if (segments.length === 1 && !/^[a-z0-9-]+\.html$/i.test(segments[0])) return null;
  if (segments.length > 1 && segments[0] !== "assets") return null;
  const filePath = path.resolve(ROOT, "." + normalizedPath);
  if (!filePath.startsWith(ROOT + path.sep) || !MIME_TYPES[path.extname(filePath).toLowerCase()]) return null;
  return filePath;
}

function publicWhatsAppNumber() {
  const number = String(process.env.WHATSAPP_NUMBER || "918319482309").replace(/\D/g, "");
  return /^\d{7,15}$/.test(number) ? number : "918319482309";
}

function publicWhatsAppDisplayNumber() {
  const number = publicWhatsAppNumber();
  return number.startsWith("91") && number.length === 12
    ? "+91 " + number.slice(2, 7) + " " + number.slice(7)
    : "+" + number;
}

function createApplication(pool, ensureInitialized = async () => {}) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const chatConnections = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid request URL." });
      return;
    }
    try {
      await ensureInitialized();
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(request, response, requestUrl, pool, chatConnections);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid URL path.");
        return;
      }
      const filePath = staticFileFor(pathname);
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }
      let content = await fs.promises.readFile(filePath);
      if ([".html", ".js"].includes(path.extname(filePath).toLowerCase())) {
        const source = content.toString("utf8");
        content = Buffer.from(source
          .replaceAll("918319482309", publicWhatsAppNumber())
          .replaceAll("+91 83194 82309", publicWhatsAppDisplayNumber()));
      }
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()],
        "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600"
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      console.error("Website request failed:", error);
      if (error.code === "ENOENT" || error.code === "EISDIR") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }
      sendJson(response, 500, { error: "The request could not be completed." });
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (requestUrl.pathname !== "/api/ws" && requestUrl.pathname !== "/ws/chat") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!sameOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      await ensureInitialized();
      const user = await currentUser(request, pool);
      if (!user) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (user.role === "customer") {
        const consent = await pool.query(
          "SELECT 1 FROM public.astro_chat_consents WHERE customer_id = $1",
          [user.id]
        );
        if (consent.rowCount === 0) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = { socket: webSocket, user, windowAt: Date.now(), messageCount: 0 };
        chatConnections.add(connection);
        webSocket.on("close", () => chatConnections.delete(connection));
        webSocket.on("message", async (data) => {
          const now = Date.now();
          if (now - connection.windowAt >= CHAT_RATE_WINDOW_MS) {
            connection.windowAt = now;
            connection.messageCount = 0;
          }
          connection.messageCount += 1;
          if (connection.messageCount > CHAT_RATE_MAX_MESSAGES) {
            webSocket.send(JSON.stringify({ type: "error", message: "Please wait before sending more messages." }));
            webSocket.close(1008, "Rate limit exceeded");
            return;
          }
          let body;
          try {
            body = JSON.parse(data.toString());
          } catch {
            webSocket.send(JSON.stringify({ type: "error", message: "Message must be valid JSON." }));
            return;
          }
          if (!body || body.type !== "message" || typeof body.message !== "string") {
            webSocket.send(JSON.stringify({ type: "error", message: "Invalid chat message." }));
            return;
          }
          const message = body.message.trim();
          if (!message || Array.from(message).length > MAX_CHAT_MESSAGE_LENGTH) {
            webSocket.send(JSON.stringify({ type: "error", message: "Messages must be between 1 and 2000 characters." }));
            return;
          }
          let customerId = String(connection.user.id);
          if (connection.user.role === "admin") {
            customerId = String(body.customerId || "");
            try {
              if (!(await requireCustomerConversation(pool, customerId))) {
                webSocket.send(JSON.stringify({ type: "error", message: "Chat conversation not found." }));
                return;
              }
            } catch (error) {
              console.error("Could not verify the chat conversation:", error);
              webSocket.send(JSON.stringify({ type: "error", message: "The message could not be sent. Please try again." }));
              return;
            }
          }
          try {
            const result = await pool.query(
              `INSERT INTO public.astro_chat_messages (customer_id, sender_id, message)
               VALUES ($1, $2, $3)
               RETURNING id::text AS id, customer_id::text AS customer_id,
                         sender_id::text AS sender_id, message, created_at`,
              [customerId, connection.user.id, message]
            );
            const event = JSON.stringify({ type: "message", message: result.rows[0] });
            chatConnections.forEach((recipient) => {
              if (recipient.socket.readyState === WebSocket.OPEN
                  && (recipient.user.role === "admin" || String(recipient.user.id) === customerId)) {
                recipient.socket.send(event);
              }
            });
          } catch (error) {
            console.error("Could not save chat message:", error);
            webSocket.send(JSON.stringify({ type: "error", message: "The message could not be saved. Please try again." }));
          }
        });
      });
    } catch (error) {
      console.error("Could not authorize chat connection:", error);
      if (!socket.destroyed) socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("close", () => {
    chatConnections.forEach((connection) => connection.socket.terminate());
  });
  return server;
}

async function initializeDatabase(pool) {
  await pool.query("SELECT 1");
  const schema = await fs.promises.readFile(path.resolve(__dirname, "../database/schema.sql"), "utf8");
  await pool.query(schema);
  await pool.query("DELETE FROM public.login_sessions WHERE expires_at <= NOW()");
  await pool.query("DELETE FROM public.email_verification_tokens WHERE expires_at <= NOW()");
  await pool.query("DELETE FROM public.google_oauth_states WHERE expires_at <= NOW()");
  await pool.query("DELETE FROM public.auth_rate_limits WHERE window_started_at < NOW() - INTERVAL '1 day'");
}

async function start() {
  const pool = new Pool(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : undefined);
  try {
    await initializeDatabase(pool);
  } catch (error) {
    await pool.end();
    console.error("Could not connect to PostgreSQL or initialize the Astrology database:", error.message);
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await pool.end();
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const server = createApplication(pool);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Astro Alok Tripathi website and enquiry API listening on port ${port}`);
  });
  const shutdown = () => {
    server.close(() => pool.end().catch((error) => {
      console.error("Could not close the PostgreSQL connection pool:", error);
      process.exitCode = 1;
    }));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const cleanup = setInterval(() => {
    pool.query("DELETE FROM public.login_sessions WHERE expires_at <= NOW()")
      .catch((error) => console.error("Could not remove expired sessions:", error));
  }, 60 * 60 * 1000);
  cleanup.unref();
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Website server failed to start:", error);
    process.exitCode = 1;
  });
}

module.exports = { createApplication, initializeDatabase, validateArticle, validateEnquiry };
