/**
 * 文章を作るAI（チャット形式）を呼び出す共通処理です。OCR・要約・翻訳で使います。
 *
 * 既定ではモデルに cloudflare/auto（AI Gateway の Auto Router）を指定し、
 * 処理の内容や難しさ、料金に合わせたモデル選びを Cloudflare 側に任せます。
 * 画像を渡したときは、Auto Router が画像を読めるモデルだけから選びます。
 */

import { runGateway } from "./gateway.js";
import { AiError } from "./errors.js";
import { getTextModel } from "./config.js";

// 返事の長さの上限です（考える途中の分を含むモデルもあるため、多めにしています）。
const DEFAULT_MAX_TOKENS = 16384;
// 文章が空で返ってきたときに、自動でやり直す回数です。
const EMPTY_RETRY_COUNT = 1;

// 指示に反してMarkdownのコードブロックが返ってきた場合に備えて、その記号だけ取り除きます。
export function removeCodeFence(text) {
  return String(text || "")
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

// OpenAI形式（choices）と Workers AI 形式（response）のどちらの返事からも、本文を取り出します。
export function extractText(body) {
  if (typeof body === "string") return body;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || part.type === "output_text") && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  if (typeof body?.response === "string") return body.response;
  if (typeof body?.output_text === "string") return body.output_text;
  return "";
}

/**
 * 画像をチャット形式の入力へ変換します（data URL で渡します。画像はどこにも保存しません）。
 */
export function imagePart(mimeType, base64) {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };
}

/**
 * AIに文章を作らせます。
 * @param {object} env
 * @param {object} request
 * @param {string} request.system 守らせる指示
 * @param {string | Array<object>} request.content 依頼の本文（画像を含むときは配列）
 * @param {string} [request.selection] auto（自動選択）/ fixed（固定モデル）
 * @param {string} [request.feature] ログ用の機能名
 * @param {number} [request.maxTokens]
 * @param {number} [request.timeoutMs]
 * @returns {Promise<{ text: string, model: string, requestedModel: string, selection: string, routingReason: string }>}
 */
export async function generateText(env, request) {
  const { model, selection } = getTextModel(env, request.selection);
  const input = {
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.content },
    ],
    max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS,
  };

  for (let attempt = 0; ; attempt += 1) {
    const result = await runGateway(env, model, input, {
      feature: request.feature,
      timeoutMs: request.timeoutMs,
      // 固定モデルは、一時的な不調のときに AI Gateway 側で1回だけやり直します。
      // 自動選択では、Auto Router が代わりのモデルを試すため、やり直しは付けません。
      maxAttempts: selection === "fixed" ? 2 : 1,
    });
    const text = removeCodeFence(extractText(result.body));
    // 実際に使ったモデル名です。自動選択で取得できないときは空のままにし、画面では「自動選択」と表示します。
    const usedModel = result.routedModel || (selection === "fixed" ? model : "");

    if (text) {
      return { text, model: usedModel, requestedModel: model, selection, routingReason: result.routingReason };
    }

    console.error("AIが文章を返しませんでした。", usedModel || model, attempt < EMPTY_RETRY_COUNT ? "もう一度だけ試します。" : "");
    if (attempt >= EMPTY_RETRY_COUNT) {
      throw new AiError("empty", { model: usedModel || model });
    }
  }
}
