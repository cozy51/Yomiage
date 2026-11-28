/**
 * AIの機能（料金がかかる処理）を呼ぶ前の共通の確認です。
 * 認証の設定・認証済みかどうか・AI Binding の有無・呼び出し回数を確かめます。
 */

import { checkRateLimit, getClientKey, isAiAuthConfigured, isAuthenticated } from "../lib/auth.js";
import { json } from "../lib/http.js";

// 誤操作やプログラムの不具合でAIを呼び続けないよう、同じ利用者からの呼び出し回数に上限を設けます。
// AI音声は120文字ごとに呼ぶため、長い文章でも足りるように多めにしています。
const AI_REQUEST_LIMIT = 300;
const AI_REQUEST_WINDOW_MS = 10 * 60 * 1000;

const NAMES = { AI: "AIの機能", TTS: "AI音声" };

export async function guardAiRequest(env, request, prefix) {
  const name = NAMES[prefix] || NAMES.AI;

  // パスワードも Cloudflare Access も設定されていないときは、誰でも使える状態にしないため受け付けません。
  if (!isAiAuthConfigured(env)) {
    console.error("APP_PASSWORD_HASHが設定されていません。Workers Secretsを確認してください。");
    return json({ message: `${name}を利用できません。パスワードの設定を確認してください。`, code: `${prefix}-NOAUTH` }, 503);
  }

  if (!(await isAuthenticated(env, request))) {
    return json({ message: `${name}を利用するには、パスワードの入力が必要です。`, code: `${prefix}-401` }, 401);
  }

  if (!env.AI || typeof env.AI.run !== "function") {
    console.error("AI Binding（AI）が設定されていません。wrangler.jsonc を確認してください。");
    return json({ message: `${name}を利用できません。WorkersのAI Bindingの設定を確認してください。`, code: `${prefix}-NOBINDING` }, 503);
  }

  if (!checkRateLimit(`ai:${getClientKey(request)}`, AI_REQUEST_LIMIT, AI_REQUEST_WINDOW_MS)) {
    return json({ message: `${name}の呼び出しが多すぎます。しばらくしてから再度お試しください。`, code: `${prefix}-429` }, 429);
  }

  return null;
}

// 利用者へ返す「使ったモデル」の情報です。取得できないときは model を空にし、画面では「自動選択」と表示します。
export function modelInfo(result) {
  return {
    model: result.model || "",
    selection: result.selection,
    requestedModel: result.requestedModel,
  };
}
