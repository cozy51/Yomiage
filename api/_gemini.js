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
// 音声を作るモデルです。文章用とは別のモデルを使います。
// Vercelの環境変数 GEMINI_TTS_MODEL を設定した場合は、そちらが優先されます。
const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9.\-]+$/;
// 音声や画像を作るためのモデルは、文章の処理には使えないため候補から除きます。
const UNUSABLE_MODEL_PATTERN = /tts|image|audio|live|embedding/;
const GEMINI_TIMEOUT_MS = 25000;
const GEMINI_TTS_TIMEOUT_MS = 27000;
const GEMINI_MODEL_LIST_TIMEOUT_MS = 8000;

// 環境変数の値が使えない形のときは、既定のモデル名に戻します。
function getGeminiModel() {
  const model = (process.env.GEMINI_MODEL || "").trim();
  return GEMINI_MODEL_PATTERN.test(model) ? model : DEFAULT_GEMINI_MODEL;
}

// 音声を作るモデル名です。こちらも環境変数で差し替えられます。
function getGeminiTtsModel() {
  const model = (process.env.GEMINI_TTS_MODEL || "").trim();
  return GEMINI_MODEL_PATTERN.test(model) ? model : DEFAULT_GEMINI_TTS_MODEL;
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
async function listAvailableModels(apiKey, options = {}) {
  // options.tts を付けると、音声を作れるモデルだけを返します。
  const wantsTts = Boolean(options.tts);

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
      .filter((name) => name.startsWith("gemini") && (wantsTts ? /tts/.test(name) : !UNUSABLE_MODEL_PATTERN.test(name)))
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
 * Geminiへ1回問い合わせます。返事の中身は呼び出し側で確かめます。
 */
async function requestGemini(apiKey, model, payload, timeoutMs) {
  return fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Geminiへ問い合わせて、返ってきた文章を取り出します。
 * 守ってほしいルール（options.systemInstruction）は、本文とは別の「指示」として渡します。
 * 本文の中に混ぜるより、指示として扱われやすくなるためです。
 * うまくいかなかったときは、呼び出し側が案内を選べるよう、状態コードを持たせて投げ直します。
 */
async function generateText(apiKey, parts, options = {}) {
  const model = getGeminiModel();
  const timeoutMs = options.timeoutMs || GEMINI_TIMEOUT_MS;
  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: typeof options.temperature === "number" ? options.temperature : 0,
      maxOutputTokens: options.maxOutputTokens || 8192,
    },
  };

  if (options.systemInstruction) {
    payload.system_instruction = { parts: [{ text: options.systemInstruction }] };
  }

  let geminiResponse = await requestGemini(apiKey, model, payload, timeoutMs);

  // 「指示」の渡し方に対応していないモデルのときは、指示を本文の先頭へ入れてもう一度試します。
  if (geminiResponse.status === 400 && payload.system_instruction) {
    console.error("system_instructionを受け付けなかったため、指示を本文へ入れて試し直します。", await readErrorBody(geminiResponse));
    geminiResponse = await requestGemini(apiKey, model, {
      contents: [{ parts: [{ text: options.systemInstruction }, ...parts] }],
      generationConfig: payload.generationConfig,
    }, timeoutMs);
  }

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
  // 考えている途中の文（thought）は読み上げに不要なため、返事の本文だけを取り出します。
  const text = removeCodeFence(responseParts
    .filter((part) => !part?.thought)
    .map((part) => part?.text || "")
    .join(""));

  if (!text) {
    console.error("Geminiが文章を返しませんでした。", JSON.stringify(result?.candidates?.[0]?.finishReason || result?.promptFeedback || {}));
  }

  return text;
}

/**
 * Geminiへ文章を渡して、読み上げた音声を受け取ります。
 * 返ってくるのは、ヘッダーの付いていない生の音声データ（PCM）をbase64にしたものです。
 * 再生できる形（WAV）へ組み立てるのはブラウザ側で行います。
 * 音声が返らなかったときはnullを返し、案内は呼び出し側で選びます。
 */
async function generateSpeech(apiKey, text, voiceName, options = {}) {
  const model = getGeminiTtsModel();
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  };

  const geminiResponse = await requestGemini(apiKey, model, payload, options.timeoutMs || GEMINI_TTS_TIMEOUT_MS);

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    console.error("Gemini TTS APIがエラーを返しました。", geminiResponse.status, await readErrorBody(geminiResponse));
    const error = new Error(`Gemini responded with ${geminiResponse.status}`);
    error.geminiStatus = geminiResponse.status;
    error.geminiModel = model;
    throw error;
  }

  const result = await geminiResponse.json();
  const responseParts = result?.candidates?.[0]?.content?.parts || [];
  const audioPart = responseParts.find((part) => part?.inlineData?.data
    && String(part?.inlineData?.mimeType || "").startsWith("audio/"));

  if (!audioPart) {
    console.error("Geminiが音声を返しませんでした。", JSON.stringify(result?.candidates?.[0]?.finishReason || result?.promptFeedback || {}));
    return null;
  }

  return { audio: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType };
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  GEMINI_TIMEOUT_MS,
  GEMINI_TTS_TIMEOUT_MS,
  getGeminiModel,
  getGeminiTtsModel,
  generateText,
  generateSpeech,
  listAvailableModels,
  removeCodeFence,
};
