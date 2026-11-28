/**
 * AI音声（文章を読み上げた音声）を作る処理です。
 *
 * Auto Router（cloudflare/auto）は音声の生成に対応していないため、日本語に対応した音声モデル
 * （既定は google/gemini-3.8-flash-lite-tts。wrangler.jsonc の AI_TTS_MODEL で変更できます）を
 * AI Gateway の Unified Billing 経由で使います。GoogleのAPIキーは要りません。
 * 返ってくるのは base64 の WAV です。再生・保存できる形へ組み立てるのはブラウザ側です。
 */

import { runGateway } from "./gateway.js";
import { AiError } from "./errors.js";
import { getTtsModel } from "./config.js";

// 使える声です。増やすときは、画面側（public/script.js の AI_VOICES）と合わせてください。
// どれも Gemini の音声モデルで日本語を読み上げられる声です。
export const ALLOWED_VOICES = ["Aoede", "Kore", "Puck", "Charon", "Leda", "Achird", "Vindemiatrix", "Sulafat"];
export const DEFAULT_VOICE = "Aoede";
// 音声を作るのには時間がかかるため、文章より長めに待ちます。
const TTS_TIMEOUT_MS = 55000;

// 返事の中から音声（base64）を取り出します。形式が違うモデルにも備えて、いくつかの形を見ます。
export function extractAudio(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.audio === "string") return body.audio;
  if (typeof body.audio?.data === "string") return body.audio.data;
  if (typeof body.result?.audio === "string") return body.result.audio;
  return "";
}

/**
 * 文章を音声にします。
 * @param {object} env
 * @param {string} text
 * @param {string} voice
 * @returns {Promise<{ audio: string, mimeType: string, model: string, requestedModel: string, selection: string }>}
 */
export async function synthesizeSpeech(env, text, voice = DEFAULT_VOICE) {
  const { model, selection } = getTtsModel(env);
  const result = await runGateway(env, model, { text, voice }, {
    feature: "tts",
    timeoutMs: TTS_TIMEOUT_MS,
    // 一時的な不調のときだけ、AI Gateway 側で1回だけやり直します。
    maxAttempts: 2,
  });

  const audio = extractAudio(result.body);
  if (!audio) {
    throw new AiError("empty", { model });
  }

  return {
    audio,
    mimeType: "audio/wav",
    model: result.routedModel || (selection === "fixed" ? model : ""),
    requestedModel: model,
    selection,
  };
}
