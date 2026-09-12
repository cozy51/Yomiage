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
  getLoginLockoutMs,
  recordLoginFailure,
  clearLoginFailures,
  SESSION_DURATION_MS,
  LOGIN_FAILURE_LIMIT,
} = require("./_auth");

// 総当たりを防ぐため、同じ利用者からの試行回数を制限します。
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const MESSAGES = {
  methodNotAllowed: "この操作は利用できません。",
  notConfigured: "AI OCRを利用できません。パスワードの設定を確認してください。",
  invalidPassword: "パスワードが違います。",
  tooManyAttempts: "試行回数が多すぎます。しばらくしてから再度お試しください。",
  locked: `パスワードを${LOGIN_FAILURE_LIMIT}回続けて間違えたため、しばらくAI OCRを利用できません。`,
};

// 待ち時間を「約○分」「約○時間」の形にします。
function describeWait(lockoutMs) {
  const minutes = Math.max(1, Math.ceil(lockoutMs / 60000));
  return minutes >= 60 ? `約${Math.ceil(minutes / 60)}時間` : `約${minutes}分`;
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ message: MESSAGES.methodNotAllowed, code: "AUTH-405" });
  }

  if (!isAuthConfigured()) {
    console.error("APP_PASSWORD_HASHが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.notConfigured, code: "AUTH-NOHASH" });
  }

  const failureKey = `login:${getClientKey(request)}`;

  // 続けて間違えたあとは、しばらく受け付けません。
  const lockoutMs = getLoginLockoutMs(failureKey);
  if (lockoutMs > 0) {
    return response.status(429).json({
      message: `${MESSAGES.locked}あと${describeWait(lockoutMs)}お待ちください。`,
      code: "AUTH-LOCKED",
    });
  }

  if (!checkRateLimit(failureKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS)) {
    return response.status(429).json({ message: MESSAGES.tooManyAttempts, code: "AUTH-429" });
  }

  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  const password = typeof body?.password === "string" ? body.password : "";

  if (!verifyPassword(password)) {
    const failure = recordLoginFailure(failureKey);

    if (failure.lockoutMs > 0) {
      console.warn("パスワードを続けて間違えたため、しばらく受け付けません。");
      return response.status(429).json({
        message: `${MESSAGES.locked}あと${describeWait(failure.lockoutMs)}お待ちください。`,
        code: "AUTH-LOCKED",
      });
    }

    return response.status(401).json({
      message: `${MESSAGES.invalidPassword}（あと${failure.remainingAttempts}回）`,
      code: "AUTH-401",
    });
  }

  // 認証できたので、間違えた回数の記録を消します。
  clearLoginFailures(failureKey);

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
