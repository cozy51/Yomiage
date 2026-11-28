// Worker の動作確認です（node --test test/ で実行します）。
// AI Binding（env.AI）を模型に置き換え、AI Gateway へ渡す内容と、画面へ返す内容を確かめます。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import worker from "../worker/index.js";
import { verifyAccessJwt } from "../worker/lib/auth.js";
import { splitImageSummary } from "../worker/ai/ocr.js";
import { readGatewayCode } from "../worker/ai/errors.js";

const PASSWORD = "test-password";
const BASE_ENV = {
  APP_PASSWORD_HASH: createHash("sha256").update(PASSWORD).digest("hex"),
  SESSION_SECRET: "secret-for-tests",
  AI_GATEWAY_ID: "yomiage",
  AI_TEXT_MODEL_AUTO: "cloudflare/auto",
  AI_TEXT_MODEL_FIXED: "google/gemini-3.8-flash",
  AI_TTS_MODEL: "google/gemini-3.8-flash-lite-tts",
  AI_AUTO_ALLOWED_MODELS: "",
  AI_AUTO_ALLOWED_PROVIDERS: "",
  AI_LOG_PAYLOAD: "false",
};

let ipCounter = 0;
// テストごとに別の利用者として扱い、回数制限やロックが混ざらないようにします。
function nextIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

// AI Binding の模型です。呼ばれた内容を記録し、決めておいた応答を返します。
function createAi(handler) {
  const calls = [];
  return {
    calls,
    run: async (model, input, options) => {
      calls.push({ model, input, options });
      return handler({ model, input, options, index: calls.length - 1 });
    },
  };
}

