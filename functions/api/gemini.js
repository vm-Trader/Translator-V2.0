// /functions/gemini.js
export const onRequestPost = async ({ request }) => {
  const PRIMARY_MODEL = "gemini-2.5-flash-preview-05-20";
  const FALLBACK_MODEL = "gemini-1.5-flash";

  const API_URL = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

  const API_KEY = "AIzaSyDEzX8QpqzThzO3hmBYVLAh_w2nVyRhcrI"; // DO NOT expose in frontend!

  const HEADERS = { "Content-Type": "application/json" };

  const systemPrompt = `
You are a Vietnamese-English communication assistant.
Your job is to polish broken or awkward English into fluent, polite workplace English.
Then, translate that polished sentence into **natural, respectful Vietnamese** using the following cultural rules:

1. Use correct personal pronouns: anh, chị, em, cô, chú, etc.
2. Add politeness particles like "ạ", "dạ", or "vui lòng" when appropriate.
3. Add "ơi" after name-based salutations (e.g., "Chị Lan ơi").
4. Use Vietnamese indirect tone (avoid sounding robotic/direct).
5. Return only JSON with this schema:

{
  "polishedEnglish": "...",
  "vietnamesePolished": "..."
}

DO NOT include explanations or formatting. Only return clean JSON.`.trim();

  // JSON schema for enforcement
  const schema = {
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        polishedEnglish: { type: "STRING" },
        vietnamesePolished: { type: "STRING" }
      },
      required: ["polishedEnglish", "vietnamesePolished"]
    }
  };

  const makePayload = (text) => ({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: schema
  });

  // Core fetch wrapper with timeout
  async function fetchWithTimeout(model, payload, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(API_URL(model), {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(id);
      if (!res.ok) throw new Error(`Gemini ${model} responded with ${res.status}`);
      const data = await res.json();
      const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) throw new Error("Invalid Gemini response structure");
      return JSON.parse(jsonText);
    } catch (err) {
      return { error: true, model, message: err.message };
    }
  }

  // Main entry
  try {
    const input = await request.json();
    if (!input?.text || typeof input.text !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'text' field" }),
        { status: 400 }
      );
    }

    const payload = makePayload(input.text.trim());

    let result = await fetchWithTimeout(PRIMARY_MODEL, payload);

    // Fallback if primary fails
    if (result?.error) {
      console.warn(`⚠️ Primary model failed: ${result.message}`);
      result = await fetchWithTimeout(FALLBACK_MODEL, payload);
    }

    if (result?.error) {
      return new Response(
        JSON.stringify({ error: "Upstream failure", message: result.message }),
        { status: 502 }
      );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://translator-v2-0.pages.dev",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Server error", message: err.message }),
      { status: 500 }
    );
  }
};
