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
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
// 音声を作るモデルです。文章用とは別のモデルを使います。
// Vercelの環境変数 GEMINI_TTS_MODEL を設定した場合は、そちらが優先されます。
const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
// メインのモデルが混み合って使えない（503など）ときに、代わりに使うモデルです。
// 少し品質は下がりますが、エラーで止まるより続けて使えることを優先します。
const FALLBACK_GEMINI_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
// Gemini側の一時的な不調を表す状態コードです。少し待ってやり直すと通ることが多いものです。
const TRANSIENT_STATUSES = [500, 502, 503, 504];
// 同じモデルでやり直すときの待ち時間です（この回数だけやり直します）。
const TRANSIENT_RETRY_DELAYS_MS = [1000, 3000];
// 残り時間がこれより短いときは、新しく問い合わせても間に合わないためやり直しません。
const MIN_ATTEMPT_MS = 8000;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9.\-]+$/;
// 音声や画像を作るためのモデルは、文章の処理には使えないため候補から除きます。
const UNUSABLE_MODEL_PATTERN = /tts|image|audio|live|embedding/;
// Flash（Liteではない）は考えてから答えるため、長めに待ちます（vercel.json の maxDuration より短くします）。
const GEMINI_TIMEOUT_MS = 50000;
const GEMINI_TTS_TIMEOUT_MS = 55000;
const GEMINI_MODEL_LIST_TIMEOUT_MS = 8000;
// 考える深さの既定値です（low / medium / high）。読み取りや翻訳のように忠実さが大事な処理は low で十分です。
const DEFAULT_THINKING_LEVEL = "low";
// AI音声の話し方の指示です。区切った文章ごとに作っても、声の調子がそろうように毎回同じ指示を渡します。
const TTS_STYLE = "落ち着いた自然な日本語のナレーション。はっきりと聞き取りやすく、一定の調子と速さで読み上げる";

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

// 使うモデルの順番です。メインのモデルのあとに、代わりのモデルを並べます。
function getTextModels() {
  return [...new Set([getGeminiModel(), FALLBACK_GEMINI_MODEL])];
}

function getTtsModels() {
  return [...new Set([getGeminiTtsModel(), FALLBACK_GEMINI_TTS_MODEL])];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Gemini側が混み合っているとき、返事の中で「◯秒後に試して」と教えてくれることがあります。
 * その秒数を取り出して、待ち時間として使えるようにします（最大60秒）。
 */
function readRetryAfterMs(errorBody) {
  const matched = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errorBody || "");
  if (!matched) return 0;
  return Math.min(Math.round(Number(matched[1]) * 1000), 60000);
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
 * Geminiへ問い合わせ、一時的な不調（503など）のときは少し待ってやり直します。
 * 同じモデルで何度やり直してもだめなときは、代わりのモデル（models の2番目以降）で試します。
 * 全体で timeoutMs を超えないようにし、最後に受け取った返事と、そのモデル名を返します。
 */
async function requestGeminiWithRetry(apiKey, models, payload, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  for (const model of models) {
    for (let attempt = 0; ; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (last && remainingMs < MIN_ATTEMPT_MS) return last;
      // 読まずに捨てる前の返事は、通信を開けたままにしないよう閉じておきます。
      if (last) await last.response.body?.cancel().catch(() => {});

      const response = await requestGemini(apiKey, model, payload, remainingMs);
      last = { response, model };
      if (!TRANSIENT_STATUSES.includes(response.status)) return last;

      const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
      console.error("Geminiが一時的に応答できませんでした。", response.status, model,
        delayMs === undefined ? "代わりのモデルで試します。" : `${delayMs}ミリ秒待ってやり直します。`);
      if (delayMs === undefined || deadline - Date.now() - delayMs < MIN_ATTEMPT_MS) break;
      await sleep(delayMs);
    }
  }

  return last;
}

/**
 * Geminiへ問い合わせて、返ってきた文章を取り出します。
 * 守ってほしいルール（options.systemInstruction）は、本文とは別の「指示」として渡します。
 * 本文の中に混ぜるより、指示として扱われやすくなるためです。
 * うまくいかなかったときは、呼び出し側が案内を選べるよう、状態コードを持たせて投げ直します。
 */
async function generateText(apiKey, parts, options = {}) {
  const timeoutMs = options.timeoutMs || GEMINI_TIMEOUT_MS;
  const startedAt = Date.now();
  const payload = {
    contents: [{ parts }],
    // Gemini 3.8 では temperature などの揺らぎの設定は使えないため、考える深さ（thinkingLevel）だけを指定します。
    // 考えた分も出力の上限に含まれるため、上限は多めにしています。
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens || 16384,
      thinkingConfig: { thinkingLevel: options.thinkingLevel || DEFAULT_THINKING_LEVEL },
    },
  };

  if (options.systemInstruction) {
    payload.system_instruction = { parts: [{ text: options.systemInstruction }] };
  }

  let { response: geminiResponse, model } = await requestGeminiWithRetry(apiKey, getTextModels(), payload, timeoutMs);

  // 環境変数で古いモデルを選んだときなど、「指示」や「考える深さ」の渡し方に対応していないときは、
  // 指示を本文の先頭へ入れ、考える深さを外してもう一度試します。
  if (geminiResponse.status === 400) {
    console.error("設定を受け付けなかったため、指示を本文へ入れて試し直します。", await readErrorBody(geminiResponse));
    const instructionParts = options.systemInstruction ? [{ text: options.systemInstruction }] : [];
    ({ response: geminiResponse, model } = await requestGeminiWithRetry(apiKey, [model], {
      contents: [{ parts: [...instructionParts, ...parts] }],
      generationConfig: { maxOutputTokens: payload.generationConfig.maxOutputTokens },
    }, Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS)));
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
  const timeoutMs = options.timeoutMs || GEMINI_TTS_TIMEOUT_MS;
  const startedAt = Date.now();
  const generationConfig = {
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
  };
  // 読み上げる文章はそのまま渡し、話し方の指示は speech_metadata として別に渡します。
  // 文章へ指示を混ぜると、指示まで読み上げてしまうことがあるためです。
  let { response: geminiResponse, model } = await requestGeminiWithRetry(apiKey, getTtsModels(), {
    contents: [{ parts: [{ text, speech_metadata: { style: TTS_STYLE } }] }],
    generationConfig,
  }, timeoutMs);

  // 話し方の指示に対応していないモデルのときは、文章だけで作り直します。
  if (geminiResponse.status === 400) {
    console.error("speech_metadataを受け付けなかったため、文章だけで試し直します。", await readErrorBody(geminiResponse));
    ({ response: geminiResponse, model } = await requestGeminiWithRetry(apiKey, [model], {
      contents: [{ parts: [{ text }] }],
      generationConfig,
    }, Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS)));
  }

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    const errorBody = await readErrorBody(geminiResponse);
    console.error("Gemini TTS APIがエラーを返しました。", geminiResponse.status, errorBody);
    const error = new Error(`Gemini responded with ${geminiResponse.status}`);
    error.geminiStatus = geminiResponse.status;
    error.geminiModel = model;
    // 混み合っているときは、どれくらい待てばよいかも一緒に持たせます。
    error.retryAfterMs = readRetryAfterMs(errorBody);
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
  readRetryAfterMs,
  generateText,
  generateSpeech,
  listAvailableModels,
  removeCodeFence,
};
