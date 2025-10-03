export async function onRequestPost({ request, env }) {
  try {
    // 🔑 Check for API key
    if (!env.GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: "API key missing in environment" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 📨 Parse user request
    let incomingJson;
    try {
      incomingJson = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { text } = incomingJson;
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "Missing or invalid 'text' field" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 🧠 System prompt for Gemini
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
    `;

    // 🛠️ Payload for Gemini API
    const payload = {
      contents: [{
        role: "user",
        parts: [{ text: `${systemPrompt}\n\nUser message: "${text}"` }]
      }],
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

    // 🌐 Call Gemini API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent?key=${env.GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // ❌ If Gemini returns error
    if (!resp.ok) {
      const errorBody = await resp.text();
      return new Response(JSON.stringify({
        error: "Gemini API error",
        status: resp.status,
        body: errorBody
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // ✅ Parse Gemini response
    const result = await resp.json();
    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonString) {
      return new Response(JSON.stringify({ error: "Empty response from Gemini", raw: result }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(jsonString, {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal server error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
