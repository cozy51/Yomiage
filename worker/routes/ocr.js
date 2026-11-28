/**
 * /api/ocr ― 画像から文字を読み取ります（AIで高精度OCR）。
 * 要約・詳細要約を選んでいるときは、読み取りと要約を1回の呼び出しでまとめて行います。
 * 画像は読み取りのあいだだけ扱い、どこにも保存しません。
 */

import { json, methodNotAllowed, readJson } from "../lib/http.js";
import { guardAiRequest, modelInfo } from "./guard.js";
import { describeAiError } from "../ai/errors.js";
import { recognizeAndSummarizeImage, recognizeImage } from "../ai/ocr.js";
import { SUMMARY_ACTIONS } from "../ai/summarize.js";

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// 見た目の違い（空白や改行、全角と半角）を無視して、中身が同じかどうかを調べます。
export function isSameText(left, right) {
  const normalize = (value) => value.replace(/\s+/g, "").normalize("NFKC");
  return normalize(left) === normalize(right);
}

// Base64は元の画像より約33%大きくなるため、その分を戻して実際の画像の大きさを求めます。
function estimateImageBytes(base64Image) {
  const padding = base64Image.endsWith("==") ? 2 : base64Image.endsWith("=") ? 1 : 0;
  return Math.floor((base64Image.length * 3) / 4) - padding;
}

export async function handleOcr(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST", "AI-405");

  const blocked = await guardAiRequest(env, request, "AI");
  if (blocked) return blocked;

  const body = await readJson(request);
  const image = typeof body?.image === "string" ? body.image.trim() : "";
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType.toLowerCase() : "";

  if (!image || !BASE64_PATTERN.test(image)) {
    return json({ message: "画像を受け取れませんでした。もう一度コピーしてからお試しください。", code: "AI-BADREQ" }, 400);
  }
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return json({ message: "この画像の形式には対応していません。PNGまたはJPEGの画像でお試しください。", code: "AI-TYPE" }, 415);
  }
  if (estimateImageBytes(image) > MAX_IMAGE_BYTES) {
    return json({ message: "画像が大きすぎます。", code: "AI-SIZE" }, 413);
  }

  const action = SUMMARY_ACTIONS.includes(body?.action) ? body.action : "";
  // 画面から届く「AIモデルの選び方」です（以前の画面の modelPriority も受け付けます）。
  const selection = body?.modelSelection ?? body?.modelPriority;

  try {
    if (action) {
      const result = await recognizeAndSummarizeImage(env, { mimeType, base64: image }, {
        detail: action === "summarize-detail",
        selection,
      });
      if (!result.transcript) {
        const error = describeAiError({ kind: "empty" }, "ocr");
        return json({ message: error.message, code: error.code }, error.status);
      }
      // 要約を受け取れなかったときは、読み取った文章だけを返します（画面側で、文章の要約をやり直します）。
      return json({
        text: result.transcript,
        summary: result.summary,
        unchanged: Boolean(result.summary) && isSameText(result.summary, result.transcript),
        ...modelInfo(result),
      });
    }

    const result = await recognizeImage(env, { mimeType, base64: image }, { selection });
    // 読み取った文章と、使ったモデルの情報だけを返します。
    return json({ text: result.text, ...modelInfo(result) });
  } catch (error) {
    const described = describeAiError(error, "ocr");
    return json({ message: described.message, code: described.code }, described.status);
  }
}
