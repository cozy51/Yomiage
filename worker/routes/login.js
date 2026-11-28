/**
 * /api/login ― AIの機能を使うためのパスワード認証です。
 * パスワードはこのサーバー側だけで確かめ、ブラウザには署名付きの引換券を HttpOnly Cookie として渡します。
 */

import {
  buildSessionCookie,
  checkRateLimit,
  clearLoginFailures,
  getClientKey,
  getLoginLockoutMs,
  isAuthConfigured,
  LOGIN_FAILURE_LIMIT,
  recordLoginFailure,
  SESSION_DURATION_MS,
  verifyPassword,
} from "../lib/auth.js";
import { json, methodNotAllowed, readJson } from "../lib/http.js";

// 総当たりを防ぐため、同じ利用者からの試行回数を制限します。
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOCKED_MESSAGE = `パスワードを${LOGIN_FAILURE_LIMIT}回続けて間違えたため、しばらくAIの機能を利用できません。`;

// 待ち時間を「約○分」「約○時間」の形にします。
function describeWait(lockoutMs) {
  const minutes = Math.max(1, Math.ceil(lockoutMs / 60000));
  return minutes >= 60 ? `約${Math.ceil(minutes / 60)}時間` : `約${minutes}分`;
}

export async function handleLogin(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST", "AUTH-405");

  if (!isAuthConfigured(env)) {
    console.error("APP_PASSWORD_HASHが設定されていません。Workers Secretsを確認してください。");
    return json({ message: "AIの機能を利用できません。パスワードの設定を確認してください。", code: "AUTH-NOHASH" }, 503);
  }

  const failureKey = `login:${getClientKey(request)}`;
  const lockoutMs = getLoginLockoutMs(failureKey);
  if (lockoutMs > 0) {
    return json({ message: `${LOCKED_MESSAGE}あと${describeWait(lockoutMs)}お待ちください。`, code: "AUTH-LOCKED" }, 429);
  }

  if (!checkRateLimit(failureKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS)) {
    return json({ message: "試行回数が多すぎます。しばらくしてから再度お試しください。", code: "AUTH-429" }, 429);
  }

  const body = await readJson(request);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!(await verifyPassword(env, password))) {
    const failure = recordLoginFailure(failureKey);
    if (failure.lockoutMs > 0) {
      console.warn("パスワードを続けて間違えたため、しばらく受け付けません。");
      return json({ message: `${LOCKED_MESSAGE}あと${describeWait(failure.lockoutMs)}お待ちください。`, code: "AUTH-LOCKED" }, 429);
    }
    return json({ message: `パスワードが違います。（あと${failure.remainingAttempts}回）`, code: "AUTH-401" }, 401);
  }

  clearLoginFailures(failureKey);
  // 認証できたことだけを返します。パスワードや引換券の中身は返しません。
  return json(
    { ok: true, expiresInHours: Math.round(SESSION_DURATION_MS / 3600000) },
    200,
    { "Set-Cookie": await buildSessionCookie(env) },
  );
}
