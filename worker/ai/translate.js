/**
 * 文章の翻訳です。モデルの選び方は Auto Router（cloudflare/auto）に任せます。
 * ほかのアプリからも使えるよう、画面や認証とは切り離した関数にしています。
 */

import { generateText } from "./text.js";

// 翻訳できる言語です。増やすときは、この1か所と画面（public/index.html の translate-language）へ追加してください。
export const TARGET_LANGUAGES = {
  ja: "日本語",
  en: "英語",
  zh: "中国語（簡体字）",
  ko: "韓国語",
};

// 翻訳の指示です。入力の言語はAI側で判断させ、訳文だけを返させます。
export function buildTranslateInstruction(languageName) {
  return `あなたは翻訳者です。受け取った文章を${languageName}へ翻訳して返します。

必ず守ってください。

・入力された文章の言語は自動で判断する
・文章全体を${languageName}にする。ほかの言語が混ざっていても、すべて${languageName}へ訳す
・すでに${languageName}で書かれている部分は、その表現のまま残す
・翻訳した文章だけを返す。原文・前置き・解説・注釈は付けない
・原文にない情報を足さない、原文の意味を変えない
・段落と改行はできるだけそのまま保つ
・読み上げに使うため、Markdownや装飾記号は使わない
・画像から読み取った文章のため、記号の混ざりや崩れた単語が含まれることがある。その場合も、意味の通る${languageName}の文章にする
・原文をそのまま書き写して返してはいけない`;
}

export function buildTranslateRequest(languageName, text) {
  return `次の文章を${languageName}へ翻訳してください。

--- ここから文章 ---
${text}
--- ここまで ---`;
}

/**
 * 文章を翻訳します。
 * @param {object} env
 * @param {string} text
 * @param {string} targetLanguage ja / en / zh / ko
 * @param {object} [options] { selection, system: 指示を差し替えるとき, timeoutMs }
 */
export function translateText(env, text, targetLanguage, options = {}) {
  const languageName = TARGET_LANGUAGES[targetLanguage];
  if (!languageName) throw new RangeError(`Unsupported language: ${targetLanguage}`);
  return generateText(env, {
    system: options.system || buildTranslateInstruction(languageName),
    content: buildTranslateRequest(languageName, text),
    selection: options.selection,
    feature: "translate",
    timeoutMs: options.timeoutMs,
  });
}
