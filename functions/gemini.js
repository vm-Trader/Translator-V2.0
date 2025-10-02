export async function onRequestPost({ request, env }) {
  try {
    // ✅ check for key here
    if (!env.GEMINI_API_KEY) {
      return new Response("API key missing in environment", { status: 500 });
    }

    const { text } = await request.json();

    const systemPrompt = `
You are a multilingual assistant with strict translation workflow.

🔹 RULES
- Always analyze the input carefully (especially Vietnamese context).
- Improve it into a clear, natural version with correct grammar.
- Keep sentences plain, semi-formal, and natural (no idioms, no robotic tone).
- Break long sentences into 2–3 shorter ones while keeping meaning.

🔹 WORKFLOW
- If input is Vietnamese → improved Vietnamese + English translation.
- If input is English → improved English + Vietnamese translation.
- If input is Hinglish (Hindi written in Roman script) → convert to clear English, then Vietnamese translation.

🔹 JSON OUTPUT
Return ONLY:
{
  "inputLanguage": "English" | "Vietnamese" | "Hinglish",
  "improved": "<Improved version>",
  "translation": "<Translation into target language>"
}
    `;

    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: `User message: "${text}"` }] }],
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent?key=${env.GEMINI_API_KEY}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) return new Response("Gemini API error", { status: 500 });

    const result = await resp.json();
    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonString) return new Response("Invalid response", { status: 500 });

    return new Response(jsonString, {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response("Internal error: " + err.message, { status: 500 });
  }
}
