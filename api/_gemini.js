"use strict";

/**
 * Gemini APIを呼び出すための共通処理です。
 *
 * APIキーはVercelの環境変数（GEMINI_API_KEY）からサーバー側だけで読み込み、
 * ブラウザへは一切渡しません。画像の読み取りと文章の処理で、同じ入口を使います。
 *
 * ファイル名が「_」で始まるものは、Vercelでは公開されるAPIになりません（共通処理用）。
 */

// 使用するGeminiの「廉価モデル」です（画像の読み取りと文章の処理で共通です）。
// 「-latest」はGoogleが用意している別名で、常にその時点の最新版を指します。
// 新しいモデルが出ても、古いモデルが使えなくなっても、ここを書き換える必要はありません。
// Vercelの環境変数 GEMINI_MODEL を設定した場合は、そちらが優先されます。
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
// 品質の高い「通常モデル」です。画面で「通常モデル優先」を選んだときに最初に使い、
// 「廉価モデル優先」のときは、廉価モデルが混み合っている・利用上限に達した（429・503など）ときの代わりに使います。
// 利用上限はモデルごとに別々のため、別のモデルに切り替えると続けて使えることが多くなります。
const STANDARD_GEMINI_MODEL = "gemini-flash-latest";
// 音声を作るモデルには「-latest」の別名がないため、そのAPIキーで使えるモデルの一覧から最新のものを自動で選びます。
// 下の2つは、一覧を取得できなかったときにだけ使う予備の名前です。
// 環境変数 GEMINI_TTS_MODEL を設定した場合は、廉価モデル優先で最初に使う音声モデルとして、そちらが優先されます。
const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const STANDARD_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
// 音声モデルの一覧を覚えておく時間です。古いモデルが使えなくなったときは、この時間を待たずに取り直します。
const TTS_MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
// 一覧を取得できなかったときは、少し間をあけてから取り直します。
const TTS_MODEL_RETRY_MS = 5 * 60 * 1000;
// 画面で選べる「どちらのモデルを先に使うか」です。economy = 廉価モデル優先（既定）、standard = 通常モデル優先。
const MODEL_PRIORITIES = ["economy", "standard"];
const DEFAULT_MODEL_PRIORITY = "economy";
// Gemini 3.8 以降のモデルです。temperature が使えず、考える深さ（thinkingLevel）や話し方の指示を使います。
// 「-latest」のように名前から世代が分からないモデルは、新しい世代として扱い、受け付けなければ別の渡し方で試します。
const NEW_GENERATION_MODEL_PATTERN = /^gemini-(3\.[89]|[4-9])/;
const VERSIONED_MODEL_PATTERN = /^gemini-\d/;
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

// 画面から届いた値を、使える優先順位に直します。分からない値のときは既定（廉価モデル優先）にします。
function normalizeModelPriority(priority) {
  return MODEL_PRIORITIES.includes(priority) ? priority : DEFAULT_MODEL_PRIORITY;
}

// 使うモデルの順番です。最初に使うモデルのあとに、代わりのモデルを並べます。
// 廉価モデルは環境変数（GEMINI_MODEL / GEMINI_TTS_MODEL）で差し替えられます。
function getTextModels(priority) {
  const models = [getGeminiModel(), STANDARD_GEMINI_MODEL];
  if (normalizeModelPriority(priority) === "standard") models.reverse();
  return [...new Set(models)];
}

// 音声モデルの一覧から選んだ結果です（Vercelの同じ実行環境が使われているあいだ覚えておきます）。
let ttsModelCache = null;

// 音声モデルの名前から、世代（3.8 など）と種類（flash-lite / flash / pro）を読み取ります。
function parseTtsModel(name) {
  const matched = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)-.*tts/.exec(name);
  if (!matched) return null;
  return {
    name,
    major: Number(matched[1]),
    minor: Number(matched[2] || 0),
    tier: matched[3],
    preview: /preview|exp/.test(name),
  };
}

// 新しい世代を先に、同じ世代なら正式版（previewでないもの）を先に並べます。
function compareTtsModels(a, b) {
  return (b.major - a.major) || (b.minor - a.minor)
    || (Number(a.preview) - Number(b.preview)) || b.name.localeCompare(a.name);
}

