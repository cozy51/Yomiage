"use strict";

/**
 * 画面の一番下に表示する「使用AIモデル」の名前を返します。
 *
 * モデル名は秘密の情報ではないため、パスワード認証なしで返します（APIキーは返しません）。
 * 環境変数 GEMINI_MODEL / GEMINI_TTS_MODEL を設定している場合は、その値を返します。
 */

const { getGeminiModel, getGeminiTtsModel } = require("./_gemini");

module.exports = function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ message: "この操作は利用できません。", code: "MODELS-405" });
  }

  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ text: getGeminiModel(), tts: getGeminiTtsModel() });
};
