// Cloudflare Pages Function — /api/donations
// Proxy ke Supabase supaya SUPABASE_URL & SUPABASE_ANON_KEY
// gak perlu nongol sama sekali di kode client.
//
// Wajib di-set di Cloudflare Pages > Settings > Environment variables:
//   SUPABASE_URL       = https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY   = eyJhbGciOi...
//
// (dua-duanya sama kayak yang sebelumnya hardcode di script,
// cuma sekarang disimpan di server, bukan di browser)

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return new Response(
      JSON.stringify({ error: "SUPABASE_URL / SUPABASE_ANON_KEY belum di-set di environment variables" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/donations?select=amount`, {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`
      }
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: "Gagal mengambil data dari Supabase" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await res.json();
    const total = data.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

    return new Response(JSON.stringify({ total }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // cache pendek di edge biar gak spam Supabase tiap 10 detik dari semua visitor
        "Cache-Control": "public, max-age=5"
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Server error saat proxy ke Supabase" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
