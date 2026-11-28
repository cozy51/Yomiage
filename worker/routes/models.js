/**
 * /api/models ― 画面の一番下に表示する「AIモデルの選び方」と、指定しているモデル名を返します。
 * モデル名は秘密の情報ではないため、認証なしで返します。AIは呼び出しません（料金はかかりません）。
 */

import { getTextModel, getTtsModel, MODEL_SELECTIONS } from "../ai/config.js";
import { json, methodNotAllowed } from "../lib/http.js";

export function handleModels(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET", "MODELS-405");

  const tts = getTtsModel(env);
  const result = {};
  for (const selection of MODEL_SELECTIONS) {
    result[selection] = { text: getTextModel(env, selection), tts };
  }
  return json(result);
}
