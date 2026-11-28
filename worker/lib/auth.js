/**
 * 料金がかかるAIの機能（高精度OCR・要約・翻訳・AI音声）だけを守る、かんたんなパスワード認証です。
 * 読み上げと無料OCRはブラウザの中だけで動くため、誰でも使えます。
 *
 * パスワードはサーバー側だけで確かめ、ブラウザへは書き換えられない署名付きの引換券（トークン）を
 * HttpOnly Cookie で渡すだけにします。パスワードのハッシュ（APP_PASSWORD_HASH）と署名の鍵（SESSION_SECRET）は
 * Workers Secrets に保存し、コードやフロントエンドには置きません。
 *
 * Cloudflare Access でこのアプリを守っている場合は、ACCESS_TEAM_DOMAIN と ACCESS_AUD を設定すると、
 * Access で本人確認できた人をパスワードなしで通します（Access の確認が取れないときは、これまでどおりパスワードを使います）。
 */

export const COOKIE_NAME = "yomiage_ai";
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getPasswordHash(env) {
  return String(env?.APP_PASSWORD_HASH || "").trim().toLowerCase();
}

export function isAuthConfigured(env) {
  return SHA256_HEX_PATTERN.test(getPasswordHash(env));
}

// 署名に使う鍵です。SESSION_SECRET があればそれを使い、なければパスワードのハッシュから作ります。
function getSigningKey(env) {
  const secret = String(env?.SESSION_SECRET || "").trim();
  if (secret) return secret;
  const passwordHash = getPasswordHash(env);
  return passwordHash ? `yomiage:${passwordHash}` : "";
}

async function sign(env, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSigningKey(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

// 文字列の比較にかかる時間から中身を推測されないよう、長さをそろえて比べます。
export function safeEqual(a, b) {
  const bytesA = encoder.encode(String(a));
  const bytesB = encoder.encode(String(b));
  if (bytesA.length !== bytesB.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(bytesA, bytesB);
  }
  let diff = 0;
  for (let index = 0; index < bytesA.length; index += 1) diff |= bytesA[index] ^ bytesB[index];
  return diff === 0;
}

export async function verifyPassword(env, password) {
  if (!isAuthConfigured(env) || typeof password !== "string" || !password) return false;
  const inputHash = toHex(await crypto.subtle.digest("SHA-256", encoder.encode(password)));
  return safeEqual(inputHash, getPasswordHash(env));
}

// 有効期限と、その署名だけを持つ引換券です。中身を書き換えると署名が合わなくなります。
async function createSessionToken(env, now = Date.now()) {
  const expiresAt = now + SESSION_DURATION_MS;
  return `${expiresAt}.${await sign(env, String(expiresAt))}`;
}

export async function verifySessionToken(env, token, now = Date.now()) {
  if (!isAuthConfigured(env) || typeof token !== "string") return false;
  const [expiresPart, signature] = token.split(".");
  const expiresAt = Number(expiresPart);
  if (!expiresPart || !signature || !Number.isFinite(expiresAt)) return false;
  if (now > expiresAt) return false;
  return safeEqual(signature, await sign(env, expiresPart));
}

export function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const found = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!found) return "";
  try {
    return decodeURIComponent(found.slice(name.length + 1));
  } catch {
    return "";
  }
}

// HttpOnly なので、ブラウザの JavaScript からは読み書きできません。
export async function buildSessionCookie(env) {
  const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
  return `${COOKIE_NAME}=${await createSessionToken(env)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

// ===== Cloudflare Access との連携（任意） =====

const ACCESS_CERTS_CACHE_MS = 60 * 60 * 1000;
let accessCertsCache = null;

function getAccessSettings(env) {
  const teamDomain = String(env?.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const audience = String(env?.ACCESS_AUD || "").trim();
  return teamDomain && audience ? { teamDomain, audience } : null;
}

export function isAccessConfigured(env) {
  return Boolean(getAccessSettings(env));
}

async function getAccessKeys(teamDomain, fetchImpl = fetch) {
  const now = Date.now();
  if (accessCertsCache && accessCertsCache.teamDomain === teamDomain && accessCertsCache.expiresAt > now) {
    return accessCertsCache.keys;
  }
  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Access certs responded with ${response.status}`);
  const data = await response.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  accessCertsCache = { teamDomain, keys, expiresAt: now + ACCESS_CERTS_CACHE_MS };
  return keys;
}

