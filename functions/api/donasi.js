// Cloudflare Pages Function
// Route: GET /api/donasi
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GOAL_AMOUNT (opsional, default 5000000)

export async function onRequestGet(context) {
  const { env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const GOAL_AMOUNT = Number(env.GOAL_AMOUNT) || 5000000;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ collectedAmount: 0, goalAmount: GOAL_AMOUNT, error: 'Supabase belum dikonfigurasi' }),
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
    const collectedAmount = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

    return new Response(
      JSON.stringify({ collectedAmount, goalAmount: GOAL_AMOUNT }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ collectedAmount: 0, goalAmount: GOAL_AMOUNT, error: err.message }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
