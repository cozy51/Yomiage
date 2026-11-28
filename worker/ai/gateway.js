/**
 * Cloudflare AI Gateway を通してAIのモデルを呼び出す共通の入口です。
 *
 * Workers の AI Binding（env.AI）を使うため、AIサービスごとのAPIキーは要りません。
 * 外部のモデル（google/〇〇、openai/〇〇 など）の料金は、AI Gateway の Unified Billing で
 * Cloudflare のクレジットから支払われ、利用料金・リクエスト数・使用モデルは AI Gateway のダッシュボードで確認できます。
 *
 * - returnRawResponse で生の応答を受け取り、Auto Router が実際に選んだモデル（cf-aig-routed-model）を読み取ります。
 * - 機密情報を含むことがあるため、AI Gateway のキャッシュは使わず、ログには本文を残しません（件数・料金・モデルなどは残ります）。
 * - やり直しは AI Gateway 側の回数の決まった設定だけで行い、無制限には繰り返しません。
 *
 * 参考:
 * https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
 * https://developers.cloudflare.com/ai-gateway/features/routing/auto-router/
 */

import { AiError, classifyGatewayFailure, readGatewayCode, toAiError } from "./errors.js";
import { getAutoRouterRestrictions, getGatewayId, shouldLogPayload } from "./config.js";

// 1回の呼び出しで待つ長さです。最初の応答がこれより遅いときは、AI Gateway がエラーにします。
export const DEFAULT_REQUEST_TIMEOUT_MS = 50000;
// AI Gateway の応答そのものを待つ上限です（Gateway側の時間切れより少し長くします）。
const BINDING_TIMEOUT_MARGIN_MS = 5000;

// 応答のヘッダーから、実際に使われたモデルと選ばれた理由を読み取ります。
function readRouting(headers) {
  if (!headers || typeof headers.get !== "function") return { routedModel: "", routingReason: "" };
  return {
    routedModel: String(headers.get("cf-aig-routed-model") || headers.get("cf-aig-model") || "").trim(),
    routingReason: String(headers.get("cf-aig-routing-reason") || "").trim(),
  };
}

async function readBody(response) {
  const text = await response.text().catch(() => "");
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/**
 * AI Gateway へ1回問い合わせます。
 * @param {object} env Workers の環境（env.AI を使います）
 * @param {string} model モデル名（cloudflare/auto、google/gemini-3.8-flash-tts など）
 * @param {object} input モデルへ渡す内容
 * @param {object} [options]
 * @param {string} [options.feature] ログに付ける機能名（ocr / summarize / translate / tts など）。Spend Limits を機能ごとに分けるときにも使えます
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxAttempts] AI Gateway 側でやり直す回数（1〜3）。自動選択では Auto Router が代わりのモデルを試すため 1 にします
 * @returns {Promise<{ body: any, routedModel: string, routingReason: string, model: string }>}
 */
export async function runGateway(env, model, input, options = {}) {
  if (!env?.AI || typeof env.AI.run !== "function") {
    throw new AiError("no-binding", { model, message: "AI binding is not configured" });
  }

  const timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || 1, 1), 3);
  const extraHeaders = {};
  // 入力・出力の本文はログへ残しません（件数・料金・モデルなどの記録は残ります）。
  if (!shouldLogPayload(env)) extraHeaders["cf-aig-collect-log-payload"] = "false";

  // Auto Router の候補を絞る設定があるときだけ付けます（高額なモデルへ意図せず切り替わるのを防ぐためです）。
  if (model === "cloudflare/auto") {
    const { allowedModels, allowedProviders } = getAutoRouterRestrictions(env);
    if (allowedModels.length) extraHeaders["cf-aig-allowed-models"] = allowedModels.join(",");
    if (allowedProviders.length) extraHeaders["cf-aig-allowed-providers"] = allowedProviders.join(",");
    // 1回ごとの依頼なので、会話の途中でモデルを固定する仕組みは使いません。
    extraHeaders["cf-aig-no-session-affinity"] = "true";
  }

  const gateway = {
    id: getGatewayId(env),
    // 機密情報を含むことがあるため、同じ依頼でもキャッシュから返さず、保存もさせません。
    skipCache: true,
    requestTimeoutMs: timeoutMs,
    // 個人を特定できる情報は付けず、どのアプリのどの機能かだけを付けます。
    metadata: { app: "yomiage", feature: String(options.feature || "ai") },
  };
  if (maxAttempts > 1) {
    gateway.retries = { maxAttempts, retryDelayMs: 1000, backoff: "exponential" };
  }

  let result;
  try {
    result = await env.AI.run(model, input, {
      gateway,
      returnRawResponse: true,
      extraHeaders,
      signal: AbortSignal.timeout(timeoutMs * maxAttempts + BINDING_TIMEOUT_MARGIN_MS),
    });
  } catch (error) {
    throw toAiError(error, model);
  }

  // 生の応答を受け取れなかったとき（実行環境によっては中身だけが返ります）は、ヘッダーなしで扱います。
  if (!(result instanceof Response)) {
    return { body: result, routedModel: "", routingReason: "", model };
  }

  const routing = readRouting(result.headers);
  const { json, text } = await readBody(result);

  if (!result.ok) {
    const gatewayCode = readGatewayCode(text);
    // 原因を追えるよう、状態コードとエラー番号だけをログへ残します（入力した文章や画像は残しません）。
    console.error("AI Gatewayがエラーを返しました。", result.status, gatewayCode || "-", model, text.slice(0, 300));
    throw new AiError(classifyGatewayFailure(result.status, gatewayCode), {
      status: result.status,
      gatewayCode,
      model: routing.routedModel || model,
      message: `AI Gateway responded with ${result.status}`,
    });
  }

  // OpenAI形式の返事に含まれるモデル名は、cloudflare/auto などの依頼した名前のことがあるため、
  // 実際のモデル名と分かるときだけ使います（推測したモデル名は出しません）。
  const bodyModel = typeof json?.model === "string" ? json.model.trim() : "";
  const routedModel = routing.routedModel
    || (bodyModel && bodyModel !== model && !/^(cloudflare\/auto|custom\/|dynamic\/)/.test(bodyModel) ? bodyModel : "");

  return { body: json ?? text, routedModel, routingReason: routing.routingReason, model };
}