function chatResponse(text, headers = {}) {
  return new Response(JSON.stringify({ model: "cloudflare/auto", choices: [{ message: { role: "assistant", content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorResponse(status, code, message = "error") {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function login(env, ip) {
  const response = await worker.fetch(new Request("https://yomiage.example/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password: PASSWORD }),
  }), env);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^yomiage_ai=[^;]+; Max-Age=86400; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  return cookie.split(";")[0];
}

async function callApi(env, path, body, { ip = nextIp(), authenticated = true } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (authenticated) headers.Cookie = await login(env, ip);
  const response = await worker.fetch(new Request(`https://yomiage.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), env);
  return { response, data: await response.json() };
}

test("要約は cloudflare/auto（Auto Router）へ送り、実際に使われたモデル名をヘッダーから返す", async () => {
  const ai = createAi(() => chatResponse("要約した文章です。", {
    "cf-aig-routed-model": "anthropic/claude-haiku-5.5",
    "cf-aig-routing-reason": "cost_optimal_within_pool",
  }));
  const env = { ...BASE_ENV, AI: ai };
  const { response, data } = await callApi(env, "/api/ai", { action: "summarize", text: "長い文章です。".repeat(20), modelSelection: "auto" });

  assert.equal(response.status, 200);
  assert.equal(data.text, "要約した文章です。");
  assert.equal(data.model, "anthropic/claude-haiku-5.5");
  assert.equal(data.selection, "auto");
  assert.equal(data.requestedModel, "cloudflare/auto");
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const [call] = ai.calls;
  assert.equal(call.model, "cloudflare/auto");
  assert.equal(call.input.messages[0].role, "system");
  assert.match(call.input.messages[0].content, /要約者/);
  assert.match(call.input.messages[1].content, /長い文章です。/);
  // 機密情報を守る設定：キャッシュを使わず、ログへ本文を残さない
  assert.equal(call.options.gateway.id, "yomiage");
  assert.equal(call.options.gateway.skipCache, true);
  assert.equal(call.options.gateway.metadata.feature, "summarize");
  assert.equal(call.options.extraHeaders["cf-aig-collect-log-payload"], "false");
  assert.equal(call.options.returnRawResponse, true);
  // 自動選択では AI Gateway 側のやり直しを付けない（Auto Router が代わりのモデルを試す）
  assert.equal(call.options.gateway.retries, undefined);
});

test("モデル名をヘッダーから取得できないときは、推測せず空で返す（画面では「自動選択」と表示）", async () => {
  const ai = createAi(() => chatResponse("訳文です。"));
  const env = { ...BASE_ENV, AI: ai };
  const { data } = await callApi(env, "/api/ai", { action: "translate", text: "This is a pen.", targetLanguage: "ja" });
  assert.equal(data.text, "訳文です。");
  assert.equal(data.model, "");
  assert.equal(data.selection, "auto");
});

test("固定モデルを選んだときは、設定したモデルを使い、やり直しは回数を決めて行う", async () => {
  const ai = createAi(() => chatResponse("Translated."));
  const env = { ...BASE_ENV, AI: ai };
  const { data } = await callApi(env, "/api/ai", { action: "translate", text: "こんにちは", targetLanguage: "en", modelSelection: "fixed" });
  assert.equal(ai.calls[0].model, "google/gemini-3.8-flash");
  assert.deepEqual(ai.calls[0].options.gateway.retries, { maxAttempts: 2, retryDelayMs: 1000, backoff: "exponential" });
  assert.equal(data.model, "google/gemini-3.8-flash");
  assert.equal(data.selection, "fixed");
});

test("以前の画面の値（economy など）は自動選択として扱う", async () => {
  const ai = createAi(() => chatResponse("要約"));
  const env = { ...BASE_ENV, AI: ai };
  await callApi(env, "/api/ai", { action: "summarize", text: "文章です。".repeat(10), modelPriority: "hydrogen" });
  assert.equal(ai.calls[0].model, "cloudflare/auto");
});

test("Auto Router の候補を絞る設定があるときだけ、許可するモデルのヘッダーを付ける", async () => {
  const ai = createAi(() => chatResponse("要約"));
  const env = { ...BASE_ENV, AI: ai, AI_AUTO_ALLOWED_MODELS: "anthropic/claude-haiku-5.5, google/gemini-3.8-flash" };
  await callApi(env, "/api/ai", { action: "summarize", text: "文章です。".repeat(10) });
  assert.equal(ai.calls[0].options.extraHeaders["cf-aig-allowed-models"], "anthropic/claude-haiku-5.5,google/gemini-3.8-flash");
  assert.equal(ai.calls[0].options.extraHeaders["cf-aig-allowed-providers"], undefined);
});

test("原文がそのまま返ってきたときは、1回だけ念を押してやり直す", async () => {
  const ai = createAi(({ index }) => chatResponse(index === 0 ? "こんにちは" : "Hello", { "cf-aig-routed-model": "openai/gpt-6-luna" }));
  const env = { ...BASE_ENV, AI: ai };
  const { data } = await callApi(env, "/api/ai", { action: "translate", text: "こんにちは", targetLanguage: "en" });
  assert.equal(ai.calls.length, 2);
  assert.match(ai.calls[1].input.messages[0].content, /前回はあなたが原文をそのまま返してしまいました/);
  assert.equal(data.text, "Hello");
  assert.equal(data.unchanged, false);
});

test("高精度OCRは画像をチャット形式（data URL）で渡す", async () => {
  const ai = createAi(() => chatResponse("```\n読み取った文章\n```", { "cf-aig-routed-model": "google/gemini-3.8-flash" }));
  const env = { ...BASE_ENV, AI: ai };
  const { response, data } = await callApi(env, "/api/ocr", { image: "aGVsbG8=", mimeType: "image/png" });
  assert.equal(response.status, 200);
  assert.equal(data.text, "読み取った文章");
  assert.equal(data.model, "google/gemini-3.8-flash");
  const content = ai.calls[0].input.messages[1].content;
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, "data:image/png;base64,aGVsbG8=");
  assert.equal(ai.calls[0].options.gateway.metadata.feature, "ocr");
});

test("画像の要約は、読み取りと要約を1回の呼び出しで受け取る", async () => {
  const ai = createAi(() => chatResponse("【読み取り】\n本文の文章です。\n【要約】\n短い要約です。"));
  const env = { ...BASE_ENV, AI: ai };
  const { data } = await callApi(env, "/api/ocr", { image: "aGVsbG8=", mimeType: "image/jpeg", action: "summarize-detail" });
  assert.equal(ai.calls.length, 1);
  assert.equal(data.text, "本文の文章です。");
  assert.equal(data.summary, "短い要約です。");
  assert.equal(data.unchanged, false);
});

test("AI音声は日本語に対応した音声モデルを使い、WAVの音声を返す", async () => {
  const ai = createAi(() => new Response(JSON.stringify({ audio: "UklGRg==" }), { status: 200 }));
  const env = { ...BASE_ENV, AI: ai };
  const { response, data } = await callApi(env, "/api/tts", { text: "こんにちは。", voice: "Kore" });
  assert.equal(response.status, 200);
  assert.equal(data.audio, "UklGRg==");
  assert.equal(data.mimeType, "audio/wav");
  assert.equal(data.model, "google/gemini-3.8-flash-lite-tts");
  assert.equal(data.selection, "fixed");
  assert.equal(ai.calls[0].model, "google/gemini-3.8-flash-lite-tts");
  assert.deepEqual(ai.calls[0].input, { text: "こんにちは。", voice: "Kore" });
});

test("AI音声で使えない声や長すぎる文章は、AIを呼ばずに断る", async () => {
  const ai = createAi(() => assert.fail("AIを呼んではいけません"));
  const env = { ...BASE_ENV, AI: ai };
  const ip = nextIp();
  const voice = await callApi(env, "/api/tts", { text: "こんにちは", voice: "Unknown" }, { ip });
  assert.equal(voice.data.code, "TTS-VOICE");
  const long = await callApi(env, "/api/tts", { text: "あ".repeat(301) }, { ip });
  assert.equal(long.data.code, "TTS-LONG");
});

test("利用上限（Spend Limits の 429）は、分かりやすい案内と LIMIT の印を返す", async () => {
  const ai = createAi(() => errorResponse(429, 2003, "spend limit exceeded"));
  const env = { ...BASE_ENV, AI: ai };
  const { response, data } = await callApi(env, "/api/ai", { action: "summarize", text: "文章です。".repeat(10) });
  assert.equal(response.status, 429);
  assert.equal(data.code, "AI-LIMIT");
  assert.match(data.message, /利用上限/);
  // 無制限にやり直さない
  assert.equal(ai.calls.length, 1);
});

test("Unified Billing の回数制限（2018）は BUSY、残高不足（402）は CREDIT として返す", async () => {
  const busy = await callApi({ ...BASE_ENV, AI: createAi(() => errorResponse(429, 2018)) }, "/api/tts", { text: "こんにちは" });
  assert.equal(busy.data.code, "TTS-BUSY");
  const credit = await callApi({ ...BASE_ENV, AI: createAi(() => errorResponse(402, 2052)) }, "/api/tts", { text: "こんにちは" });
  assert.equal(credit.data.code, "TTS-CREDIT");
  const config = await callApi({ ...BASE_ENV, AI: createAi(() => errorResponse(403, 2049)) }, "/api/ai", { action: "summarize", text: "文章です。" });
  assert.equal(config.data.code, "AI-CONFIG");
});

test("AI Binding が投げたエラー（7003・時間切れ）も日本語の案内にする", async () => {
  const badRequest = await callApi({ ...BASE_ENV, AI: createAi(() => { throw new Error("AiGatewayError: 7003: User Input Error"); }) },
    "/api/ocr", { image: "aGVsbG8=", mimeType: "image/png" });
  assert.equal(badRequest.data.code, "AI-G400");
  const timeout = await callApi({ ...BASE_ENV, AI: createAi(() => { throw new DOMException("timed out", "TimeoutError"); }) },
    "/api/ocr", { image: "aGVsbG8=", mimeType: "image/png" });
  assert.equal(timeout.data.code, "AI-TIMEOUT");
  assert.match(timeout.data.message, /時間内に終わりませんでした/);
});

test("AIが空の返事をしたときは、1回だけやり直してから EMPTY を返す", async () => {
  const ai = createAi(() => chatResponse(""));
  const { data } = await callApi({ ...BASE_ENV, AI: ai }, "/api/ai", { action: "summarize", text: "文章です。" });
  assert.equal(ai.calls.length, 2);
  assert.equal(data.code, "AI-EMPTY");
});

test("パスワードの認証をしていないときは、AIを呼ばずに 401 を返す", async () => {
  const ai = createAi(() => assert.fail("AIを呼んではいけません"));
  const { response, data } = await callApi({ ...BASE_ENV, AI: ai }, "/api/ai", { action: "summarize", text: "文章" }, { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(data.code, "AI-401");
});

test("パスワードの設定や AI Binding がないときは、案内を返す", async () => {
  const noAuth = await callApi({ ...BASE_ENV, APP_PASSWORD_HASH: "", AI: createAi(() => null) }, "/api/ai", { action: "summarize", text: "文章" }, { authenticated: false });
  assert.equal(noAuth.data.code, "AI-NOAUTH");
  const noBinding = await callApi({ ...BASE_ENV }, "/api/tts", { text: "こんにちは" });
  assert.equal(noBinding.data.code, "TTS-NOBINDING");
});

test("パスワードを3回続けて間違えると、しばらく受け付けない", async () => {
  const env = { ...BASE_ENV };
  const ip = nextIp();
  const attempt = () => worker.fetch(new Request("https://yomiage.example/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password: "wrong" }),
  }), env).then((response) => response.json());
  assert.equal((await attempt()).code, "AUTH-401");
  assert.equal((await attempt()).code, "AUTH-401");
  assert.equal((await attempt()).code, "AUTH-LOCKED");
  assert.equal((await attempt()).code, "AUTH-LOCKED");
});

test("書き換えた引換券（Cookie）は受け付けない", async () => {
  const env = { ...BASE_ENV, AI: createAi(() => chatResponse("x")) };
  const ip = nextIp();
  const cookie = await login(env, ip);
  const [name, value] = cookie.split("=");
  const [, signature] = value.split(".");
  const forged = `${name}=${Date.now() + 10 ** 10}.${signature}`;
  const response = await worker.fetch(new Request("https://yomiage.example/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Cookie: forged },
    body: JSON.stringify({ action: "summarize", text: "文章" }),
  }), env);
  assert.equal(response.status, 401);
});

test("/api/models は選び方ごとに指定モデルを返し、AIは呼ばない", async () => {
  const ai = createAi(() => assert.fail("AIを呼んではいけません"));
  const response = await worker.fetch(new Request("https://yomiage.example/api/models"), { ...BASE_ENV, AI: ai });
  const data = await response.json();
  assert.deepEqual(data.auto.text, { model: "cloudflare/auto", selection: "auto" });
  assert.deepEqual(data.fixed.text, { model: "google/gemini-3.8-flash", selection: "fixed" });
  assert.deepEqual(data.auto.tts, { model: "google/gemini-3.8-flash-lite-tts", selection: "fixed" });
});

test("固定モデルの設定に Model Alias（custom/〇〇）を指定したときは、自動選択として表示する", async () => {
  const response = await worker.fetch(new Request("https://yomiage.example/api/models"), { ...BASE_ENV, AI_TEXT_MODEL_FIXED: "custom/yomiage-text" });
  const data = await response.json();
  assert.deepEqual(data.fixed.text, { model: "custom/yomiage-text", selection: "auto" });
});

test("知らない /api/ は JSON の 404、ほかのパスは画面のファイル（Static Assets）へ渡す", async () => {
  const notFound = await worker.fetch(new Request("https://yomiage.example/api/unknown"), BASE_ENV);
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).code, "API-404");
  const env = { ...BASE_ENV, ASSETS: { fetch: async () => new Response("<html>") } };
  const page = await worker.fetch(new Request("https://yomiage.example/"), env);
  assert.equal(await page.text(), "<html>");
  const wrongMethod = await worker.fetch(new Request("https://yomiage.example/api/ocr"), BASE_ENV);
  assert.equal(wrongMethod.status, 405);
});

test("見出しのない返事でも、読み取った文章として扱う", () => {
  assert.deepEqual(splitImageSummary("本文だけ"), { transcript: "本文だけ", summary: "" });
});

test("エラーの本文や例外の文から、AI Gateway のエラー番号を取り出す", () => {
  assert.equal(readGatewayCode('{"errors":[{"code":2018,"message":"x"}]}'), 2018);
  assert.equal(readGatewayCode("AiGatewayError: 7003: User Input Error"), 7003);
  assert.equal(readGatewayCode("no code"), 0);
});

// ===== Cloudflare Access =====

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function makeAccessJwt(privateKey, payload, kid = "key-1") {
  const header = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

test("Cloudflare Access の証明（JWT）を確かめ、正しいときだけパスワードなしで通す", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256" };
  const env = { ...BASE_ENV, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-123" };
  const fetchCerts = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const now = Date.now();
  const valid = makeAccessJwt(privateKey, { iss: "https://team.cloudflareaccess.com", aud: ["aud-123"], exp: Math.floor(now / 1000) + 60 });
  const request = (token) => new Request("https://yomiage.example/api/ai", { headers: { "Cf-Access-Jwt-Assertion": token } });

  assert.equal(await verifyAccessJwt(env, request(valid), { fetch: fetchCerts, now }), true);
  const wrongAud = makeAccessJwt(privateKey, { iss: "https://team.cloudflareaccess.com", aud: ["other"], exp: Math.floor(now / 1000) + 60 });
  assert.equal(await verifyAccessJwt(env, request(wrongAud), { fetch: fetchCerts, now }), false);
  const expired = makeAccessJwt(privateKey, { iss: "https://team.cloudflareaccess.com", aud: ["aud-123"], exp: Math.floor(now / 1000) - 1 });
  assert.equal(await verifyAccessJwt(env, request(expired), { fetch: fetchCerts, now }), false);
  const tampered = `${valid.slice(0, -4)}AAAA`;
  assert.equal(await verifyAccessJwt(env, request(tampered), { fetch: fetchCerts, now }), false);
  // 設定がないときは使わない
  assert.equal(await verifyAccessJwt(BASE_ENV, request(valid), { fetch: fetchCerts, now }), false);
});
