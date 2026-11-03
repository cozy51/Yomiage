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

const { isAuthConfigured, isAuthenticated } = require("./_auth");
// Geminiの呼び出しとモデル名は、文章の処理（api/ai.js）と共通の処理を使います。
const { getGeminiModel, generateText, listAvailableModels } = require("./_gemini");
const { SUMMARIZE_INSTRUCTION, SUMMARIZE_DETAIL_INSTRUCTION } = require("./_prompts");

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
・画像の中で行の幅に合わせて折り返されているだけの改行は入れず、1つの段落は1行につなげて出力する
・改行は段落の区切り・見出し・箇条書きの項目の区切りにだけ入れる
・段組み（複数の列）の文章は、列ごとに上から順に読み進める
・句読点をできるだけ正しく認識する
・読み上げに不要な装飾記号は除去する
・本文として意味のある文章を優先する
・結果はプレーンテキストだけ返す
・Markdownを使用しない
・Markdownのコードブロックを使用しない
・前置きや解説を付けない

Webサイトやアプリのスクリーンショットの場合でも、本文として読める文章を優先して抽出してください。

ボタン名やナビゲーションなども、文章として必要な場合のみ抽出してください。`;

// 画像をそのまま要約するときの見出しです。読み取った文章と要約を、1回の返事で分けて受け取るために使います。
const TRANSCRIPT_HEADING = "【読み取り】";
const SUMMARY_HEADING = "【要約】";
const SUMMARY_ACTIONS = ["summarize", "summarize-detail"];

// 要約の指示から、守らせるルールの部分だけを取り出します（文章の要約と同じルールを使うためです）。
function readSummaryRules(instruction) {
  const marker = "必ず守ってください。";
  const index = instruction.indexOf(marker);
  return (index >= 0 ? instruction.slice(index + marker.length) : instruction).trim();
}

/**
 * 画像の文章を読み取り、続けて要約までを1回で行わせる指示です。
 * 無料OCRの崩れた文字を要約すると、読み取りの誤りがそのまま要約の誤りになるため、
 * 画像そのものを見て読み取らせます。先に本文を書き起こさせてから要約させることで、
 * 深く考えさせなくても（料金と時間を増やさずに）要約が画像の内容から外れにくくなります。
 */
function buildImageSummaryInstruction(action) {
  const isDetail = action === "summarize-detail";
  const summaryRules = readSummaryRules(isDetail ? SUMMARIZE_DETAIL_INSTRUCTION : SUMMARIZE_INSTRUCTION);

  return `あなたは画像の文章を読み取り、その内容を日本語で${isDetail ? "丁寧で詳しめに" : "簡潔に"}要約します。
次の形式で、2つの見出しをこの順番で1回ずつ書いて返してください。見出しの前後に前置きや解説は付けません。

${TRANSCRIPT_HEADING}
（画像の本文を書き起こした文章）
${SUMMARY_HEADING}
（書き起こした文章の要約）

${TRANSCRIPT_HEADING}は、次のルールで書き起こしてください。

${OCR_PROMPT}

${SUMMARY_HEADING}は、${TRANSCRIPT_HEADING}で書き起こした文章だけをもとに、次のルールで書いてください。

${summaryRules}
・画像から読み取れない内容を推測で補わない`;
}

// 返事を「読み取った文章」と「要約」に分けます。要約の見出しがないときは、要約を空にします。
function splitImageSummary(text) {
  const summaryIndex = text.lastIndexOf(SUMMARY_HEADING);
  const transcriptPart = summaryIndex >= 0 ? text.slice(0, summaryIndex) : text;
  const summary = summaryIndex >= 0 ? text.slice(summaryIndex + SUMMARY_HEADING.length).trim() : "";
  const transcriptIndex = transcriptPart.indexOf(TRANSCRIPT_HEADING);
  const transcript = (transcriptIndex >= 0
    ? transcriptPart.slice(transcriptIndex + TRANSCRIPT_HEADING.length)
    : transcriptPart).trim();
  return { transcript, summary };
}

// 見た目の違い（空白や改行、全角と半角）を無視して、中身が同じかどうかを調べます。
function isSameText(left, right) {
  const normalize = (value) => value.replace(/\s+/g, "").normalize("NFKC");
  return normalize(left) === normalize(right);
}

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
  notConfigured: "AI OCRを利用できません。パスワードの設定を確認してください。",
  needPassword: "AI OCRを利用するには、パスワードの入力が必要です。",
};

// Gemini側のエラーを、利用者への案内へ振り分けます。
function describeGeminiError(status) {
  if (status === 400 || status === 401 || status === 403) return MESSAGES.invalidKey;
  if (status === 404) return MESSAGES.invalidModel;
  if (status === 429 || status === 503) return MESSAGES.busy;
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

  // 要約を選んでいるときは、読み取りと要約を1回の呼び出しでまとめて行います。
  const action = SUMMARY_ACTIONS.includes(body?.action) ? body.action : "";

  try {
    if (action) {
      const { text, model, modelVersion } = await generateText(apiKey, [
        { inline_data: { mime_type: mimeType, data: image } },
        { text: `この画像の文章を読み取り、日本語で${action === "summarize-detail" ? "詳しめに" : ""}要約してください。` },
      ], {
        systemInstruction: buildImageSummaryInstruction(action),
        // 詳細要約は、文章の要約（api/ai.js）と同じく少し深く考えさせます。
        thinkingLevel: action === "summarize-detail" ? "medium" : "low",
        priority: body?.modelPriority,
      });

      const { transcript, summary } = splitImageSummary(text || "");
      if (!transcript) {
        return response.status(502).json({ message: MESSAGES.empty, code: "AI-EMPTY" });
      }

      // 要約を受け取れなかったときは、読み取った文章だけを返します（画面側で、文章の要約をやり直します）。
      // unchangedは、要約が読み取った文章と変わらなかったことを画面へ伝えるための印です。
      return response.status(200).json({
        text: transcript,
        summary,
        unchanged: Boolean(summary) && isSameText(summary, transcript),
        model,
        modelVersion,
      });
    }

    const { text, model, modelVersion } = await generateText(apiKey, [
      { text: OCR_PROMPT },
      { inline_data: { mime_type: mimeType, data: image } },
    ], { priority: body?.modelPriority });

    if (!text) {
      return response.status(502).json({ message: MESSAGES.empty, code: "AI-EMPTY" });
    }

    // 読み取った文章と、使ったモデル名（とその版）だけを返します。利用状況などの余分な情報は返しません。
    return response.status(200).json({ text, model, modelVersion });
  } catch (error) {
    const status = error?.geminiStatus;

    // モデル名が原因のときは、使えるモデル名をそのまま案内します。
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
      return response.status(502).json({ message: describeGeminiError(status), code: `AI-G${status}` });
    }

    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Gemini APIの呼び出しに失敗しました。", error?.name || error);
    return response.status(isTimeout ? 504 : 502).json({
      message: isTimeout ? MESSAGES.timeout : MESSAGES.failed,
      code: isTimeout ? "AI-TIMEOUT" : "AI-NET",
    });
  }
};
