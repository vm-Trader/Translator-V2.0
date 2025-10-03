// functions/api/gemini.js
// Cloudflare Pages Function — Guardian-ready
// Security: Zero Trust, no secrets in logs, strict input validation, strict CORS, basic rate limiting.

///////////////////////////////////////////////////////////////////////////////
// Config (edit safely)
///////////////////////////////////////////////////////////////////////////////
const ORIGIN_ALLOW = [
  "https://translator-vm.pages.dev",   // production site
  "http://localhost:8788"              // local preview/dev
];

const MAX_CHARS = 2000;
const FETCH_TIMEOUT_MS = 10_000;

// Token bucket rate limiting (per IP)
const RATE_LIMIT = {
  capacity: 20,          // max tokens in bucket
  refillPerMinute: 12,   // tokens added per minute
};

// Gemini endpoint/model
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent";

///////////////////////////////////////////////////////////////////////////////
// Globals (per-worker-instance; acceptable for basic abuse control)
///////////////////////////////////////////////////////////////////////////////
const ipBuckets = new Map(); // Map<ip, { tokens, lastRefillMs }>

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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getClientIp(req) {
  // Prefer CF-Connecting-IP set by Cloudflare; fall back to X-Forwarded-For.
  return req.headers.get("CF-Connecting-IP")
      || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
      || "0.0.0.0";
}

function rateLimit(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT.capacity, lastRefillMs: now };
    ipBuckets.set(ip, bucket);
  }
  // Refill based on elapsed time
  const elapsedMin = (now - bucket.lastRefillMs) / 60_000;
  const refill = Math.floor(elapsedMin * RATE_LIMIT.refillPerMinute);
  if (refill > 0) {
    bucket.tokens = Math.min(RATE_LIMIT.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }
  // Consume
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

function corsCheckAndHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) {
    // Same-origin/no CORS context – allow the request (no CORS headers required)
    return { ok: true, origin: null, headers: {} };
  }
  if (!ORIGIN_ALLOW.includes(origin)) {
    return { ok: false, origin, headers: {} };
  }
  return {
    ok: true,
    origin,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
    },
  };
}

// Strict allow-list sanitization: letters, numbers, punctuation, and spaces
// NFKC normalization collapses homoglyphs & odd forms
function sanitizeUserText(raw) {
  if (typeof raw !== "string") return "";
  const normalized = raw.normalize("NFKC");
  // Remove characters outside of: Letters (L), Numbers (N), Punctuation (P), and Space_Separator (Zs)
  const cleaned = normalized.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, " ").trim();
  return cleaned;
}

///////////////////////////////////////////////////////////////////////////////
// Pages Functions entry points
///////////////////////////////////////////////////////////////////////////////
export const onRequestOptions = ({ request }) => {
  // Preflight: respond only for allowed origins; allow only POST
  const { ok, origin, headers } = corsCheckAndHeaders(request);
  if (!ok) {
    return json({ error: ERROR_MAP.CORS_DENIED.code, message: ERROR_MAP.CORS_DENIED.msg }, { status: ERROR_MAP.CORS_DENIED.status });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? headers : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
      "Vary": origin ? "Origin" : "",
    },
  });
};

