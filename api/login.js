"use strict";

/**
 * 「AIで高精度OCR」を使うためのパスワード認証です。
 *
 * パスワードはこのサーバー側だけで確かめます。ブラウザには、
 * 書き換えられない署名付きの引換券をHttpOnly Cookieとして渡します。
 * 正しいパスワードのハッシュは、Vercelの環境変数 APP_PASSWORD_HASH から読み込みます。
 */

const {
  isAuthConfigured,
  verifyPassword,
  buildSessionCookie,
  checkRateLimit,
  getClientKey,
  SESSION_DURATION_MS,
} = require("./_auth");

// 総当たりを防ぐため、同じ利用者からの試行回数を制限します。
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const MESSAGES = {
  methodNotAllowed: "この操作は利用できません。",
  notConfigured: "AI OCRを利用できません。パスワードの設定を確認してください。",
  invalidPassword: "パスワードが違います。",
  tooManyAttempts: "試行回数が多すぎます。しばらくしてから再度お試しください。",
};

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ message: MESSAGES.methodNotAllowed, code: "AUTH-405" });
  }

  if (!isAuthConfigured()) {
    console.error("APP_PASSWORD_HASHが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.notConfigured, code: "AUTH-NOHASH" });
  }

  if (!checkRateLimit(`login:${getClientKey(request)}`, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS)) {
    return response.status(429).json({ message: MESSAGES.tooManyAttempts, code: "AUTH-429" });
  }

  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  const password = typeof body?.password === "string" ? body.password : "";

  if (!verifyPassword(password)) {
    return response.status(401).json({ message: MESSAGES.invalidPassword, code: "AUTH-401" });
  }

  // 認証できたことだけを返します。パスワードや引換券の中身は返しません。
  response.setHeader("Set-Cookie", buildSessionCookie());
  return response.status(200).json({ ok: true, expiresInHours: Math.round(SESSION_DURATION_MS / 3600000) });
};

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}
