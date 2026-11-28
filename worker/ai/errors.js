/**
 * AI Gateway・Workers AI から返るエラーを、利用者に見せる日本語の案内と短い印（コード）に振り分けます。
 * 印は、うまくいかないときにどこで止まったかを見分けるためのもので、秘密の情報は含みません。
 *
 * 参考: https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/
 */

export class AiError extends Error {
  /**
   * @param {string} kind エラーの種類（limit / busy / credit / config / bad-request / upstream / timeout / empty / unavailable / failed）
   * @param {object} [details]
   */
  constructor(kind, details = {}) {
    super(details.message || kind);
    this.name = "AiError";
    this.kind = kind;
    this.status = details.status || 0;
    this.gatewayCode = details.gatewayCode || 0;
    this.model = details.model || "";
  }
}

// エラーの本文や例外の文から、AI Gateway の4桁のエラー番号（2018、7003 など）を取り出します。
export function readGatewayCode(text) {
  const source = String(text || "");
  const jsonCode = /"code"\s*:\s*(\d{4})\b/.exec(source);
  if (jsonCode) return Number(jsonCode[1]);
  const leadingCode = /(?:^|[\s:])(\d{4}):/.exec(source);
  return leadingCode ? Number(leadingCode[1]) : 0;
}

/**
 * 状態コードとエラー番号から、エラーの種類を決めます。
 * - 429 かつ 2018：Unified Billing の回数制限（少し待てば通る）
 * - 429（それ以外）：Spend Limits などの利用上限（待っても通らないことが多いため、自動ではやり直しません）
 * - 402：クレジット残高の不足
 * - 401 / 403：AI Gateway の設定（認証・Unified Billing の有効化など）
 */
export function classifyGatewayFailure(status, gatewayCode) {
  if (gatewayCode === 2018) return "busy";
  if (status === 429) return "limit";
  if (status === 402 || gatewayCode === 2052 || gatewayCode === 2021) return "credit";
  if (status === 401 || status === 403 || [2009, 2036, 2042, 2044, 2049].includes(gatewayCode)) return "config";
  if (gatewayCode === 7003 || (status === 400 && !gatewayCode)) return "bad-request";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503 || gatewayCode === 7005) return "unavailable";
  if (status >= 500 || [2002, 2005].includes(gatewayCode)) return "upstream";
  return "failed";
}

// 例外（env.AI.run が投げたもの）を AiError にそろえます。
export function toAiError(error, model = "") {
  if (error instanceof AiError) return error;
  const name = error?.name || "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new AiError("timeout", { model, message: name });
  }
  const message = String(error?.message || error || "");
  const gatewayCode = readGatewayCode(message);
  const kind = gatewayCode ? classifyGatewayFailure(0, gatewayCode) : "failed";
  return new AiError(kind, { gatewayCode, model, message });
}

// 機能ごとの名前です（案内の文頭に使います）。
const FEATURE_NAMES = {
  ocr: "AI OCR",
  text: "AIの機能",
  tts: "AI音声",
};

/**
 * 利用者へ返す案内・印・HTTPの状態コードを作ります。
 * prefix は印の頭（AI / TTS）です。
 */
export function describeAiError(error, feature = "text") {
  const name = FEATURE_NAMES[feature] || FEATURE_NAMES.text;
  const prefix = feature === "tts" ? "TTS" : "AI";
  const kind = error?.kind || "failed";

  switch (kind) {
    case "limit":
      return {
        status: 429,
        code: `${prefix}-LIMIT`,
        message: `${name}の利用上限に達したため、いまは利用できません。上限はCloudflareのAI Gateway（Spend Limits）で管理しています。時間をおいてお試しいただくか、管理者に上限の確認を依頼してください。`,
      };
    case "busy":
      return {
        status: 429,
        code: `${prefix}-BUSY`,
        message: `${name}が混み合っています。少し待ってから再度お試しください。`,
      };
    case "credit":
      return {
        status: 402,
        code: `${prefix}-CREDIT`,
        message: `${name}の利用料金に使うクレジットの残高が足りません。管理者にご連絡ください。`,
      };
    case "config":
      return {
        status: 503,
        code: `${prefix}-CONFIG`,
        message: `${name}を利用できません。Cloudflare AI Gatewayの設定（認証・Unified Billing）を確認してください。`,
      };
    case "bad-request":
      return {
        status: 502,
        code: `${prefix}-G400`,
        message: `${name}が依頼を受け付けませんでした。内容を短くするか、別の画像・文章でお試しください。`,
      };
    case "timeout":
      return {
        status: 504,
        code: `${prefix}-TIMEOUT`,
        message: feature === "ocr"
          ? "AI OCRが時間内に終わりませんでした。小さい画像か、無料OCRでお試しください。"
          : `${name}の処理が時間内に終わりませんでした。短い文章でお試しください。`,
      };
    case "unavailable":
      return {
        status: 503,
        code: `${prefix}-G503`,
        message: `${name}が一時的に利用できません。しばらくしてから再度お試しください。`,
      };
    case "upstream":
      return {
        status: 502,
        code: `${prefix}-G500`,
        message: `${name}の提供元で問題が起きました。しばらくしてから再度お試しください。`,
      };
    case "empty":
      return {
        status: 502,
        code: `${prefix}-EMPTY`,
        message: feature === "ocr"
          ? "AIが文字を読み取れませんでした。無料OCRをお試しください。"
          : feature === "tts"
            ? "AIが音声を返しませんでした。もう一度お試しください。"
            : "AIが文章を返しませんでした。もう一度お試しください。",
      };
    case "no-binding":
      return {
        status: 503,
        code: `${prefix}-NOBINDING`,
        message: `${name}を利用できません。WorkersのAI Binding（AI）の設定を確認してください。`,
      };
    default:
      return {
        status: 502,
        code: `${prefix}-FAILED`,
        message: `${name}の処理に失敗しました。しばらくしてから再度お試しください。`,
      };
  }
}
