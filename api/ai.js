"use strict";

/**
 * 文章をAIで処理する（翻訳・要約）ためのVercel側の処理です。
 *
 * Gemini APIのキーはブラウザへ渡してはいけないため、この関数の中だけで使います。
 * 画像の読み取り（api/ocr.js）と同じく、料金がかかるためパスワードで認証した人だけが使えます。
 *
 * 文章は処理のあいだだけ扱い、サーバーには保存しません。
 */

const { isAuthConfigured, isAuthenticated, checkRateLimit, getClientKey } = require("./_auth");
// Geminiの呼び出しとモデル名は、画像の読み取り（api/ocr.js）と共通の処理を使います。
const { generateText, listAvailableModels, getGeminiModel } = require("./_gemini");

// 呼び出しすぎを防ぐための上限です（少人数での利用を想定しています）。
const AI_REQUEST_LIMIT = 30;
const AI_WINDOW_MS = 10 * 60 * 1000;
const MAX_TEXT_LENGTH = 20000;
// Vercelの上限（30秒）内に収めるため、やり直しは残り時間がこれだけあるときだけ行います。
const AI_TOTAL_BUDGET_MS = 26000;
const AI_RETRY_MIN_MS = 6000;

// 翻訳できる言語です。増やすときは、この1か所へ追加してください。
const TARGET_LANGUAGES = {
  ja: "日本語",
  en: "英語",
  zh: "中国語（簡体字）",
  ko: "韓国語",
};

const MESSAGES = {
  methodNotAllowed: "この操作は利用できません。",
  notConfigured: "AIの機能を利用できません。パスワードの設定を確認してください。",
  needPassword: "AIの機能を利用するには、パスワードの入力が必要です。",
  tooManyRequests: "AIの利用が続いています。しばらくしてから再度お試しください。",
  unavailable: "AIの機能を利用できません。しばらくしてから再度お試しください。",
  invalidRequest: "文章を受け取れませんでした。もう一度お試しください。",
  invalidLanguage: "その言語には対応していません。",
  tooLong: "文章が長すぎます。短く分けてお試しください。",
  invalidKey: "AIの機能を利用できません。APIキーの設定を確認してください。",
  invalidModel: "AIのモデルを利用できません。モデル名の設定を確認してください。",
  busy: "AIの利用が混み合っています。しばらくしてから再度お試しください。",
  timeout: "AIの処理が時間内に終わりませんでした。短い文章でお試しください。",
  failed: "AIの処理に失敗しました。しばらくしてから再度お試しください。",
  empty: "AIが文章を返しませんでした。もう一度お試しください。",
};

// 翻訳の指示です。本文とは別の「指示」としてGeminiへ渡します。
// 入力の言語はGemini側で判断させ、訳文だけを返させます。
function buildTranslateInstruction(languageName) {
  return `あなたは翻訳者です。受け取った文章を${languageName}へ翻訳して返します。

必ず守ってください。

・入力された文章の言語は自動で判断する
・文章全体を${languageName}にする。ほかの言語が混ざっていても、すべて${languageName}へ訳す
・すでに${languageName}で書かれている部分は、その表現のまま残す
・翻訳した文章だけを返す。原文・前置き・解説・注釈は付けない
・原文にない情報を足さない、原文の意味を変えない
・段落と改行はできるだけそのまま保つ
・読み上げに使うため、Markdownや装飾記号は使わない
・画像から読み取った文章のため、記号の混ざりや崩れた単語が含まれることがある。その場合も、意味の通る${languageName}の文章にする
・原文をそのまま書き写して返してはいけない`;
}

// 要約の指示です。入力の言語を問わず、日本語の要約を返させます。
const SUMMARIZE_INSTRUCTION = `あなたは要約者です。受け取った文章を日本語で簡潔に要約して返します。

必ず守ってください。

・入力された文章の言語は自動で判断する
・入力が日本語以外でも、要約は日本語で書く
・要約した文章だけを返す。原文・前置き・解説・注釈は付けない
・元の文章にない情報を足さない
・大事な要点は落とさない
・元の文章より必ず短くする
・読み上げに使うため、Markdownや箇条書きの記号は使わず、文章の形で書く
・人の名前は呼び捨てにしない。日本語の人名には「さん」を付ける（例: 大坪さん）。原文に「様」「さん」「先生」「部長」などの敬称や役職があればそれを使う
・原文をそのまま書き写して返してはいけない`;

// 処理する文章です。指示と区切って渡し、どこからが文章かを分かるようにします。
function buildUserText(action, languageName, text) {
  const request = action === "translate"
    ? `次の文章を${languageName}へ翻訳してください。`
    : "次の文章を日本語で要約してください。";
  return `${request}

--- ここから文章 ---
${text}
--- ここまで ---`;
}

