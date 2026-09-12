"use strict";

/**
 * 「AIで高精度OCR」を使うときだけ必要になる、かんたんなパスワード認証の共通処理です。
 *
 * 読み上げと通常OCRは誰でも使えます。料金が発生するAI OCRだけを守ります。
 *
 * パスワードはサーバー側だけで確かめます。ブラウザへは、
 * 書き換えられない署名付きの引換券（トークン）をHttpOnly Cookieで渡すだけにして、
 * パスワードそのものやAPIキーはブラウザへ一切渡しません。
 *
 * ファイル名が「_」で始まるものは、Vercelでは公開されるAPIになりません（共通処理用）。
 */

const crypto = require("crypto");

const COOKIE_NAME = "yomiage_ai";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

// 署名に使う鍵です。SESSION_SECRETがあればそれを使い、なければパスワードのハッシュから作ります。
// （どちらもサーバー側にしかない値です。SESSION_SECRETを変えると、認証はやり直しになります。）
function getSigningKey() {
  const secret = (process.env.SESSION_SECRET || "").trim();
  if (secret) return secret;

  const passwordHash = (process.env.APP_PASSWORD_HASH || "").trim();
  return passwordHash ? `yomiage:${passwordHash}` : "";
}

function isAuthConfigured() {
  return SHA256_HEX_PATTERN.test((process.env.APP_PASSWORD_HASH || "").trim());
}

function sign(value) {
  return crypto.createHmac("sha256", getSigningKey()).update(value).digest("base64url");
}

// 文字列の比較にかかる時間から中身を推測されないよう、長さをそろえて比べます。
function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function verifyPassword(password) {
  if (!isAuthConfigured() || typeof password !== "string" || !password) return false;

  const inputHash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
  return safeEqual(inputHash, (process.env.APP_PASSWORD_HASH || "").trim().toLowerCase());
}

// 有効期限と、その署名だけを持つ引換券です。中身を書き換えると署名が合わなくなります。
function createSessionToken() {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  return `${expiresAt}.${sign(String(expiresAt))}`;
}

function verifySessionToken(token) {
  if (!isAuthConfigured() || typeof token !== "string") return false;

  const [expiresPart, signature] = token.split(".");
  const expiresAt = Number(expiresPart);
  if (!expiresPart || !signature || !Number.isFinite(expiresAt)) return false;
  if (Date.now() > expiresAt) return false;

  return safeEqual(signature, sign(expiresPart));
}

function readCookie(request, name) {
  const cookieHeader = request.headers?.cookie || "";
  const found = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function isAuthenticated(request) {
  return verifySessionToken(readCookie(request, COOKIE_NAME));
}

// HttpOnlyなので、ブラウザのJavaScriptからは読み書きできません。
function buildSessionCookie() {
  const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
  return `${COOKIE_NAME}=${createSessionToken()}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * パスワードを続けて間違えたときに、しばらく受け付けないようにします。
 * 3回続けて間違えると一定時間ロックし、そのあとも間違えるほど待ち時間が長くなります。
 * 正しいパスワードが入力できれば、数えていた回数は消えます。
 */
const LOGIN_FAILURE_LIMIT = 3;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000;
const LOGIN_LOCKOUT_MAX_ROUNDS = 6;

const loginFailures = new Map();

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

// あとどれくらいロックされているかを返します。0ならロックされていません。
function getLoginLockoutMs(key) {
  const record = readFailureRecord(key);
  if (!record?.lockedUntil) return 0;
  return Math.max(0, record.lockedUntil - Date.now());
}

function recordLoginFailure(key) {
  const record = readFailureRecord(key) || { failures: 0, lockedUntil: 0, rounds: 0 };
  record.failures += 1;

  if (record.failures >= LOGIN_FAILURE_LIMIT) {
    record.rounds = Math.min(record.rounds + 1, LOGIN_LOCKOUT_MAX_ROUNDS);
    record.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS * record.rounds;
  }

  // 記録がたまりすぎないよう、ロックされていない古いものを片付けます。
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

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

/**
 * 同じ利用者からの短時間の呼び出しすぎを防ぎます。
 * 少人数での利用を想定しているため、記録はこの関数の実行環境の中だけに持ちます。
 */
const rateLimitBuckets = new Map();

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();

  // 記録がたまりすぎないよう、期限切れのものを片付けます。
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

function getClientKey(request) {
  const forwarded = request.headers?.["x-forwarded-for"] || "";
  return String(forwarded).split(",")[0].trim() || request.socket?.remoteAddress || "unknown";
}

module.exports = {
  COOKIE_NAME,
  SESSION_DURATION_MS,
  LOGIN_FAILURE_LIMIT,
  isAuthConfigured,
  verifyPassword,
  isAuthenticated,
  buildSessionCookie,
  checkRateLimit,
  getClientKey,
  getLoginLockoutMs,
  recordLoginFailure,
  clearLoginFailures,
};
