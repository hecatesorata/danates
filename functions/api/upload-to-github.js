// Cloudflare Pages Function: POST /api/upload-to-github
// Menerima file (base64) dari admin.html, upload ke repo GitHub lewat Contents API,
// pakai token yang disimpan sebagai Environment Variable di Cloudflare Pages
// (Settings -> Environment variables -> GITHUB_TOKEN), JADI TIDAK PERNAH terlihat di browser.

const OWNER = "hecatesorata";
const REPO = "danates";
const BRANCH = "main";
const ALLOWED_FOLDERS = ["assets/fakta", "assets/campaign", "assets/lokasi", "assets/mandau"];

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.GITHUB_TOKEN) {
    return json({ error: "GITHUB_TOKEN belum diatur di Cloudflare Pages Environment Variables" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body request harus JSON" }, 400);
  }

  const { filename, contentBase64, folder } = body || {};
  if (!filename || !contentBase64 || !folder) {
    return json({ error: "filename, contentBase64, dan folder wajib diisi" }, 400);
  }
  if (!ALLOWED_FOLDERS.includes(folder)) {
    return json({ error: "folder tidak diizinkan" }, 400);
  }

  // Bersihkan nama file & buat unik biar gak bentrok/nimpa file lain
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `token ${env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "penjaga-batas-admin",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `Upload via admin: ${path}`,
          branch: BRANCH,
          content: contentBase64
        })
      }
    );

    if (!ghRes.ok) {
      const errBody = await ghRes.text();
      return json({ error: `GitHub API gagal (${ghRes.status}): ${errBody}` }, 502);
    }

    const rawUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}`;
    return json({ url: rawUrl, path });
  } catch (err) {
    return json({ error: "Gagal menghubungi GitHub: " + err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
