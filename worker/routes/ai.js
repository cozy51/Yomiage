/**
 * /api/ai ― 文章をAIで処理します（翻訳・要約・詳細要約）。
 * 文章は処理のあいだだけ扱い、どこにも保存しません。
 */

import { json, methodNotAllowed, readJson } from "../lib/http.js";
import { guardAiRequest, modelInfo } from "./guard.js";
import { describeAiError } from "../ai/errors.js";
import { getSummaryInstruction, SUMMARY_ACTIONS, summarizeText } from "../ai/summarize.js";
import { buildTranslateInstruction, TARGET_LANGUAGES, translateText } from "../ai/translate.js";
import { isSameText } from "./ocr.js";

// 受け付ける文章の長さです。時間内に返事を作り終えられる長さにしています。
// 要約は返事が短いため長めに、翻訳は原文と同じくらいの長さを書き出すため短めにしています。
export const MAX_SUMMARY_TEXT_LENGTH = 100000;
export const MAX_TRANSLATE_TEXT_LENGTH = 20000;

function run(env, action, text, language, selection, system) {
  return action === "translate"
    ? translateText(env, text, language, { selection, system })
    : summarizeText(env, text, { detail: action === "summarize-detail", selection, system });
}

export async function handleAi(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST", "AI-405");

  const blocked = await guardAiRequest(env, request, "AI");
  if (blocked) return blocked;

  const body = await readJson(request);
  const action = typeof body?.action === "string" ? body.action : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text || !(action === "translate" || SUMMARY_ACTIONS.includes(action))) {
    return json({ message: "文章を受け取れませんでした。もう一度お試しください。", code: "AI-BADREQ" }, 400);
  }

  const maxTextLength = action === "translate" ? MAX_TRANSLATE_TEXT_LENGTH : MAX_SUMMARY_TEXT_LENGTH;
  if (text.length > maxTextLength) {
    return json({
      message: `文章が長すぎます（${maxTextLength.toLocaleString("ja-JP")}文字まで）。短く分けてお試しください。`,
      code: "AI-LONG",
    }, 413);
  }

  const language = action === "translate" ? (typeof body?.targetLanguage === "string" ? body.targetLanguage : "ja") : "";
  if (action === "translate" && !TARGET_LANGUAGES[language]) {
    return json({ message: "その言語には対応していません。", code: "AI-LANG" }, 400);
  }

  const selection = body?.modelSelection ?? body?.modelPriority;

  try {
    let result = await run(env, action, text, language, selection);
    let unchanged = isSameText(result.text, text);

    // 原文がそのまま返ってきたときは、処理されていないため、強く念を押してもう一度だけ試します。
    if (unchanged) {
      console.error("原文がそのまま返ってきたため、もう一度試します。", action);
      const instruction = action === "translate"
        ? buildTranslateInstruction(TARGET_LANGUAGES[language])
        : getSummaryInstruction(action);
      const retryInstruction = `${instruction}

・前回はあなたが原文をそのまま返してしまいました。今度は必ず${action === "translate" ? `${TARGET_LANGUAGES[language]}へ翻訳した` : "日本語で要約した"}文章を返してください`;
      try {
        const retried = await run(env, action, text, language, selection, retryInstruction);
        if (!isSameText(retried.text, text)) {
          result = retried;
          unchanged = false;
        }
      } catch (error) {
        // やり直しに失敗したときは、最初の結果をそのまま返します。
        console.error("やり直しに失敗しました。", error?.kind || error?.name || error);
      }
    }

    // unchanged は、原文と中身が変わらなかったことを画面へ伝えるための印です。
    return json({ text: result.text, unchanged, ...modelInfo(result) });
  } catch (error) {
    const described = describeAiError(error, "text");
    return json({ message: described.message, code: described.code }, described.status);
  }
}
