// L1
export async function onRequestPost({ request, env }) {
  // L2
  const origin = request.headers.get("Origin") || "";
  const host = request.headers.get("Host") || "";

  // L5
  const allowOrigin =
    origin === `https://${host}` ||
    origin.endsWith(".translator-v2-0.pages.dev") ||
    origin === "https://translator-v2-0.pages.dev";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin ? origin : "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  // L15
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: corsHeaders
    });
  }

  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return new Response(JSON.stringify({ error: "Unsupported Media Type" }), {
      status: 415,
      headers: corsHeaders
    });
  }

  // L30
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON", message: err.message }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const rawText = (body?.text ?? "").toString();
  if (!rawText.trim()) {
    return new Response(JSON.stringify({ error: "Missing text" }), {
      status: 400, headers: corsHeaders
    });
  }

  const cleanText = rawText.trim(); // Preserve characters, remove only whitespace

  if (cleanText.length > 2000) {
    return new Response(JSON.stringify({ error: "Text too long" }), {
      status: 413, headers: corsHeaders
    });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured: API key missing" }), {
      status: 500, headers: corsHeaders
    });
  }

  // L54
  const systemPrompt = `
You are a multilingual assistant with a strict translation workflow.

🔹 RULES
- Analyze input carefully (especially Vietnamese context).
- Improve text into a clear, natural version with correct grammar.
- Keep language plain, semi-formal, natural. Avoid idioms or robotic tone.
- Break long sentences into 2–3 shorter ones while preserving meaning.

🔹 WORKFLOW
- If Vietnamese → improved Vietnamese + English translation.
- If English → improved English + Vietnamese translation.
- If Hinglish (Hindi in Roman script) → improved English + Vietnamese translation.

🔹 JSON OUTPUT
Return ONLY:
{
  "inputLanguage": "English" | "Vietnamese" | "Hinglish",
  "improved": "<Improved version>",
  "translation": "<Translation into target language>"
}
  `.trim();

  const payload = {
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUser message: "${cleanText}"` }] }],
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
    return new Response(JSON.stringify({ error: "Upstream failure", message: err.message }), {
      status: 502, headers: corsHeaders
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!result.ok) {
    const errText = await result.text();
    return new Response(JSON.stringify({
      error: "Upstream error",
      status: result.status,
      body: errText.slice(0, 500)
    }), { status: 502, headers: corsHeaders });
  }

  let parsed;
  try {
    const raw = await result.json();
    const out = raw?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    parsed = JSON.parse(out);
  } catch (err) {
    parsed = { inputLanguage: "Unknown", improved: "", translation: "" };
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
