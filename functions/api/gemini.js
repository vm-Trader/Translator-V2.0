// ========================================================================
//  Cloudflare Pages Function – Gemini ETA Translator
//  Stable, fast, and copy-paste ready (zero noisy logs)
// ========================================================================
export async function onRequestPost({ request, env }) {
  /* ---------- 0) CORS + method guard ---------- */
  const origin = request.headers.get("Origin") || "";
  const host   = request.headers.get("Host")   || "";

  const allowedOrigins = [
    `https://${host}`,
    "https://translator-v2-0.pages.dev",
    /\.translator-v2-0\.pages\.dev$/ // subdomains
  ];
  const allowOrigin = allowedOrigins.some((o) =>
    typeof o === "string" ? o === origin : o.test(origin)
  ) ? origin : "";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  const json = (body: any, init: any = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });

  if (request.method === "OPTIONS") return json(null, { status: 204 });
  if (request.method !== "POST")   return json({ error: "Method Not Allowed" }, { status: 405 });

  /* ---------- 1) Body validation ---------- */
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) return json({ error: "Unsupported Media Type" }, { status: 415 });

  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return json({ error: "Invalid JSON", message: e?.message || "" }, { status: 400 });
  }

  const rawText = (body?.text ?? "").toString().trim();
  if (!rawText)               return json({ error: "Missing text" }, { status: 400 });
  if (rawText.length > 2000)  return json({ error: "Text too long" }, { status: 413 });

  const targetLang = (body?.target ?? "vi").toLowerCase().trim();  // default: Vietnamese
  const sourceLang = (body?.source ?? "auto").toLowerCase().trim(); // default: auto-detect

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "Server misconfigured" }, { status: 500 });

  /* ---------- 2) Prompt (system + user) ---------- */
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

  /* ---------- 3) Stable model + payload ---------- */
  const MODEL = "gemini-1.5-flash"; // stable text model

  const payload = {
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    contents: [
      { role: "user", parts: [{ text: `SOURCE: ${sourceLang}\nTARGET: ${targetLang}\n\nTEXT:\n${rawText}` }] }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          inputLanguage: { type: "STRING" },
          improved:      { type: "STRING" },
          translation:   { type: "STRING" }
        },
        required: ["inputLanguage", "improved", "translation"]
      },
      candidateCount: 1,
      maxOutputTokens: 256,
      temperature: 0.2
    },
    // Reduce false-positive safety blocks on benign text
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT",  threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUAL",      threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS",   threshold: "BLOCK_NONE" }
    ]
  };

  /* ---------- 4) Upstream call with timeout + retries ---------- */
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  async function callGemini(): Promise<any> {
    const deadlineMs = 10_000;
    let attempt = 0, lastErr: any;

    while (attempt < 3) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort("timeout"), deadlineMs);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });

        clearTimeout(timer);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const code   = data?.error?.code   ?? res.status;
          const status = data?.error?.status ?? res.statusText;
          const msg    = data?.error?.message ?? `HTTP ${res.status}`;
          const retryable = code === 429 || res.status >= 500;

          if (retryable && ++attempt < 3) {
            const backoff = 250 * Math.pow(2, attempt) + Math.random() * 150;
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw new Error(`${status}: ${msg}`);
        }

        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") ?? "";
        if (!text) throw new Error("Empty response");
        return JSON.parse(text);

      } catch (e: any) {
        lastErr = e;
        // loop continues if retries remain
      } finally {
        // ensure timer cleared
      }
    }

    throw lastErr || new Error("Upstream failed");
  }

  /* ---------- 5) Execute with optional fallback ---------- */
  let result: any;
  try {
    result = await callGemini();
  } catch (_) {
    // Optional fallback for pure translation paths
    if (env.AI) {
      try {
        // Dynamic import works on Pages/Workers
        const { Ai } = await import("@cloudflare/ai");
        const ai = new Ai(env.AI);
        const out: any = await ai.run("@cf/meta/m2m100-1.2b", {
          text: rawText, source_lang: sourceLang || "auto", target_lang: targetLang
        });
        result = {
          inputLanguage: sourceLang === "auto" ? "auto" : sourceLang,
          improved: out?.translated_text || "",
          translation: out?.translated_text || ""
        };
      } catch {
        // no-op, will fall through to 502 below
      }
    }
  }

  /* ---------- 6) Final response ---------- */
  if (!result || typeof result !== "object") {
    return json({ error: "Translation upstream unavailable" }, { status: 502 });
  }

  const safe = {
    inputLanguage: String(result.inputLanguage || "Unknown"),
    improved:      String(result.improved || ""),
    translation:   String(result.translation || "")
  };

  return json(safe, { status: 200 });
}
