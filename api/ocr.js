"use strict";

/**
 * 画像から文字を読み取る（AIで高精度OCR）ためのVercel側の処理です。
 *
 * Gemini APIのキーはブラウザへ渡してはいけないため、この関数の中だけで使います。
 * ブラウザから直接Gemini APIを呼ぶと、APIキーが画面の裏側を見た誰にでも読み取られ、
 * 他人に使われて料金が発生します。そのため、
 * ブラウザ → この関数 → Gemini API → この関数 → ブラウザ
 * という経路にして、APIキーはVercelの環境変数（GEMINI_API_KEY）からだけ読み込みます。
 *
 * 画像は読み取りのあいだだけ扱い、サーバーには保存しません。
 */

// 使用するGeminiのモデル名です。変更するときは、この1か所だけを書き換えてください。
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 25000;

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// Geminiへ渡す読み取りの指示です。要約や補完をさせず、本文だけを返させます。
const OCR_PROMPT = `この画像に表示されている文章を文字として抽出してください。

以下のルールを守ってください。

・文章の内容を要約しない
・説明を追加しない
・画像に存在しない文章を補完しない
・読み取れない文字を勝手に推測しすぎない
・原文の意味を変更しない
・日本語の文章順序をできるだけ維持する
・段落をできるだけ維持する
・改行を自然に維持する
・句読点をできるだけ正しく認識する
・読み上げに不要な装飾記号は除去する
・本文として意味のある文章を優先する
・結果はプレーンテキストだけ返す
・Markdownを使用しない
・Markdownのコードブロックを使用しない
・前置きや解説を付けない

Webサイトやアプリのスクリーンショットの場合でも、本文として読める文章を優先して抽出してください。

ボタン名やナビゲーションなども、文章として必要な場合のみ抽出してください。`;

// 利用者へ返す案内です。APIキーや内部の詳しい情報は、ここへ含めません。
// codeは、うまくいかないときにどこで止まったかを見分けるための短い印です（秘密の情報は含みません）。
const MESSAGES = {
  methodNotAllowed: "この操作は利用できません。",
  invalidRequest: "画像を受け取れませんでした。もう一度コピーしてからお試しください。",
  unsupportedType: "この画像の形式には対応していません。PNGまたはJPEGの画像でお試しください。",
  tooLarge: "画像が大きすぎます。",
  unavailable: "AI OCRを利用できません。しばらくしてから再度お試しください。",
  invalidKey: "AI OCRを利用できません。APIキーの設定を確認してください。",
  invalidModel: "AI OCRのモデルを利用できません。モデル名の設定を確認してください。",
  busy: "AI OCRの利用が混み合っています。しばらくしてから再度お試しください。",
  timeout: "AI OCRが時間内に終わりませんでした。通常OCRをお試しください。",
  failed: "AI OCRに失敗しました。通常OCRをお試しください。",
  empty: "AIが文字を読み取れませんでした。通常OCRをお試しください。",
};

// Gemini側の説明をログへ残すために読み取ります。読み取れない場合は空にします。
async function readErrorBody(geminiResponse) {
  try {
    return (await geminiResponse.text()).slice(0, 500);
  } catch (error) {
    return "";
  }
}

// Gemini側のエラーを、利用者への案内へ振り分けます。
function describeGeminiError(status) {
  if (status === 400 || status === 401 || status === 403) return MESSAGES.invalidKey;
  if (status === 404) return MESSAGES.invalidModel;
  if (status === 429) return MESSAGES.busy;
  return MESSAGES.failed;
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

// Base64は元の画像より約33%大きくなるため、その分を戻して実際の画像の大きさを求めます。
function estimateImageBytes(base64Image) {
  const padding = base64Image.endsWith("==") ? 2 : base64Image.endsWith("=") ? 1 : 0;
  return Math.floor((base64Image.length * 3) / 4) - padding;
}

// 指示に反してMarkdownのコードブロックが返ってきた場合に備えて、その記号だけ取り除きます。
function removeCodeFence(text) {
  return text
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

module.exports = async function handler(request, response) {
  // 乱用を防ぐため、POST以外は受け付けません。
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ message: MESSAGES.methodNotAllowed, code: "AI-405" });
  }

  // APIキーが未設定でも、アプリ全体は動き続けます（通常OCRはブラウザの中だけで動きます）。
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEYが設定されていません。Vercelの環境変数を確認してください。");
    return response.status(503).json({ message: MESSAGES.unavailable, code: "AI-NOKEY" });
  }

  const body = parseRequestBody(request.body);
  const image = typeof body?.image === "string" ? body.image.trim() : "";
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType.toLowerCase() : "";

  if (!image || !BASE64_PATTERN.test(image)) {
    return response.status(400).json({ message: MESSAGES.invalidRequest, code: "AI-BADREQ" });
  }

  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return response.status(415).json({ message: MESSAGES.unsupportedType, code: "AI-TYPE" });
  }

  if (estimateImageBytes(image) > MAX_IMAGE_BYTES) {
    return response.status(413).json({ message: MESSAGES.tooLarge, code: "AI-SIZE" });
  }

  try {
    const geminiResponse = await fetch(GEMINI_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: mimeType, data: image } },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });

    if (!geminiResponse.ok) {
      // 原因を追えるよう、Gemini側の説明もVercelのログへ残します（APIキーは含みません）。
      console.error("Gemini APIがエラーを返しました。", geminiResponse.status, await readErrorBody(geminiResponse));
      return response.status(502).json({
        message: describeGeminiError(geminiResponse.status),
        code: `AI-G${geminiResponse.status}`,
      });
    }

    const result = await geminiResponse.json();
    const parts = result?.candidates?.[0]?.content?.parts || [];
    const text = removeCodeFence(parts.map((part) => part?.text || "").join(""));

    if (!text) {
      console.error("Geminiが文章を返しませんでした。", JSON.stringify(result?.candidates?.[0]?.finishReason || result?.promptFeedback || {}));
      return response.status(502).json({ message: MESSAGES.empty, code: "AI-EMPTY" });
    }

    // 読み取った文章だけを返します。利用状況などの余分な情報は返しません。
    return response.status(200).json({ text });
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Gemini APIの呼び出しに失敗しました。", error?.name || error);
    return response.status(isTimeout ? 504 : 502).json({
      message: isTimeout ? MESSAGES.timeout : MESSAGES.failed,
      code: isTimeout ? "AI-TIMEOUT" : "AI-NET",
    });
  }
};
