export async function onRequestPost({ request }) {
  return new Response(JSON.stringify({ ok: true, msg: "Function reached!" }), {
    headers: { "Content-Type": "application/json" }
  });
}
