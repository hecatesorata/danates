// Cloudflare Pages Function: POST /api/delete-from-github
// Menghapus file dari repo GitHub berdasarkan path-nya.
// GitHub API mengharuskan tahu "sha" file itu dulu sebelum bisa dihapus,
// jadi di sini kita GET dulu buat ambil sha, baru DELETE.

const OWNER = "hecatesorata";
const REPO = "danates";
const BRANCH = "main";

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

  const { path } = body || {};
  if (!path || typeof path !== "string" || !path.startsWith("assets/")) {
    return json({ error: "path tidak valid" }, 400);
  }

  const headers = {
    "Authorization": `token ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "penjaga-batas-admin"
  };

  try {
    // 1. Ambil sha file saat ini
    const getRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`,
      { headers }
    );

    if (getRes.status === 404) {
      // File sudah tidak ada di repo — anggap sukses (tidak ada yang perlu dihapus lagi)
      return json({ deleted: true, note: "File sudah tidak ada di repo" });
    }
    if (!getRes.ok) {
      const errBody = await getRes.text();
      return json({ error: `Gagal ambil info file (${getRes.status}): ${errBody}` }, 502);
    }
    const fileInfo = await getRes.json();

    // 2. Hapus file pakai sha itu
    const delRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`,
      {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Delete via admin: ${path}`,
          sha: fileInfo.sha,
          branch: BRANCH
        })
      }
    );

    if (!delRes.ok) {
      const errBody = await delRes.text();
      return json({ error: `Gagal hapus file (${delRes.status}): ${errBody}` }, 502);
    }

    return json({ deleted: true });
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
