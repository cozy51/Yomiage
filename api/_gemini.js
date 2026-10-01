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
// メインのモデルが混み合っている・利用上限に達した（429・503など）ときに、代わりに使うモデルです。
// 利用上限はモデルごとに別々のため、別のモデルに切り替えると続けて使えることが多くなります。
const FALLBACK_GEMINI_MODEL = "gemini-3.8-flash";
const FALLBACK_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
// Gemini 3.8 以降のモデルです。temperature が使えず、考える深さ（thinkingLevel）や話し方の指示を使います。
const NEW_GENERATION_MODEL_PATTERN = /^gemini-(3\.[89]|[4-9])/;
// Gemini側の一時的な不調を表す状態コードです。少し待ってやり直すと通ることが多いものです。
const TRANSIENT_STATUSES = [500, 502, 503, 504];
// 利用上限に達したときに、同じモデルで待ってやり直す最長の時間です。これより長く待つ必要があるときは、やり直しません。
const MAX_QUOTA_WAIT_MS = 15000;
// 同じモデルでやり直すときの待ち時間です（この回数だけやり直します）。
const TRANSIENT_RETRY_DELAYS_MS = [1000, 3000];
// 残り時間がこれより短いときは、新しく問い合わせても間に合わないためやり直しません。
const MIN_ATTEMPT_MS = 8000;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9.\-]+$/;
// 音声や画像を作るためのモデルは、文章の処理には使えないため候補から除きます。
const UNUSABLE_MODEL_PATTERN = /tts|image|audio|live|embedding/;
// 混み合っているときのやり直しや、代わりのモデル（Flash）の分も含めて待ちます（vercel.json の maxDuration より短くします）。
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
 * Geminiへ問い合わせ、混み合っている・利用上限に達したときは自動でやり直します。
 * - 一時的な不調（503など）：少し待って同じモデルでやり直し、それでもだめなら次のモデルへ
 * - 利用上限（429）：上限はモデルごとに別々のため、すぐ次のモデルへ。次がなければ、短い待ちで済むときだけ待ってやり直す
 * buildPayload はモデル名を受け取り、そのモデルに合った依頼の中身を返します。
 * 全体で timeoutMs を超えないようにし、最後に受け取った返事・モデル名・エラーの説明を返します。
 */
async function requestGeminiWithRetry(apiKey, models, buildPayload, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const hasNextModel = index < models.length - 1;
    let quotaRetried = false;

    for (let attempt = 0; ; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (last && remainingMs < MIN_ATTEMPT_MS) return last;

      const response = await requestGemini(apiKey, model, buildPayload(model), remainingMs);
      last = { response, model, errorBody: null };
      const isTransient = TRANSIENT_STATUSES.includes(response.status);
      if (!isTransient && response.status !== 429) return last;

      // やり直すかどうかを決めるため、Gemini側の説明（待つべき秒数など）を読んでおきます。
      last.errorBody = await readErrorBody(response);
      let delayMs;
      if (isTransient) {
        delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
      } else if (!hasNextModel && !quotaRetried) {
        const retryAfterMs = readRetryAfterMs(last.errorBody) || TRANSIENT_RETRY_DELAYS_MS[0];
        if (retryAfterMs <= MAX_QUOTA_WAIT_MS) delayMs = retryAfterMs;
        quotaRetried = true;
      }

      const canWait = delayMs !== undefined && deadline - Date.now() - delayMs >= MIN_ATTEMPT_MS;
      console.error("Geminiが応答できませんでした。", response.status, model,
        canWait ? `${delayMs}ミリ秒待ってやり直します。` : hasNextModel ? "代わりのモデルで試します。" : "やり直しをあきらめます。");
      if (!canWait) break;
      await sleep(delayMs);
    }
  }

  return last;
}

// うまくいかなかった返事から、Gemini側の説明を取り出します（やり直しの判断で読んだ分も含めます）。
async function readLastErrorBody(last) {
  return last.errorBody !== null ? last.errorBody : readErrorBody(last.response);
}

function isNewGenerationModel(model) {
  return NEW_GENERATION_MODEL_PATTERN.test(model);
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
  // モデルの世代によって、使える設定が違います。
  // Gemini 3.8 以降：temperature は使えないため、考える深さ（thinkingLevel）を指定し、考えた分も含めて上限を多めにします。
  // それより前：temperature 0 で、毎回同じように忠実に答えさせます。
  const buildGenerationConfig = (model) => (isNewGenerationModel(model)
    ? {
      maxOutputTokens: options.maxOutputTokens || 16384,
      thinkingConfig: { thinkingLevel: options.thinkingLevel || DEFAULT_THINKING_LEVEL },
    }
    : {
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens || 8192,
    });
  const buildPayload = (model) => ({
    contents: [{ parts }],
    generationConfig: buildGenerationConfig(model),
    ...(options.systemInstruction ? { system_instruction: { parts: [{ text: options.systemInstruction }] } } : {}),
  });

  let last = await requestGeminiWithRetry(apiKey, getTextModels(), buildPayload, timeoutMs);
  let { response: geminiResponse, model } = last;

  // 環境変数で古いモデルを選んだときなど、「指示」や「考える深さ」の渡し方に対応していないときは、
  // 指示を本文の先頭へ入れ、考える深さを外してもう一度試します。
  if (geminiResponse.status === 400) {
    console.error("設定を受け付けなかったため、指示を本文へ入れて試し直します。", await readLastErrorBody(last));
    const instructionParts = options.systemInstruction ? [{ text: options.systemInstruction }] : [];
    last = await requestGeminiWithRetry(apiKey, [model], (retryModel) => ({
      contents: [{ parts: [...instructionParts, ...parts] }],
      generationConfig: { maxOutputTokens: buildGenerationConfig(retryModel).maxOutputTokens },
    }), Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS));
    ({ response: geminiResponse, model } = last);
  }

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    console.error("Gemini APIがエラーを返しました。", geminiResponse.status, await readLastErrorBody(last));
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
  // Gemini 3.8 以降の音声モデルには、話し方の指示を speech_metadata として文章とは別に渡します。
  // 文章へ指示を混ぜると、指示まで読み上げてしまうことがあるためです。それより前のモデルには文章だけを渡します。
  let last = await requestGeminiWithRetry(apiKey, getTtsModels(), (model) => ({
    contents: [{ parts: [isNewGenerationModel(model) ? { text, speech_metadata: { style: TTS_STYLE } } : { text }] }],
    generationConfig,
  }), timeoutMs);
  let { response: geminiResponse, model } = last;

  // 話し方の指示を受け付けなかったときは、文章だけで作り直します。
  if (geminiResponse.status === 400 && isNewGenerationModel(model)) {
    console.error("speech_metadataを受け付けなかったため、文章だけで試し直します。", await readLastErrorBody(last));
    last = await requestGeminiWithRetry(apiKey, [model], () => ({
      contents: [{ parts: [{ text }] }],
      generationConfig,
    }), Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS));
    ({ response: geminiResponse, model } = last);
  }

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    const errorBody = await readLastErrorBody(last);
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