/**
 * 使える音声モデルの一覧から、通常モデルと廉価モデルを選びます。
 * - 通常モデル：最新のflash
 * - 廉価モデル：flash-liteの音声モデルがあれば、その最新。なければ、通常モデルより1つ前の世代のflash
 *   （前の世代のほうが料金が安く、利用上限も別々のためです）。どちらもなければ通常モデルと同じにします。
 * pro は料金が高いため選びません。
 */
function pickTtsModels(names) {
  const models = names.map(parseTtsModel).filter(Boolean).sort(compareTtsModels);
  const flash = models.filter((model) => model.tier === "flash");
  const lite = models.filter((model) => model.tier === "flash-lite");
  const standard = flash[0] || lite[0];
  if (!standard) return null;

  const olderFlash = flash.find((model) => model.major < standard.major
    || (model.major === standard.major && model.minor < standard.minor));
  const economy = lite[0] || olderFlash || standard;
  return { economy: economy.name, standard: standard.name };
}

/**
 * 音声モデルを選び直します。一覧を取得できなかったときは、予備の名前を使います。
 * options.refresh を付けると、覚えている結果を使わずに取り直します（古いモデルが使えなくなったときなど）。
 */
async function resolveTtsModels(apiKey, options = {}) {
  const now = Date.now();
  if (!options.refresh && ttsModelCache && ttsModelCache.expiresAt > now) return ttsModelCache.models;

  const picked = apiKey ? pickTtsModels(await listAvailableModels(apiKey, { tts: true })) : null;
  if (picked) {
    ttsModelCache = { models: picked, expiresAt: now + TTS_MODEL_CACHE_MS };
    return picked;
  }

  // 取得できなかったときは、前に選んだ結果があればそれを、なければ予備の名前を使います。
  const models = ttsModelCache?.models || { economy: DEFAULT_GEMINI_TTS_MODEL, standard: STANDARD_GEMINI_TTS_MODEL };
  ttsModelCache = { models, expiresAt: now + TTS_MODEL_RETRY_MS };
  return models;
}

