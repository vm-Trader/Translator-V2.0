// functions/api/gemini.js
// Cloudflare Pages Function — Guardian-ready (corrected payload)

///////////////////////////////////////////////////////////////////////////////
// Config
///////////////////////////////////////////////////////////////////////////////
const ORIGIN_ALLOW = [
  "https://translator-vm.pages.dev",    // production domain
  "https://translator-v2-0.pages.dev",  // add your actual CF Pages domain here
  "http://localhost:8788"               // local preview
];

const MAX_CHARS = 2000;
const FETCH_TIMEOUT_MS = 10_000;

// Simple token bucket (per IP)
const RATE_LIMIT = { capacity: 20, refillPerMinute: 12 };

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent";

///////////////////////////////////////////////////////////////////////////////
// Globals
///////////////////////////////////////////////////////////////////////////////
const ipBuckets = new Map();

///////////////////////////////////////////////////////////////////////////////
// Utilities
///////////////////////////////////////////////////////////////////////////////
const ERROR_MAP = {
  METHOD_NOT_ALLOWED: { code: "METHOD_NOT_ALLOWED", status: 405, msg: "Method not allowed" },
  CORS_DENIED:        { code: "CORS_DENIED",        status: 403, msg: "CORS origin denied" },
  BAD_JSON:           { code: "BAD_JSON",           status: 400, msg: "Invalid JSON body" },
  BAD_CONTENT_TYPE:   { code: "BAD_CONTENT_TYPE",   status: 415, msg: "Unsupported Media Type" },
  MISSING_TEXT:       { code: "MISSING_TEXT",       status: 400, msg: 'Missing "text" field' },
  TEXT_TOO_LONG:      { code: "TEXT_TOO_LONG",      status: 413, msg: `Text too long (>${MAX_CHARS})` },
  INVALID_TEXT:       { code: "INVALID_TEXT",       status: 400, msg: "Invalid text content" },
  NOT_CONFIGURED:     { code: "NOT_CONFIGURED",     status: 500, msg: "Server not configured" },
  RATE_LIMITED:       { code: "RATE_LIMITED",       status: 429, msg: "Too many requests" },
  UPSTREAM_ERROR:     { code: "UPSTREAM_ERROR",     status: 502, msg: "Upstream error" },
  INTERNAL_ERROR:     { code: "INTERNAL_ERROR",     status: 500, msg: "Unexpected server error" },
};

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function getClientIp(req) {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "0.0.0.0"
  );
}

function rateLimit(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT.capacity, lastRefillMs: now };
    ipBuckets.set(ip, bucket);
  }
  const elapsedMin = (now - bucket.lastRefillMs) / 60_000;
  const refill = Math.floor(elapsedMin * RATE_LIMIT.refillPerMinute);
  if (refill > 0) {
    bucket.tokens = Math.min(RATE_LIMIT.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

function corsCheckAndHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return { ok: true, origin: null, headers: {} };
  if (!ORIGIN_ALLOW.includes(origin)) return { ok: false, origin, headers: {} };
  return { ok: true, origin, headers: { "Access-Control-Allow-Origin": origin, Vary: "Origin" } };
}

function sanitizeUserText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, " ")
    .trim();
}

///////////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////////
export const onRequestOptions = ({ request }) => {
  const { ok, origin, headers } = corsCheckAndHeaders(request);
  if (!ok) {
    return json({ error: ERROR_MAP.CORS_DENIED.code, message: ERROR_MAP.CORS_DENIED.msg }, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? headers : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
      Vary: origin ? "Origin" : "",
    },
  });
};

