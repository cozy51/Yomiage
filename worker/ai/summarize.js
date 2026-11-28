/**
 * 文章の要約・詳細要約です。モデルの選び方は Auto Router（cloudflare/auto）に任せます。
 * ほかのアプリ（MyBooks など）からも使えるよう、画面や認証とは切り離した関数にしています。
 */

import { generateText } from "./text.js";
import { SUMMARIZE_DETAIL_INSTRUCTION, SUMMARIZE_INSTRUCTION } from "./prompts.js";

export const SUMMARY_ACTIONS = ["summarize", "summarize-detail"];

export function getSummaryInstruction(action) {
  return action === "summarize-detail" ? SUMMARIZE_DETAIL_INSTRUCTION : SUMMARIZE_INSTRUCTION;
}

// 処理する文章です。指示と区切って渡し、どこからが文章かを分かるようにします。
export function buildSummaryRequest(action, text) {
  const request = action === "summarize-detail"
    ? "次の文章を日本語で詳しめに要約してください。"
    : "次の文章を日本語で要約してください。";
  return `${request}

--- ここから文章 ---
${text}
--- ここまで ---`;
}

/**
 * 文章を日本語で要約します。
 * @param {object} env
 * @param {string} text
 * @param {object} [options] { detail: 詳細要約にするか, selection: auto / fixed, system: 指示を差し替えるとき, timeoutMs }
 */
export function summarizeText(env, text, options = {}) {
  const action = options.detail ? "summarize-detail" : "summarize";
  return generateText(env, {
    system: options.system || getSummaryInstruction(action),
    content: buildSummaryRequest(action, text),
    selection: options.selection,
    feature: action,
    timeoutMs: options.timeoutMs,
  });
}