export const onRequestPost = async (context) => {
  const { request, env } = context;
  const requestId = crypto.randomUUID();

  // CORS
  const { ok: corsOK, origin, headers: corsHeaders } = corsCheckAndHeaders(request);
  if (!corsOK) {
    return json({ error: ERROR_MAP.CORS_DENIED.code, message: ERROR_MAP.CORS_DENIED.msg, requestId },
                { status: ERROR_MAP.CORS_DENIED.status });
  }

  // Method
  if (request.method !== "POST") {
    return json({ error: ERROR_MAP.METHOD_NOT_ALLOWED.code, message: ERROR_MAP.METHOD_NOT_ALLOWED.msg, requestId }, {
      status: ERROR_MAP.METHOD_NOT_ALLOWED.status,
      headers: corsHeaders,
    });
  }

  // Rate limit per IP
  const ip = getClientIp(request);
  if (!rateLimit(ip)) {
    // Minimal logging (no PII)
    console.warn(JSON.stringify({ level: "warn", event: "rate_limited", ip, requestId }));
    return json({ error: ERROR_MAP.RATE_LIMITED.code, message: ERROR_MAP.RATE_LIMITED.msg, requestId }, {
      status: ERROR_MAP.RATE_LIMITED.status,
      headers: corsHeaders,
    });
  }

  // Content-Type must be JSON
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return json({ error: ERROR_MAP.BAD_CONTENT_TYPE.code, message: ERROR_MAP.BAD_CONTENT_TYPE.msg, requestId }, {
      status: ERROR_MAP.BAD_CONTENT_TYPE.status,
      headers: corsHeaders,
    });
  }

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: ERROR_MAP.BAD_JSON.code, message: ERROR_MAP.BAD_JSON.msg, requestId }, {
      status: ERROR_MAP.BAD_JSON.status,
      headers: corsHeaders,
    });
  }

  // Validate "text"
  const textRaw = (body?.text ?? "").toString();
  if (!textRaw) {
    return json({ error: ERROR_MAP.MISSING_TEXT.code, message: ERROR_MAP.MISSING_TEXT.msg, requestId }, {
      status: ERROR_MAP.MISSING_TEXT.status,
      headers: corsHeaders,
    });
  }
  if (textRaw.length > MAX_CHARS * 2) { // early cap to avoid heavy work on malicious payloads
    return json({ error: ERROR_MAP.TEXT_TOO_LONG.code, message: ERROR_MAP.TEXT_TOO_LONG.msg, requestId }, {
      status: ERROR_MAP.TEXT_TOO_LONG.status,
      headers: corsHeaders,
    });
  }

  const text = sanitizeUserText(textRaw);
  if (!text || text.length > MAX_CHARS) {
    const err = !text ? ERROR_MAP.INVALID_TEXT : ERROR_MAP.TEXT_TOO_LONG;
    return json({ error: err.code, message: err.msg, requestId }, {
      status: err.status,
      headers: corsHeaders,
    });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: ERROR_MAP.NOT_CONFIGURED.code, message: ERROR_MAP.NOT_CONFIGURED.msg, requestId }, {
      status: ERROR_MAP.NOT_CONFIGURED.status,
      headers: corsHeaders,
    });
  }

  // Build request for Gemini — keep system instructions server-side
  // Separate parts to reduce token overhead and improve safety
  const system = [
    "You are a bilingual assistant for English and Vietnamese.",
    "Return a compact JSON object with keys: inputLanguage, improved, translation.",
    "improved = short, polished rewrite in the SAME language as input.",
    "translation = the OTHER language (EN↔VI).",
    "No code fences. No extra commentary."
  ].join(" ");

  const payload = {
    contents: [
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: `TEXT:\n${text}` }] }
    ]
  };

  // Call upstream with timeout
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
    return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId }, {
      status: ERROR_MAP.UPSTREAM_ERROR.status,
      headers: corsHeaders,
    });
  } finally {
    clearTimeout(to);
  }

  if (!upstream.ok) {
    // Soft-classify upstream failures without leaking details
    console.warn(JSON.stringify({ level: "warn", event: "upstream_bad_status", requestId, status: upstream.status }));
    return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId }, {
      status: ERROR_MAP.UPSTREAM_ERROR.status,
      headers: corsHeaders,
    });
  }

  let data = {};
  try {
    data = await upstream.json();
  } catch {
    return json({ error: ERROR_MAP.UPSTREAM_ERROR.code, message: ERROR_MAP.UPSTREAM_ERROR.msg, requestId }, {
      status: ERROR_MAP.UPSTREAM_ERROR.status,
      headers: corsHeaders,
    });
  }

  // Parse Gemini output safely
  const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch {
    parsed = { inputLanguage: "Unknown", improved: textOut || "", translation: "" };
  }

  const safe = {
    inputLanguage: String(parsed.inputLanguage || "Unknown"),
    improved: String(parsed.improved || ""),
    translation: String(parsed.translation || ""),
    requestId,
  };

  // Structured, non-PII logging
  console.info(JSON.stringify({
    level: "info",
    event: "translate_ok",
    requestId,
    ip, // acceptable for ops; remove if you prefer to omit
    in_len: text.length,
    out_len: (safe.improved.length + safe.translation.length),
  }));

  return json(safe, { status: 200, headers: corsHeaders });
};
