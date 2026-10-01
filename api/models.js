"use strict";

/**
 * 画面の一番下に表示する「使用AIモデル」の名前を返します。
 *
 * モデル名は秘密の情報ではないため、パスワード認証なしで返します（APIキーは返しません）。
 * 環境変数 GEMINI_MODEL / GEMINI_TTS_MODEL を設定している場合は、その値を返します。
 * 混み合っているときや利用上限に達したときに切り替える「代わりのモデル」も返します（ないときは空です）。
 */

const { getTextModels, getTtsModels } = require("./_gemini");

module.exports = function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ message: "この操作は利用できません。", code: "MODELS-405" });
  }

  response.setHeader("Cache-Control", "no-store");
  const [text, textFallback = ""] = getTextModels();
  const [tts, ttsFallback = ""] = getTtsModels();
  return response.status(200).json({ text, tts, textFallback, ttsFallback });
};
