// L1
export async function onRequestPost({ request, env }) {                        // L2
  const origin = request.headers.get("Origin") || "";                         // L3
  const host = request.headers.get("Host") || "";                             // L4

  // ✅ Auto-Allow Production + Previews                                          L5
  const allowOrigin =
    origin === `https://${host}` ||                                            // L6
    origin.endsWith(".translator-v2-0.pages.dev") ||                           // L7
    origin === "https://translator-v2-0.pages.dev";                            // L8

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin ? origin : "",                 // L10
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  // Handle OPTIONS (preflight)                                                  L15
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });         // L17
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: corsHeaders                                                     // L22
    });
  }

  // ✅ Content-Type check                                                       L25
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();       // L26
  if (!ct.includes("application/json")) {
    return new Response(JSON.stringify({ error: "Unsupported Media Type" }), {
      status: 415,
      headers: corsHeaders
    });
  }

  let body;
  try {
    body = await request.json();                                              // L34
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: corsHeaders
    });
  }

  // ✅ Strict input enforcement + sanitization                                  L40
  const rawText = (body?.text ?? "").toString();
  if (!rawText.trim()) {
    return new Response(JSON.stringify({ error: "Missing text" }), {
      status: 400, headers: corsHeaders
    });
  }

  const cleanText = rawText
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, " ")
    .trim();                                                                  // L50

  if (cleanText.length > 2000) {
    return new Response(JSON.stringify({ error: "Text too long" }), {
      status: 413, headers: corsHeaders
    });
  }

  // ✅ API key check                                                            L56
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500, headers: corsHeaders
    });
  }

  // ✅ Gemini Payload                                                           L62
  const system = [
    "You are a bilingual assistant for English and Vietnamese.",
    "Return a JSON object with: inputLanguage, improved, translation.",
    "improved = same-language polished version.",
    "translation = other language (EN↔VI)."
  ].join(" ");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${system}\n\nTEXT:\n${cleanText}` }]
      }
    ]
  };

  // ✅ Gemini call with timeout                                                 L74
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 10000);

  let result;
  try {
    result = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload)
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream failure" }), {
      status: 502, headers: corsHeaders
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!result.ok) {
    const errText = await result.text();
    console.warn(JSON.stringify({ status: result.status, error: errText.slice(0, 300) }));
    return new Response(JSON.stringify({ error: "Upstream error" }), {
      status: 502, headers: corsHeaders
    });
  }

  let parsed;
  try {
    const raw = await result.json();
    const out = raw?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    parsed = JSON.parse(out);
  } catch {
    parsed = { inputLanguage: "Unknown", improved: "", translation: "" };
  }

  const safe = {
    inputLanguage: String(parsed.inputLanguage || "Unknown"),
    improved: String(parsed.improved || ""),
    translation: String(parsed.translation || "")
  };

  return new Response(JSON.stringify(safe), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
