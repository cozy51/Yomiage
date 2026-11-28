// Worker の応答を作るための小さな共通処理です。

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // AIの結果には機密情報が含まれることがあるため、ブラウザやCDNに保存させません。
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function methodNotAllowed(allow, code) {
  return json({ message: "この操作は利用できません。", code }, 405, { Allow: allow });
}

// 本文をJSONとして読みます。読めないときはnullを返します。
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
