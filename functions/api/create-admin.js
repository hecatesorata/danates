// Cloudflare Pages Function: POST /api/create-admin
// Bikin akun admin baru langsung (email + password) pakai Supabase Admin API.
// Butuh SUPABASE_SERVICE_ROLE_KEY di Cloudflare Pages Environment Variables
// (JANGAN dipakai/ditaruh di kode frontend, cuma boleh di sini/server-side).
//
// Endpoint ini cuma boleh dipanggil sama admin yang udah login (dicek lewat
// Authorization: Bearer <access_token> punya sesi Supabase Auth admin yang lagi aktif).

const SUPABASE_URL = "https://jnkhrqvlqtamdclvwacx.supabase.co";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "SUPABASE_SERVICE_ROLE_KEY belum diatur di Cloudflare Pages Environment Variables" }, 500);
  }

  // 1. Ambil & validasi token admin yang manggil endpoint ini
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({ error: "Tidak ada sesi login. Login ulang lalu coba lagi." }, 401);
  }

  try {
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${token}`
      }
    });
    if (!whoRes.ok) {
      return json({ error: "Sesi login tidak valid, login ulang lalu coba lagi." }, 401);
    }
  } catch (err) {
    return json({ error: "Gagal memvalidasi sesi: " + err.message }, 500);
  }

  // 2. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body request harus JSON" }, 400);
  }
  const email = (body?.email || "").trim();
  const password = body?.password || "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Email tidak valid" }, 400);
  }
  if (!password || password.length < 6) {
    return json({ error: "Password minimal 6 karakter" }, 400);
  }

  // 3. Bikin user baru langsung lewat Supabase Admin API
  try {
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true
      })
    });

    const createBody = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
      return json({ error: createBody?.msg || createBody?.error_description || `Gagal membuat admin (${createRes.status})` }, 502);
    }

    return json({ success: true, email });
  } catch (err) {
    return json({ error: "Gagal menghubungi Supabase: " + err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
