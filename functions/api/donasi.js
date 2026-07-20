// Cloudflare Pages Function
// Route: GET /api/donasi
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GOAL_AMOUNT (opsional, target dalam bentuk USD, default 5000)
//   EXCHANGE_RATE (opsional, kurs IDR ke USD, default 16000)

export async function onRequestGet(context) {
  const { env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  
  // Target donasi dalam USD
  const GOAL_AMOUNT = Number(env.GOAL_AMOUNT) || 5000;
  
  // Kurs konversi dari IDR ke USD (bisa diatur lewat env, default 16.000)
  const EXCHANGE_RATE = Number(env.EXCHANGE_RATE) || 16000;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ 
        collectedAmount: 0, 
        goalAmount: GOAL_AMOUNT, 
        currency: 'USD',
        error: 'Supabase belum dikonfigurasi' 
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/donations?select=amount`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Supabase merespons status ${res.status}`);
    }

    const rows = await res.json();
    
    // 1. Hitung total donasi dalam bentuk IDR (sesuai data Trakteer di Supabase)
    const totalIDR = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    
    // 2. Konversi total IDR ke USD
    // Menggunakan .toFixed(2) agar hasil di belakang koma maksimal 2 digit (misal: 10.50)
    // Lalu dibungkus Number() agar tipe datanya kembali menjadi angka, bukan string.
    const collectedAmount = Number((totalIDR / EXCHANGE_RATE).toFixed(2));

    return new Response(
      JSON.stringify({ 
        collectedAmount, 
        goalAmount: GOAL_AMOUNT,
        currency: 'USD'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ 
        collectedAmount: 0, 
        goalAmount: GOAL_AMOUNT, 
        currency: 'USD',
        error: err.message 
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
