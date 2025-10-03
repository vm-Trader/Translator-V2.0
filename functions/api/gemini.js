// ======================================================================
//  Cloudflare Pages Function – Gemini ETA Translator
//  Priority:  highest-free-tier → lowest-free-tier → paid
//  Models chosen from Google Cloud **live** list (v1 first, v1beta last)
// ======================================================================
export async function onRequestPost({ request, env }) {
  /* -------------------- 0.  CORS + method -------------------- */
  const origin = request.headers.get("Origin") || "";
  const host   = request.headers.get("Host")   || "";
  const allowOrigin =
    origin === `https://${host}` ||
    origin.endsWith(".translator-v2-0.pages.dev") ||
    origin === "https://translator-v2-0.pages.dev";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin ? origin : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  const jsonRsp = (body, init = {}) =>
    new Response(JSON.stringify(body), { ...init, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (request.method === "OPTIONS") return jsonRsp(null, { status: 204 });
  if (request.method !== "POST") return jsonRsp({ error: "Method Not Allowed" }, { status: 405 });

  /* -------------------- 1.  body validation -------------------- */
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) return jsonRsp({ error: "Unsupported Media Type" }, { status: 415 });

  let body;
  try { body = await request.json(); } catch (e) {
    return jsonRsp({ error: "Invalid JSON", message: e.message }, { status: 400 });
  }
  const rawText = (body?.text ?? "").toString().trim();
  if (!rawText) return jsonRsp({ error: "Missing text" }, { status: 400 });
  if (rawText.length > 2000) return jsonRsp({ error: "Text too long" }, { status: 413 });

  const targetLang = (body?.target ?? "vi").toLowerCase().trim(); // default Vietnamese
  const sourceLang = (body?.source ?? "auto").toLowerCase().trim(); // default auto-detect

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return jsonRsp({ error: "Server misconfigured" }, { status: 500 });

  /* -------------------- 2.  prompt -------------------- */
  const systemPrompt = `
You are an ETA (Easy-Translate-All) assistant.
Rules:
- Detect the input language (ISO-639-1) unless source is given.
- Polish grammar/style in the SAME language.
- Translate the polished text into the TARGET language requested.
- Keep tone plain, semi-formal, natural.
- If input already equals target language, set translation = improved.
- Return ONLY JSON:
{
  "inputLanguage": "<iso>",
  "improved": "<polished same-language>",
  "translation": "<translated into target>"
}
`.trim();

  /* -------------------- 3.  MODEL PRIORITY – highest free tier first -------------------- */
  const MODELS = [
    "gemini-1.5-flash",               // v1 – unlimited daily tokens, 250 req/day, 10 req/min
    "gemini-pro",                     // v1 – 50 req/day, 3 M tokens/day, warm cluster
    "gemini-1.5-pro",                 // v1beta – bigger context, lower quota
    "gemini-2.5-flash-preview-05-20"  // v1beta – newest, but experimental & slower
  ];

  const payloadBase = {
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nSOURCE: ${sourceLang}\nTARGET: ${targetLang}\n\nTEXT: "${rawText}"` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          inputLanguage: { type: "STRING" },
          improved: { type: "STRING" },
          translation: { type: "STRING" }
        },
        required: ["inputLanguage", "improved", "translation"]
      }
    }
  };

  /* ---------- 4.  fetch wrapper – 30 s timeout ---------- */
  async function tryModel(model) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadBase), signal: controller.signal }
      );
      clearTimeout(id);
      if (!res.ok) throw new Error(`${model} → HTTP ${res.status}`);
      const data = await res.json();
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!txt) throw new Error(`${model} → empty text`);
      return JSON.parse(txt);
    } catch (e) {
      console.warn(`[Gemini ${model}]`, e.message);
      return null;
    } finally {
      clearTimeout(id);
    }
  }

  /* ---------- 5.  walk the chain ---------- */
  let result = null;
  for (const m of MODELS) {
    result = await tryModel(m);
    if (result) break;
  }

  /* ---------- 6.  final answer ---------- */
  if (!result) {
    return jsonRsp({ error: "All Gemini models failed or returned invalid JSON" }, { status: 502 });
  }
  const safe = {
    inputLanguage: String(result.inputLanguage || "Unknown"),
    improved: String(result.improved || ""),
    translation: String(result.translation || "")
  };
  return jsonRsp(safe, { status: 200 });
}
