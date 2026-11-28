/**
 * /api/tts ― 文章をAIの音声で読み上げた音声データ（WAV・base64）を作ります。
 * 文章と音声は処理のあいだだけ扱い、どこにも保存しません。
 */

import { json, methodNotAllowed, readJson } from "../lib/http.js";
import { guardAiRequest, modelInfo } from "./guard.js";
import { describeAiError } from "../ai/errors.js";
import { ALLOWED_VOICES, DEFAULT_VOICE, synthesizeSpeech } from "../ai/speech.js";

// 1回で渡せる文章の長さです。画面側（public/script.js の AI_TTS_CHUNK_LENGTH）は、これより短く区切って送ります。
export const MAX_TEXT_LENGTH = 300;

export async function handleTts(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST", "TTS-405");

  const blocked = await guardAiRequest(env, request, "TTS");
  if (blocked) return blocked;

  const body = await readJson(request);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return json({ message: "文章を受け取れませんでした。もう一度お試しください。", code: "TTS-BADREQ" }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ message: "文章が長すぎます。短く分けてお試しください。", code: "TTS-LONG" }, 413);
  }

  const voice = typeof body?.voice === "string" && body.voice ? body.voice : DEFAULT_VOICE;
  if (!ALLOWED_VOICES.includes(voice)) {
    return json({ message: "その音声には対応していません。", code: "TTS-VOICE" }, 400);
  }

  try {
    const speech = await synthesizeSpeech(env, text, voice);
    return json({ audio: speech.audio, mimeType: speech.mimeType, ...modelInfo(speech) });
  } catch (error) {
    const described = describeAiError(error, "tts");
    return json({ message: described.message, code: described.code }, described.status);
  }
}
