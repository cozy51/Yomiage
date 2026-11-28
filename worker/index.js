/**
 * Yomiage の Cloudflare Worker です。
 *
 * - 画面（public/ の HTML・CSS・JavaScript）は Workers Static Assets がそのまま配信します。
 * - /api/* だけをこの Worker が受け持ち、AIの処理は AI Binding（env.AI）→ AI Gateway で行います。
 *   AIサービスごとのAPIキーは使いません。料金は AI Gateway の Unified Billing でまとめて支払います。
 */

import { handleAi } from "./routes/ai.js";
import { handleLogin } from "./routes/login.js";
import { handleModels } from "./routes/models.js";
import { handleOcr } from "./routes/ocr.js";
import { handleTts } from "./routes/tts.js";
import { json } from "./lib/http.js";

const ROUTES = {
  "/api/ocr": handleOcr,
  "/api/ai": handleAi,
  "/api/tts": handleTts,
  "/api/login": handleLogin,
  "/api/models": handleModels,
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, "")];

    if (route) {
      try {
        return await route(request, env);
      } catch (error) {
        // 思いがけない失敗のときも、秘密の情報を含まない案内だけを返します。
        console.error("APIの処理に失敗しました。", pathname, error?.name || error);
        return json({ message: "処理に失敗しました。しばらくしてから再度お試しください。", code: "API-500" }, 500);
      }
    }

    if (pathname.startsWith("/api/")) {
      return json({ message: "この操作は利用できません。", code: "API-404" }, 404);
    }

    // 画面のファイルは Static Assets から返します。
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
