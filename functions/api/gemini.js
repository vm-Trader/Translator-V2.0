// ========================================================================
//  Cloudflare Pages Function – Gemini ETA Translator (JS build-safe)
//  - v1 endpoint + gemini-2.5-flash (stable)
//  - strict JSON schema output
//  - 10s timeout + bounded retries (429/5xx)
//  - tight CORS for your Pages domain(s)
//  - zero external imports
// ========================================================================
export async function onRequestPost({ request, env }) {
  /* ---------- 0) CORS + method guard ---------- */
  const origin = request.headers.get("Origin") || "";
  const host   = request.headers.get("Host")   || "";

  const allowedOrigins = [
    `https://${host}`,                         // this deployment
    "https://translator-v2-0.pages.dev",      // prod
    /\.translator-v2-0\.pages\.dev$/          // preview subdomains
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
  const json = (body, init) =>
    new Response(JSON.stringify(body), {
      ...(init || {}),
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });

  if (request.method === "OPTIONS") return json(null, { status: 204 });
  if (request.method !== "POST")   return json({ error: "Method Not Allowed" }, { status: 405 });

  /* ---------- 1) Body validation ---------- */
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) return json({ error: "Unsupported Media Type" }, { status: 415 });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON", message: e && e.message ? e.message : "" }, { status: 400 });
  }

  const rawText = (body && body.text ? String(body.text) : "").trim();
  if (!rawText)              return json({ error: "Missing text" }, { status: 400 });
  if (rawText.length > 2000) return json({ error: "Text too long" }, { status: 413 });

  const targetLang = (body && body.target ? String(body.target) : "vi").toLowerCase().trim();
  const sourceLang = (body && body.source ? String(body.source) : "auto").toLowerCase().trim();

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

  /* ---------- 3) Stable model + payload (v1) ---------- */
  const MODEL = "gemini-2.5-flash"; // current stable name under v1
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
  async function callGemini() {
    const deadlineMs = 10_000;
    let attempt = 0, lastErr;

    while (attempt < 3) {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort("timeout"), deadlineMs);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });

        clearTimeout(timer);

        let data = {};
        try { data = await res.json(); } catch (_) {}

        if (!res.ok) {
          const code = (data && data.error && data.error.code) || res.status;
          const msg  = (data && data.error && data.error.message) || `HTTP ${res.status}`;
          const retryable = code === 429 || res.status >= 500;
          if (retryable && ++attempt < 3) {
            const backoff = 250 * Math.pow(2, attempt) + Math.random() * 150;
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw new Error(msg);
        }

        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
        const text = parts.map(p => (p && p.text) ? p.text : "").join("");
        if (!text) throw new Error("Empty response");
        return JSON.parse(text);

      } catch (e) {
        lastErr = e;
        // continue loop if retries remain
      }
    }

    throw lastErr || new Error("Upstream failed");
  }

  /* ---------- 5) Execute ---------- */
  let result;
  try {
    result = await callGemini();
  } catch (_) {
    // No fallback here to keep build dependency-free
  }

  /* ---------- 6) Final ---------- */
  if (!result || typeof result !== "object") {
    return json({ error: "Translation upstream unavailable" }, { status: 502 });
  }

  return json({
    inputLanguage: String(result.inputLanguage || "Unknown"),
    improved:      String(result.improved || ""),
    translation:   String(result.translation || "")
  }, { status: 200 });
}