export const onRequestPost = async (context) => {
  const { request, env } = context;
  const requestId = crypto.randomUUID();

  // CORS
  const { ok: corsOK, origin, headers: corsHeaders } = corsCheckAndHeaders(request);
  if (!corsOK) {
    return json({ error: ERROR_MAP.CORS_DENIED.code, message: ERROR_MAP.CORS_DENIED.msg, requestId }, { status: 403 });
  }

  if (request.method !== "POST") {
    return json({ error: ERROR_MAP.METHOD_NOT_ALLOWED.code, message: ERROR_MAP.METHOD_NOT_ALLOWED.msg, requestId },
      { status: 405, headers: corsHeaders });
  }

  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    console.warn(JSON.stringify({ level: "warn", event: "rate_limited", ip, requestId }));
    return json({ error: ERROR_MAP.RATE_LIMITED.code, message: ERROR_MAP.RATE_LIMITED.msg, requestId },
      { status: 429, headers: corsHeaders });
  }

  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return json({ error: ERROR_MAP.BAD_CONTENT_TYPE.code, message: ERROR_MAP.BAD_CONTENT_TYPE.msg, requestId },
      { status: 415, headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: ERROR_MAP.BAD_JSON.code, message: ERROR_MAP.BAD_JSON.msg, requestId },
      { status: 400, headers: corsHeaders });
  }

  const textRaw = (body?.text ?? "").toString();
  if (!textRaw) {
    return json({ error: ERROR_MAP.MISSING_TEXT.code, message: ERROR_MAP.MISSING_TEXT.msg, requestId },
      { status: 400, headers: corsHeaders });
  }
  if (textRaw.length > MAX_CHARS * 2) {
    return json({ error: ERROR_MAP.TEXT_TOO_LONG.code, message: ERROR_MAP.TEXT_TOO_LONG.msg, requestId },
      { status: 413, headers: corsHeaders });
  }

  const text = sanitizeUserText(textRaw);
  if (!text || text.length > MAX_CHARS) {
    return json({ error: ERROR_MAP.INVALID_TEXT.code, message: ERROR_MAP.INVALID_TEXT.msg, requestId },
      { status: 400, headers: corsHeaders });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: ERROR_MAP.NOT_CONFIGURED.code, message: ERROR_MAP.NOT_CONFIGURED.msg, requestId },
      { status: 500, headers: corsHeaders });
  }

  // ✅ Corrected payload: one user message (avoids 502 upstream error)
  const system = [
    "You are a bilingual assistant for English and Vietnamese.",
    "Return a JSON object with keys: inputLanguage, improved, translation.",
    "improved = polished rewrite in the same language.",
    "translation = translation into the other language (EN↔VI).",
    "No code fences. No extra commentary."
  ].join(" ");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${system}\n\nTEXT:\n${text}` }]
      }
    ]
  };

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    clearTimeout(to);
    console.error(JSON.stringify({ level: "error", event: "upstream_fetch_fail", requestId, msg: String(e?.message || e) }));
    return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId },
      { status: 502, headers: corsHeaders });
  } finally {
    clearTimeout(to);
  }

  if (!upstream.ok) {
  const errText = await upstream.text().catch(() => "");
  console.warn(JSON.stringify({
    level: "warn",
    event: "upstream_bad_status",
    requestId,
    status: upstream.status,
    body: errText.slice(0, 300) // log first 300 chars safely
  }));
  return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId },
    { status: 502, headers: corsHeaders });
}


  let data = {};
  try {
    data = await upstream.json();
  } catch {
    return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId },
      { status: 502, headers: corsHeaders });
  }

  const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try { parsed = JSON.parse(textOut); } 
  catch { parsed = { inputLanguage: "Unknown", improved: textOut || "", translation: "" }; }

  const safe = {
    inputLanguage: String(parsed.inputLanguage || "Unknown"),
    improved: String(parsed.improved || ""),
    translation: String(parsed.translation || ""),
    requestId,
  };

  console.info(JSON.stringify({
    level: "info",
    event: "translate_ok",
    requestId,
    ip,
    in_len: text.length,
    out_len: safe.improved.length + safe.translation.length,
  }));

  return json(safe, { status: 200, headers: corsHeaders });
};
