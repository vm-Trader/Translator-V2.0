export async function onRequestPost({ request, env }) {
  try {
    if (!env.GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: "API key missing in environment" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { text } = await request.json();

    const systemPrompt = `...`; // keep your existing system prompt

    const payload = {
      contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUser message: "${text}"` }] }],
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

    const bodyText = await resp.text(); // <-- read raw body for debugging
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON from Gemini", bodyText }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const jsonString = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonString) {
      return new Response(JSON.stringify({ error: "Empty candidates", raw: parsed }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(jsonString, { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}