// 見た目の違い（空白や改行、全角と半角）を無視して、中身が同じかどうかを調べます。
function isSameText(left, right) {
  const normalize = (value) => value.replace(/\s+/g, "").normalize("NFKC");
  return normalize(left) === normalize(right);
}

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
    return response.status(405).json({ message: MESSAGES.methodNotAllowed, code: "AI-405" });
  }

  // パスワードが未設定のときは、誰でも使える状態にしないため受け付けません。
  if (!isAuthConfigured()) {
    console.error("APP_PASSWORD_HASHが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.notConfigured, code: "AI-NOAUTH" });
  }

  // 料金がかかる処理のため、パスワードで認証した人だけが使えるようにします。
  if (!isAuthenticated(request)) {
    return response.status(401).json({ message: MESSAGES.needPassword, code: "AI-401" });
  }

  if (!checkRateLimit(`ai:${getClientKey(request)}`, AI_REQUEST_LIMIT, AI_WINDOW_MS)) {
    return response.status(429).json({ message: MESSAGES.tooManyRequests, code: "AI-429" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEYが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.unavailable, code: "AI-NOKEY" });
  }

  const body = parseRequestBody(request.body);
  const action = typeof body?.action === "string" ? body.action : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text || (action !== "translate" && action !== "summarize")) {
    return response.status(400).json({ message: MESSAGES.invalidRequest, code: "AI-BADREQ" });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return response.status(413).json({ message: MESSAGES.tooLong, code: "AI-LONG" });
  }

  let languageName = "";
  if (action === "translate") {
    const targetLanguage = typeof body?.targetLanguage === "string" ? body.targetLanguage : "ja";
    languageName = TARGET_LANGUAGES[targetLanguage];
    if (!languageName) {
      return response.status(400).json({ message: MESSAGES.invalidLanguage, code: "AI-LANG" });
    }
  }

  const instruction = action === "translate" ? buildTranslateInstruction(languageName) : SUMMARIZE_INSTRUCTION;
  const userText = buildUserText(action, languageName, text);

  const startedAt = Date.now();

  try {
    let result = await generateText(apiKey, [{ text: userText }], { systemInstruction: instruction });

    if (!result) {
      return response.status(502).json({ message: MESSAGES.empty, code: "AI-EMPTY" });
    }

    // 原文がそのまま返ってきたときは、処理されていないため、強く念を押してもう一度だけ試します。
    let unchanged = isSameText(result, text);
    const remainingMs = AI_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (unchanged && remainingMs >= AI_RETRY_MIN_MS) {
      console.error("原文がそのまま返ってきたため、もう一度試します。", action);
      const retryInstruction = `${instruction}

・前回はあなたが原文をそのまま返してしまいました。今度は必ず${action === "translate" ? `${languageName}へ翻訳した` : "日本語で要約した"}文章を返してください`;
      const retryResult = await generateText(apiKey, [{ text: userText }], {
        systemInstruction: retryInstruction,
        // 同じ答えを繰り返さないよう、少しだけ揺らぎを持たせます。
        temperature: 0.3,
        timeoutMs: remainingMs,
      });

      if (retryResult && !isSameText(retryResult, text)) {
        result = retryResult;
        unchanged = false;
      }
    }

    // 処理した文章だけを返します。余分な情報は返しません。
    // unchangedは、原文と中身が変わらなかったことを画面へ伝えるための印です。
    return response.status(200).json({ text: result, unchanged });
  } catch (error) {
    const status = error?.geminiStatus;

    if (status === 404) {
      const availableModels = await listAvailableModels(apiKey);
      console.error("使用したモデル名:", getGeminiModel(), "/ 利用できるモデル:", availableModels.join(", ") || "（取得できませんでした）");
      const hint = availableModels.length
        ? `利用できるモデルの例: ${availableModels.slice(0, 8).join(" / ")}`
        : "";
      return response.status(502).json({
        message: hint ? `${MESSAGES.invalidModel} ${hint}` : MESSAGES.invalidModel,
        code: "AI-G404",
      });
    }

    if (status) {
      const message = status === 400 || status === 401 || status === 403
        ? MESSAGES.invalidKey
        : status === 429
          ? MESSAGES.busy
          : MESSAGES.failed;
      return response.status(502).json({ message, code: `AI-G${status}` });
    }

    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Gemini APIの呼び出しに失敗しました。", error?.name || error);
    return response.status(isTimeout ? 504 : 502).json({
      message: isTimeout ? MESSAGES.timeout : MESSAGES.failed,
      code: isTimeout ? "AI-TIMEOUT" : "AI-NET",
    });
  }
};
