"use strict";

/**
 * 文章をAIの音声で読み上げる（音声データを作る）ためのVercel側の処理です。
 *
 * Gemini APIのキーはブラウザへ渡してはいけないため、この関数の中だけで使います。
 * 画像の読み取り（api/ocr.js）や文章の処理（api/ai.js）と同じく、
 * 料金がかかるためパスワードで認証した人だけが使えます。
 *
 * 文章と音声は処理のあいだだけ扱い、サーバーには保存しません。
 * 返すのはヘッダーの付いていない生の音声データ（PCM）で、
 * 再生・保存できる形（WAV）へ組み立てるのはブラウザ側です。
 */

const { isAuthConfigured, isAuthenticated, checkRateLimit, getClientKey } = require("./_auth");
const { generateSpeech, listAvailableModels, getGeminiTtsModel } = require("./_gemini");

// 呼び出しすぎを防ぐための上限です（少人数での利用を想定しています）。
// 長い文章は短く区切って何回も呼ぶため、文章の処理（api/ai.js）より多めにしています。
const TTS_REQUEST_LIMIT = 60;
const TTS_WINDOW_MS = 10 * 60 * 1000;
// 1回で渡せる文章の長さです。長すぎるとVercelの制限時間（60秒）内に終わりません。
// 画面側（script.js の AI_TTS_CHUNK_LENGTH）は、これより短く区切って送ります。
const MAX_TEXT_LENGTH = 300;

// 使える音声です。増やすときは、画面側（script.js の AI_VOICES）と合わせてください。
const ALLOWED_VOICES = ["Kore", "Puck", "Charon", "Aoede", "Leda", "Achird", "Vindemiatrix", "Sulafat"];
const DEFAULT_VOICE = "Kore";

const MESSAGES = {
  methodNotAllowed: "この操作は利用できません。",
  notConfigured: "AI音声を利用できません。パスワードの設定を確認してください。",
  needPassword: "AI音声を利用するには、パスワードの入力が必要です。",
  tooManyRequests: "AI音声の利用が続いています。しばらくしてから再度お試しください。",
  unavailable: "AI音声を利用できません。しばらくしてから再度お試しください。",
  invalidRequest: "文章を受け取れませんでした。もう一度お試しください。",
  invalidVoice: "その音声には対応していません。",
  tooLong: "文章が長すぎます。短く分けてお試しください。",
  invalidKey: "AI音声を利用できません。APIキーの設定を確認してください。",
  invalidModel: "AI音声のモデルを利用できません。モデル名の設定を確認してください。",
  busy: "AI音声が混み合っています（Geminiの利用上限）。少し待つと続きを作れます。",
  timeout: "AI音声の生成が時間内に終わりませんでした。短い文章でお試しください。",
  failed: "AI音声の生成に失敗しました。しばらくしてから再度お試しください。",
  empty: "AIが音声を返しませんでした。もう一度お試しください。",
};

function parseRequestBody(body) {
  if (!body) return null;
  if (typeof body !== "string") return body;

  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

module.exports = async function handler(request, response) {
  // 乱用を防ぐため、POST以外は受け付けません。
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ message: MESSAGES.methodNotAllowed, code: "TTS-405" });
  }

  // パスワードが未設定のときは、誰でも使える状態にしないため受け付けません。
  if (!isAuthConfigured()) {
    console.error("APP_PASSWORD_HASHが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.notConfigured, code: "TTS-NOAUTH" });
  }

  // 料金がかかる処理のため、パスワードで認証した人だけが使えるようにします。
  if (!isAuthenticated(request)) {
    return response.status(401).json({ message: MESSAGES.needPassword, code: "TTS-401" });
  }

  if (!checkRateLimit(`tts:${getClientKey(request)}`, TTS_REQUEST_LIMIT, TTS_WINDOW_MS)) {
    return response.status(429).json({ message: MESSAGES.tooManyRequests, code: "TTS-429" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEYが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.unavailable, code: "TTS-NOKEY" });
  }

  const body = parseRequestBody(request.body);
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return response.status(400).json({ message: MESSAGES.invalidRequest, code: "TTS-BADREQ" });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return response.status(413).json({ message: MESSAGES.tooLong, code: "TTS-LONG" });
  }

  const voice = typeof body?.voice === "string" && body.voice ? body.voice : DEFAULT_VOICE;
  if (!ALLOWED_VOICES.includes(voice)) {
    return response.status(400).json({ message: MESSAGES.invalidVoice, code: "TTS-VOICE" });
  }

  try {
    const speech = await generateSpeech(apiKey, text, voice);

    if (!speech?.audio) {
      return response.status(502).json({ message: MESSAGES.empty, code: "TTS-EMPTY" });
    }

    // 音声データと、その形式（例: audio/L16;codec=pcm;rate=24000）だけを返します。
    return response.status(200).json({ audio: speech.audio, mimeType: speech.mimeType });
  } catch (error) {
    const status = error?.geminiStatus;

    if (status === 404) {
      const availableModels = await listAvailableModels(apiKey, { tts: true });
      console.error("使用した音声モデル名:", getGeminiTtsModel(), "/ 利用できる音声モデル:", availableModels.join(", ") || "（取得できませんでした）");
      const hint = availableModels.length
        ? `利用できる音声モデルの例: ${availableModels.slice(0, 8).join(" / ")}`
        : "";
      return response.status(502).json({
        message: hint ? `${MESSAGES.invalidModel} ${hint}` : MESSAGES.invalidModel,
        code: "TTS-G404",
      });
    }

    if (status === 429) {
      // どれくらい待てばよいかをブラウザへ伝えて、自動でやり直せるようにします。
      return response.status(502).json({
        message: MESSAGES.busy,
        code: "TTS-G429",
        retryAfterMs: error?.retryAfterMs || 0,
      });
    }

    if (status) {
      const message = status === 400 || status === 401 || status === 403
        ? MESSAGES.invalidKey
        : MESSAGES.failed;
      return response.status(502).json({ message, code: `TTS-G${status}` });
    }

    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Gemini TTS APIの呼び出しに失敗しました。", error?.name || error);
    return response.status(isTimeout ? 504 : 502).json({
      message: isTimeout ? MESSAGES.timeout : MESSAGES.failed,
      code: isTimeout ? "TTS-TIMEOUT" : "TTS-NET",
    });
  }
};
