"use strict";

/**
 * Gemini APIを呼び出すための共通処理です。
 *
 * APIキーはVercelの環境変数（GEMINI_API_KEY）からサーバー側だけで読み込み、
 * ブラウザへは一切渡しません。画像の読み取りと文章の処理で、同じ入口を使います。
 *
 * ファイル名が「_」で始まるものは、Vercelでは公開されるAPIになりません（共通処理用）。
 */

// 使用するGeminiのモデル名です。変更するときは、この1か所だけを書き換えてください。
// Vercelの環境変数 GEMINI_MODEL を設定した場合は、そちらが優先されます。
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9.\-]+$/;
// 音声や画像を作るためのモデルは、文章の処理には使えないため候補から除きます。
const UNUSABLE_MODEL_PATTERN = /tts|image|audio|live|embedding/;
const GEMINI_TIMEOUT_MS = 25000;
const GEMINI_MODEL_LIST_TIMEOUT_MS = 8000;

// 環境変数の値が使えない形のときは、既定のモデル名に戻します。
function getGeminiModel() {
  const model = (process.env.GEMINI_MODEL || "").trim();
  return GEMINI_MODEL_PATTERN.test(model) ? model : DEFAULT_GEMINI_MODEL;
}

// Gemini側の説明をログへ残すために読み取ります。読み取れない場合は空にします。
async function readErrorBody(geminiResponse) {
  try {
    return (await geminiResponse.text()).slice(0, 500);
  } catch (error) {
    return "";
  }
}

/**
 * モデル名が使えなかったときに、そのAPIキーで使えるモデル名を問い合わせます。
 * 直しかたをそのまま案内できるようにするためのもので、失敗しても空の一覧を返します。
 * モデル名は秘密の情報ではないため、案内へ含めても問題ありません。
 */
async function listAvailableModels(apiKey) {
  try {
    const modelsResponse = await fetch(`${GEMINI_API_BASE}/models?pageSize=100`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(GEMINI_MODEL_LIST_TIMEOUT_MS),
    });
    if (!modelsResponse.ok) return [];

    const data = await modelsResponse.json();
    return (data?.models || [])
      .filter((model) => (model?.supportedGenerationMethods || []).includes("generateContent"))
      .map((model) => String(model?.name || "").replace(/^models\//, ""))
      .filter((name) => name.startsWith("gemini") && !UNUSABLE_MODEL_PATTERN.test(name))
      // 軽いモデルで十分なため、flash系を先に並べます。
      .sort((a, b) => (b.includes("flash") ? 1 : 0) - (a.includes("flash") ? 1 : 0));
  } catch (error) {
    console.error("モデル一覧を取得できませんでした。", error?.name || error);
    return [];
  }
}

// 指示に反してMarkdownのコードブロックが返ってきた場合に備えて、その記号だけ取り除きます。
function removeCodeFence(text) {
  return text
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * Geminiへ問い合わせて、返ってきた文章を取り出します。
 * うまくいかなかったときは、呼び出し側が案内を選べるよう、状態コードを持たせて投げ直します。
 */
async function generateText(apiKey, parts, options = {}) {
  const model = getGeminiModel();
  const geminiResponse = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: options.maxOutputTokens || 8192 },
    }),
    signal: AbortSignal.timeout(options.timeoutMs || GEMINI_TIMEOUT_MS),
  });

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    console.error("Gemini APIがエラーを返しました。", geminiResponse.status, await readErrorBody(geminiResponse));
    const error = new Error(`Gemini responded with ${geminiResponse.status}`);
    error.geminiStatus = geminiResponse.status;
    error.geminiModel = model;
    throw error;
  }

  const result = await geminiResponse.json();
  const responseParts = result?.candidates?.[0]?.content?.parts || [];
  const text = removeCodeFence(responseParts.map((part) => part?.text || "").join(""));

  if (!text) {
    console.error("Geminiが文章を返しませんでした。", JSON.stringify(result?.candidates?.[0]?.finishReason || result?.promptFeedback || {}));
  }

  return text;
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  GEMINI_TIMEOUT_MS,
  getGeminiModel,
  generateText,
  listAvailableModels,
  removeCodeFence,
};
