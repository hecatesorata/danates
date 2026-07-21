export default {
  async fetch(request, env) {
    try {
      const apiKey = env.INDODAX_API_KEY;
      const secretKey = env.INDODAX_SECRET_KEY;

      if (!apiKey || !secretKey) {
        return new Response("Indodax API Key / Secret Key belum dikonfigurasi", { status: 500 });
      }

      // 1. KONEKSI KE PRIVATE API INDODAX (transHistory)
      const timestamp = Date.now();
      const bodyParams = new URLSearchParams({
        method: "transHistory",
        timestamp: timestamp.toString(),
      }).toString();

      // Buat HMAC-SHA512 Signature via Web Crypto API (Bawaan Cloudflare)
      const encoder = new TextEncoder();
      const keyBuf = encoder.encode(secretKey);
      const msgBuf = encoder.encode(bodyParams);

      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBuf,
        { name: "HMAC", hash: "SHA-512" },
        false,
        ["sign"]
      );

      const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgBuf);
      const signHex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Request ke Endpoint Indodax Private API
      const indodaxRes = await fetch("https://indodax.com/tapi", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Key": apiKey,
          "Sign": signHex,
        },
        body: bodyParams,
      });

      const data = await indodaxRes.json();

      if (data.success !== 1) {
        return new Response(JSON.stringify({ error: data.error }), { status: 400 });
      }

      const deposits = data.return?.deposit || {};
      let totalSynced = 0;

      // 2. ITERASI DEPOSIT & SIMPAN KE SUPABASE & TELEGRAM
      for (const coin in deposits) {
        for (const item of deposits[coin]) {
          if (item.status === "success") {
            const txId = item.txid || `indodax_dep_${item.deposit_id}`;
            const amount = parseFloat(item.amount);
            const currency = coin.toUpperCase();

            // Insert ke Supabase via REST API
            const supabaseRes = await fetch(`${env.SUPABASE_URL}/rest/v1/transaksi`, {
              method: "POST",
              headers: {
                "apikey": env.SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates" // Mencegah eror jika TX ID sudah ada
              },
              body: JSON.stringify({
                transaction_id: txId,
                amount: amount,
                currency: currency,
                status: "COMPLETED",
                created_at: new Date(parseInt(item.submit_time) * 1000).toISOString()
              })
            });

            // Jika transaksi baru berhasil diinsert (status 201 Created)
            if (supabaseRes.status === 201) {
              totalSynced++;

              // 3. KIRIM NOTIFIKASI KE TELEGRAM
              if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
                const pesanTelegram = `🚀 *DEPOSIT INDODAX MASUK!* 🚀\n\n` +
                                      `• *ID Transaksi:* \`${txId}\`\n` +
                                      `• *Jumlah:* ${amount} ${currency}\n` +
                                      `• *Akun:* Fauzy Azwary\n\n` +
                                      `Data telah dicatat otomatis di Supabase.`;

                await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: env.TELEGRAM_CHAT_ID,
                    text: pesanTelegram,
                    parse_mode: "Markdown"
                  })
                });
              }
            }
          }
        }
      }

      return new Response(JSON.stringify({ success: true, new_transactions: totalSynced }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }
};