/**
 * Cloudflare Access が付ける本人確認の証明（Cf-Access-Jwt-Assertion）を確かめます。
 * 署名・発行元・対象アプリ（AUD）・有効期限がすべて合うときだけ true を返します。
 */
export async function verifyAccessJwt(env, request, options = {}) {
  const settings = getAccessSettings(env);
  if (!settings) return false;
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || readCookie(request, "CF_Authorization");
  if (!token) return false;

  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return false;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
    if (header.alg !== "RS256") return false;

    const keys = await getAccessKeys(settings.teamDomain, options.fetch);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(signaturePart),
      encoder.encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return false;

    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return payload.iss === `https://${settings.teamDomain}`
      && audiences.includes(settings.audience)
      && typeof payload.exp === "number" && payload.exp > nowSeconds;
  } catch (error) {
    console.warn("Cloudflare Accessの確認ができませんでした。", error?.name || error);
    return false;
  }
}

/**
 * AIの機能を使ってよいかを調べます。
 * Cloudflare Access の確認が取れればパスワードなしで通し、それ以外はパスワードの引換券を確かめます。
 */
export async function isAuthenticated(env, request) {
  if (await verifyAccessJwt(env, request)) return true;
  return verifySessionToken(env, readCookie(request, COOKIE_NAME));
}

// AIの機能を使うための前提（認証の設定）がそろっているかを調べます。
export function isAiAuthConfigured(env) {
  return isAuthConfigured(env) || isAccessConfigured(env);
}

// ===== パスワードの総当たり対策 =====
// 少人数での利用を想定し、記録はこの Worker の実行環境の中だけに持ちます。

export const LOGIN_FAILURE_LIMIT = 3;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000;
const LOGIN_LOCKOUT_MAX_ROUNDS = 6;
const loginFailures = new Map();
const rateLimitBuckets = new Map();

function readFailureRecord(key) {
  const record = loginFailures.get(key);
  if (!record) return null;
  // ロックの時間が過ぎたら、また3回まで試せるようにします（次に間違えたときの待ち時間は長くなります）。
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    record.failures = 0;
    record.lockedUntil = 0;
  }
  return record;
}

export function getLoginLockoutMs(key) {
  const record = readFailureRecord(key);
  if (!record?.lockedUntil) return 0;
  return Math.max(0, record.lockedUntil - Date.now());
}

export function recordLoginFailure(key) {
  const record = readFailureRecord(key) || { failures: 0, lockedUntil: 0, rounds: 0 };
  record.failures += 1;
  if (record.failures >= LOGIN_FAILURE_LIMIT) {
    record.rounds = Math.min(record.rounds + 1, LOGIN_LOCKOUT_MAX_ROUNDS);
    record.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS * record.rounds;
  }
  if (loginFailures.size > 500) {
    for (const [failureKey, failureRecord] of loginFailures) {
      if (!failureRecord.lockedUntil) loginFailures.delete(failureKey);
    }
  }
  loginFailures.set(key, record);
  return {
    remainingAttempts: Math.max(0, LOGIN_FAILURE_LIMIT - record.failures),
    lockoutMs: record.lockedUntil ? Math.max(0, record.lockedUntil - Date.now()) : 0,
  };
}

export function clearLoginFailures(key) {
  loginFailures.delete(key);
}

export function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (rateLimitBuckets.size > 500) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (now > bucket.resetAt) rateLimitBuckets.delete(bucketKey);
    }
  }
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function getClientKey(request) {
  return request.headers.get("CF-Connecting-IP")
    || String(request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "unknown";
}