async function getTtsModels(apiKey, priority, options = {}) {
  const resolved = await resolveTtsModels(apiKey, options);
  const envModel = (process.env.GEMINI_TTS_MODEL || "").trim();
  const economy = GEMINI_MODEL_PATTERN.test(envModel) ? envModel : resolved.economy;
  const models = [economy, resolved.standard];
  if (normalizeModelPriority(priority) === "standard") models.reverse();
  return [...new Set(models)];
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
    const modelsResponse = await fetch(`${GEMINI_API_BASE}/models?pageSize=1000`, {
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

// 名前から世代が分からないモデル（「-latest」など）は、新しい世代として扱います。
function isNewGenerationModel(model) {
  return NEW_GENERATION_MODEL_PATTERN.test(model) || !VERSIONED_MODEL_PATTERN.test(model);
}

// 文章を作るときの設定の渡し方です。モデルの世代によって、受け付ける渡し方が違います。
// - thinking：Gemini 3.8 以降向け。temperature は使えないため、考える深さ（thinkingLevel）を指定します
// - temperature：それより前のモデル向け。temperature 0 で、毎回同じように忠実に答えさせます
// - plain：どちらも受け付けないときの最後の手段。指示を本文の先頭へ入れ、細かい設定を外します
const TEXT_PAYLOAD_STYLES = ["thinking", "temperature", "plain"];
// モデルごとに、受け付けられた渡し方を覚えておきます。
// 「-latest」の中身が新しい世代に切り替わって受け付けなくなったときは、ほかの渡し方を順に試し直します。
const acceptedTextPayloadStyles = new Map();

function getTextPayloadStyles(model) {
  const remembered = acceptedTextPayloadStyles.get(model);
  const preferred = remembered || (isNewGenerationModel(model) ? "thinking" : "temperature");
  return [preferred, ...TEXT_PAYLOAD_STYLES.filter((style) => style !== preferred)];
}

// 返事に書かれている、実際に使われたモデルの版です（「-latest」がどの版を指していたかが分かります）。
function readModelVersion(result) {
  const version = String(result?.modelVersion || "").replace(/^models\//, "");
  return GEMINI_MODEL_PATTERN.test(version) ? version : "";
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
  const instruction = options.systemInstruction ? { system_instruction: { parts: [{ text: options.systemInstruction }] } } : {};
  const instructionParts = options.systemInstruction ? [{ text: options.systemInstruction }] : [];
  const buildPayload = (style) => {
    if (style === "thinking") {
      // 考えた分も含めて、出力の上限を多めにします。
      return {
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: options.maxOutputTokens || 16384,
          thinkingConfig: { thinkingLevel: options.thinkingLevel || DEFAULT_THINKING_LEVEL },
        },
        ...instruction,
      };
    }
    if (style === "temperature") {
      return {
        contents: [{ parts }],
        generationConfig: { temperature: 0, maxOutputTokens: options.maxOutputTokens || 8192 },
        ...instruction,
      };
    }
    return {
      contents: [{ parts: [...instructionParts, ...parts] }],
      generationConfig: { maxOutputTokens: options.maxOutputTokens || 16384 },
    };
  };

  let last = await requestGeminiWithRetry(apiKey, getTextModels(options.priority),
    (model) => buildPayload(getTextPayloadStyles(model)[0]), timeoutMs);
  let { response: geminiResponse, model } = last;
  const styles = getTextPayloadStyles(model);
  let style = styles.shift();

  // 設定の渡し方を受け付けなかったとき（400）は、ほかの渡し方で順に試し直します。
  while (geminiResponse.status === 400 && styles.length) {
    const nextStyle = styles.shift();
    console.error(`設定（${style}）を受け付けなかったため、別の渡し方（${nextStyle}）で試し直します。`, model, await readLastErrorBody(last));
    style = nextStyle;
    last = await requestGeminiWithRetry(apiKey, [model], () => buildPayload(style),
      Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS));
    ({ response: geminiResponse, model } = last);
  }

  if (geminiResponse.ok) acceptedTextPayloadStyles.set(model, style);

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

  // どのモデルで作ったかも返します（混み合っていて代わりのモデルを使ったことが、画面で分かるようにするためです）。
  // modelVersion は、「-latest」が実際に指していた版です。
  return { text, model, modelVersion: readModelVersion(result) };
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
  const buildPayload = (model) => ({
    contents: [{ parts: [isNewGenerationModel(model) ? { text, speech_metadata: { style: TTS_STYLE } } : { text }] }],
    generationConfig,
  });
  const remainingMs = () => Math.max(timeoutMs - (Date.now() - startedAt), MIN_ATTEMPT_MS);
  let models = await getTtsModels(apiKey, options.priority);
  let last = await requestGeminiWithRetry(apiKey, models, buildPayload, remainingMs());
  let { response: geminiResponse, model } = last;

  // モデルが見つからないとき（404）は、古いモデルが使えなくなった可能性があるため、
  // 使えるモデルの一覧を取り直し、選び直したモデルでもう一度試します。
  if (geminiResponse.status === 404) {
    const refreshed = await getTtsModels(apiKey, options.priority, { refresh: true });
    if (refreshed.join() !== models.join()) {
      console.error("音声モデルが見つからなかったため、選び直して試します。", model, "→", refreshed.join(", "));
      models = refreshed;
      last = await requestGeminiWithRetry(apiKey, models, buildPayload, remainingMs());
      ({ response: geminiResponse, model } = last);
    }
  }

  // 話し方の指示を受け付けなかったときは、文章だけで作り直します。
  if (geminiResponse.status === 400 && isNewGenerationModel(model)) {
    console.error("speech_metadataを受け付けなかったため、文章だけで試し直します。", await readLastErrorBody(last));
    last = await requestGeminiWithRetry(apiKey, [model], () => ({
      contents: [{ parts: [{ text }] }],
      generationConfig,
    }), remainingMs());
    ({ response: geminiResponse, model } = last);
  }

  if (!geminiResponse.ok) {
    // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
    const errorBody = await readLastErrorBody(last);
    console.error("Gemini TTS APIがエラーを返しました。", geminiResponse.status, errorBody);
    const error = new Error(`Gemini responded with ${geminiResponse.status}`);
    error.geminiStatus = geminiResponse.status;
    error.geminiModel = model;
    error.geminiModels = models;
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

  return { audio: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType, model, modelVersion: readModelVersion(result) };
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  GEMINI_TIMEOUT_MS,
  GEMINI_TTS_TIMEOUT_MS,
  getGeminiModel,
  resolveTtsModels,
  getTextModels,
  getTtsModels,
  normalizeModelPriority,
  readRetryAfterMs,
  generateText,
  generateSpeech,
  listAvailableModels,
  removeCodeFence,
};
