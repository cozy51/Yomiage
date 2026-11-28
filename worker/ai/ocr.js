/**
 * 画像から文字を読み取る（高精度OCR）処理と、画像を読み取って要約までを1回で行う処理です。
 * 画像を読めるモデルの選び方は Auto Router（cloudflare/auto）に任せます。画像はどこにも保存しません。
 */

import { generateText, imagePart } from "./text.js";
import { OCR_PROMPT } from "./prompts.js";
import { getSummaryInstruction } from "./summarize.js";

// 画像をそのまま要約するときの見出しです。読み取った文章と要約を、1回の返事で分けて受け取るために使います。
const TRANSCRIPT_HEADING = "【読み取り】";
const SUMMARY_HEADING = "【要約】";

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
 * 要約が画像の内容から外れにくくなります。
 */
export function buildImageSummaryInstruction(detail) {
  const summaryRules = readSummaryRules(getSummaryInstruction(detail ? "summarize-detail" : "summarize"));

  return `あなたは画像の文章を読み取り、その内容を日本語で${detail ? "丁寧で詳しめに" : "簡潔に"}要約します。
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
export function splitImageSummary(text) {
  const summaryIndex = text.lastIndexOf(SUMMARY_HEADING);
  const transcriptPart = summaryIndex >= 0 ? text.slice(0, summaryIndex) : text;
  const summary = summaryIndex >= 0 ? text.slice(summaryIndex + SUMMARY_HEADING.length).trim() : "";
  const transcriptIndex = transcriptPart.indexOf(TRANSCRIPT_HEADING);
  const transcript = (transcriptIndex >= 0
    ? transcriptPart.slice(transcriptIndex + TRANSCRIPT_HEADING.length)
    : transcriptPart).trim();
  return { transcript, summary };
}

/**
 * 画像に写っている文章を読み取ります。
 * @param {object} env
 * @param {{ mimeType: string, base64: string }} image
 * @param {object} [options] { selection }
 */
export function recognizeImage(env, image, options = {}) {
  return generateText(env, {
    system: OCR_PROMPT,
    content: [
      { type: "text", text: "この画像に表示されている文章を、ルールどおりに文字として抽出してください。" },
      imagePart(image.mimeType, image.base64),
    ],
    selection: options.selection,
    feature: "ocr",
  });
}

/**
 * 画像の文章を読み取り、要約までを1回の呼び出しで行います。
 * @returns {Promise<{ transcript: string, summary: string, model: string, requestedModel: string, selection: string }>}
 */
export async function recognizeAndSummarizeImage(env, image, options = {}) {
  const detail = Boolean(options.detail);
  const result = await generateText(env, {
    system: buildImageSummaryInstruction(detail),
    content: [
      { type: "text", text: `この画像の文章を読み取り、日本語で${detail ? "詳しめに" : ""}要約してください。` },
      imagePart(image.mimeType, image.base64),
    ],
    selection: options.selection,
    feature: detail ? "ocr-summarize-detail" : "ocr-summarize",
  });
  return { ...splitImageSummary(result.text), ...result };
}
