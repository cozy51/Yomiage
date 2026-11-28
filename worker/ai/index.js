/**
 * AI処理の入口です。画面や認証とは切り離してあるため、ほかの自作アプリ（MyBooks など）でも
 * このフォルダ（worker/ai）をそのまま使えます。必要なのは Workers の AI Binding（env.AI）と、
 * AI Gateway の名前（env.AI_GATEWAY_ID）だけです。
 */

export { recognizeImage, recognizeAndSummarizeImage } from "./ocr.js";
export { summarizeText, SUMMARY_ACTIONS } from "./summarize.js";
export { translateText, TARGET_LANGUAGES } from "./translate.js";
export { synthesizeSpeech, ALLOWED_VOICES, DEFAULT_VOICE } from "./speech.js";
export { generateText } from "./text.js";
export { runGateway } from "./gateway.js";
export { AiError, describeAiError } from "./errors.js";
export { getTextModel, getTtsModel, normalizeModelSelection, MODEL_SELECTIONS } from "./config.js";
