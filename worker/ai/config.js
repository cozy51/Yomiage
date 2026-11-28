/**
 * AI処理の設定です。モデル名などは wrangler.jsonc の vars（またはダッシュボードの「変数」）で変えられ、
 * アプリのコードを書き換えなくても、使うモデルや選び方を切り替えられるようにしています。
 *
 * ここではモデルの選び方を細かく判定しません。自動選択（cloudflare/auto）を既定にし、
 * どのモデルを使うかは Cloudflare AI Gateway（Auto Router・Model Aliases）に任せます。
 */

// 画面で選べる「AIモデルの選び方」です。auto = 自動選択（既定・推奨）、fixed = 固定モデル。
export const MODEL_SELECTIONS = ["auto", "fixed"];
export const DEFAULT_MODEL_SELECTION = "auto";

// 環境変数が空のときに使う既定値です。
export const DEFAULTS = {
  gatewayId: "yomiage",
  // 文章・画像の処理（高精度OCR・要約・詳細要約・翻訳）で、自動選択のときに使うモデル名です。
  // cloudflare/auto は AI Gateway の Auto Router です。custom/〇〇（Model Alias）や dynamic/〇〇（Dynamic Route）も指定できます。
  textModelAuto: "cloudflare/auto",
  // 固定モデルを選んだときに使うモデル名です。
  textModelFixed: "google/gemini-3.8-flash",
  // AI音声のモデルです。Auto Router は音声の生成に対応していないため、日本語に対応した音声モデルを指定します。
  ttsModel: "google/gemini-3.8-flash-lite-tts",
};

// モデル名として受け付ける形です（例: cloudflare/auto、google/gemini-3.8-flash、@cf/meta/xxx、custom/yomiage-text）。
const MODEL_NAME_PATTERN = /^@?[A-Za-z0-9._-]+(\/[A-Za-z0-9._@-]+)+$/;
const GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function readModel(value, fallback) {
  const model = String(value || "").trim();
  return MODEL_NAME_PATTERN.test(model) ? model : fallback;
}

// 「a,b,c」の形の設定を、空白を除いた一覧にします。
function readList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeModelSelection(value) {
  // 以前の画面の値（economy / standard / hydrogen）は、自動選択として扱います。
  return MODEL_SELECTIONS.includes(value) ? value : DEFAULT_MODEL_SELECTION;
}

export function getGatewayId(env) {
  const id = String(env?.AI_GATEWAY_ID || "").trim();
  return GATEWAY_ID_PATTERN.test(id) ? id : DEFAULTS.gatewayId;
}

// 自動選択のときに使うモデル名かどうか（Cloudflare側でモデルを選ぶ名前か）を調べます。
export function isRoutedModelName(model) {
  return model === "cloudflare/auto" || /^(custom|dynamic)\//.test(model);
}

/**
 * 文章・画像の処理で使うモデルを決めます。
 * 戻り値の selection は、画面に出す「自動選択／固定モデル」の区別です。
 */
export function getTextModel(env, selection) {
  const normalized = normalizeModelSelection(selection);
  if (normalized === "fixed") {
    const model = readModel(env?.AI_TEXT_MODEL_FIXED, DEFAULTS.textModelFixed);
    return { model, selection: isRoutedModelName(model) ? "auto" : "fixed" };
  }
  const model = readModel(env?.AI_TEXT_MODEL_AUTO, DEFAULTS.textModelAuto);
  return { model, selection: isRoutedModelName(model) ? "auto" : "fixed" };
}

export function getTtsModel(env) {
  const model = readModel(env?.AI_TTS_MODEL, DEFAULTS.ttsModel);
  return { model, selection: isRoutedModelName(model) ? "auto" : "fixed" };
}

/**
 * Auto Router が選べるモデルを絞る設定です（任意）。
 * 高額なモデルへ意図せず切り替わるのを防ぎたいときに、wrangler.jsonc の vars で指定します。
 * 空のときは Cloudflare が管理する既定の候補から選びます（利用上限は Spend Limits で守ります）。
 */
export function getAutoRouterRestrictions(env) {
  return {
    allowedModels: readList(env?.AI_AUTO_ALLOWED_MODELS),
    allowedProviders: readList(env?.AI_AUTO_ALLOWED_PROVIDERS),
  };
}

// 入力・出力の本文を AI Gateway のログへ残すかどうかです。機密情報を含むことがあるため、既定は残しません。
export function shouldLogPayload(env) {
  return String(env?.AI_LOG_PAYLOAD || "").trim().toLowerCase() === "true";
}
