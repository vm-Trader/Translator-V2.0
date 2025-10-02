export default {
  async fetch(request, env) {
    // We only want to handle POST requests
    if (request.method !== "POST") {
      return new Response("Please send a POST request.", { status: 405 });
    }
    return await handlePostRequest(request, env);
  },
};

async function handlePostRequest(request, env) {
  try {
    // Check if the API key is present in the environment secrets
    if (!env.GEMINI_API_KEY) {
      return new Response("API key missing in environment", { status: 500 });
    }

    // Safely parse the incoming JSON from the frontend
    let incomingJson;
    try {
      incomingJson = await request.json();
    } catch (e) {
      return new Response("Invalid JSON in request body", { status: 400 });
    }
    
    const { text } = incomingJson;
    if (!text || typeof text !== 'string') {
        return new Response("Missing or invalid 'text' field in request body", { status: 400 });
    }

    const systemPrompt = `
You are a multilingual assistant with a strict translation workflow.

🔹 RULES
- Always analyze the input text carefully, paying close attention to context, especially for Vietnamese.
- Your primary goal is to improve the text into a clear, natural-sounding version with correct grammar.
- Keep the improved sentences plain, semi-formal, and natural. Avoid idioms or robotic phrasing.
- If a sentence is long, break it into 2–3 shorter sentences while perfectly preserving the original meaning.

🔹 WORKFLOW
- If the input is Vietnamese: your output should be an improved Vietnamese version and an English translation.
- If the input is English: your output should be an improved English version and a Vietnamese translation.
- If the input is Hinglish (Hindi written using the Roman alphabet): your output should be a clear, improved English version and a Vietnamese translation.

🔹 JSON OUTPUT
You must return ONLY a valid JSON object with the following structure. Do not include any other text, explanations, or markdown formatting.
{
  "inputLanguage": "English" | "Vietnamese" | "Hinglish",
  "improved": "<The improved version of the original text>",
  "translation": "<The translation into the target language>"
}
    `;

    // Combine the system prompt and the user's text into a single prompt
    const fullPrompt = `${systemPrompt}\n\nUser message: "${text}"`;

    // Construct the payload with the corrected, more compatible structure
    const payload = {
        contents: [{
            role: "user",
            parts: [{ text: fullPrompt }]
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

    // Use the stable 'gemini-pro-latest' model for reliability
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent?key=${env.GEMINI_API_KEY}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      console.error("Gemini API Error:", errorBody);
      return new Response(`Gemini API error: ${resp.status} ${resp.statusText}. Check Worker logs for details.`, { status: 500 });
    }

    const result = await resp.json();
    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonString) {
      console.error("Invalid response structure from Gemini:", JSON.stringify(result));
      return new Response("Invalid or empty response from Gemini API. Check Worker logs.", { status: 500 });
    }

    return new Response(jsonString, {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("Internal Worker error:", err);
    return new Response("Internal error: " + err.message, { status: 500 });
  }
}

