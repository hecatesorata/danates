// Cloudflare Pages Function
// Route: GET /api/geo
// Mengembalikan kode negara pengunjung berdasarkan data geo bawaan Cloudflare
// (request.cf.country) — tidak perlu API pihak ketiga, tidak ada rate limit,
// dan datanya sama akurat dengan yang dipakai fitur keamanan Cloudflare sendiri.

export async function onRequestGet(context) {
  const { request } = context;
  const country = request.cf?.country || null;

  return new Response(JSON.stringify({ country }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
