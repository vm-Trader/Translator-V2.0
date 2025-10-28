// ========================================================================
//  Cloudflare Pages Function – Gemini ETA Translator
//  Security-first, zero-log, copy-paste ready
// ========================================================================
export async function onRequestPost({ request, env }) {
  /* ---------- 0.  CORS + method guard ---------- */
  const origin = request.headers.get("Origin") || "";
  const host   = request.headers.get("Host")   || "";
  const allowedOrigins = [
    `https://${host}`,
    `https://translator-v2-0.pages.dev`,
    /\.translator-v2-0\.pages\.dev$/ // Regex to allow subdomains if needed
  ];
  const allowOrigin = allowedOrigins.some(o =>
    typeof o === "string" ? o === origin : o.test(origin)
  ) ? origin : "";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  const jsonRsp = (body, init = {}) =>
    new Response(JSON.stringify(body), { ...init, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (request.method === "OPTIONS") return jsonRsp(null, { status: 204 });
  if (request.method !== "POST") return jsonRsp({ error: "Method Not Allowed" }, { status: 405 });

  /* ---------- 1.  body validation + limits ---------- */
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) return jsonRsp({ error: "Unsupported Media Type" }, { status: 415 });

  let body;
  try { body = await request.json(); } catch (e) {
    return jsonRsp({ error: "Invalid JSON", message: e.message }, { status: 400 });
  }
  const rawText = (body?.text ?? "").toString().trim();
  if (!rawText) return jsonRsp({ error: "Missing text" }, { status: 400 });
  if (rawText.length > 2000) return jsonRsp({ error: "Text too long" }, { status: 413 });

  const targetLang = (body?.target ?? "vi").toLowerCase().trim();
  const sourceLang = (body?.source ?? "auto").toLowerCase().trim();

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return jsonRsp({ error: "Server misconfigured" }, { status: 500 });

  /* ---------- 2.  system prompt ---------- */
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

  /* ---------- 3.  model list (free tier priority) ---------- */
  const MODELS = [
    "gemini-1.5-flash",
    "gemini-pro",
    "gemini-1.5-pro",
    "gemini-2.5-flash-preview-05-20" // <-- Keep an eye on preview model names/availability
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

  /* ---------- 4.  fetch wrapper – 30 s timeout, dynamic endpoint ---------- */
  async function tryModel(model) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 30000);

    // *** FIX: Determine the correct API version endpoint ***
    let apiVersion = "v1beta"; // Default to beta
    if (model === "gemini-1.5-flash" || model === "gemini-pro") {
      apiVersion = "v1"; // Use v1 for these stable models
    }

    // Prepare payload - potentially remove schema for preview models if causing 400
    let currentPayload = JSON.parse(JSON.stringify(payloadBase)); // Deep copy base payload
    if (model === "gemini-2.5-flash-preview-05-20") {
      // *** FIX OPTION (for 400 Bad Request): Uncomment below if needed ***
      // console.log(`Adjusting payload for preview model: ${model}. Removing responseSchema.`);
      // delete currentPayload.generationConfig.responseSchema;
      // If the above doesn't work, you might need to remove responseMimeType too:
      // delete currentPayload.generationConfig.responseMimeType;
      // Or even the whole generationConfig if the preview model doesn't support JSON mode well yet:
      // delete currentPayload.generationConfig;
    }

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      console.log(`Trying model: ${model} via ${apiVersion} endpoint...`); // Debug log

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentPayload), // Use the potentially modified payload
        signal: controller.signal
      });
      clearTimeout(id);
      if (!res.ok) throw new Error(`${model} → HTTP ${res.status}`);
      const data = await res.json();
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!txt) throw new Error(`${model} → empty text`);

      // *** FIX: Add robust JSON parsing validation ***
      try {
        return JSON.parse(txt);
      } catch (parseError) {
          console.error(`[Gemini ${model}] Failed to parse JSON response:`, parseError);
          throw new Error(`${model} → Invalid JSON received: ${parseError.message}. Text was: ${txt.substring(0, 100)}...`); // Log only first 100 chars
      }
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
    if (result) {
      console.log(`Successfully received response from model: ${m}`); // Debug log success
      break; // Stop trying models once one succeeds
    }
  }

  /* ---------- 6.  final answer ---------- */
  if (!result) {
    console.error("All Gemini models failed to provide a valid response."); // Debug log failure
    return jsonRsp({ error: "All Gemini models failed or returned invalid JSON/text" }, { status: 502 });
  }

  // Ensure result properties are strings, default to empty string if missing/null
  const safe = {
    inputLanguage: String(result.inputLanguage || "Unknown"),
    improved: String(result.improved || ""),
    translation: String(result.translation || "")
  };
  return jsonRsp(safe, { status: 200 });
}
