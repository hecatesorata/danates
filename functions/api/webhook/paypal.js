export default {
  async fetch(request, env) {
    // Hanya menerima HTTP POST (karena PayPal mengirim POST)
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // 1. Ambil data JSON dari PayPal
      const event = await request.json();

      // 2. Filter hanya untuk event pembayaran sukses
      if (event.event_type === "PAYMENT.SALE.COMPLETED") {
        const payment = event.resource;
        
        const txId = payment.id;
        const amount = payment.amount.total;
        const currency = payment.amount.currency;
        const emailPenerima = payment.receipt_id || "No Receipt Email";

        // 3. SIMPAN KE SUPABASE (Menggunakan Supabase REST API bawaan)
        // Pastikan Anda sudah membuat tabel bernama 'transaksi' di Supabase
        const supabaseResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/transaksi`, {
          method: "POST",
          headers: {
            "apikey": env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            transaction_id: txId,
            amount: parseFloat(amount),
            currency: currency,
            status: "COMPLETED",
            created_at: new Date().toISOString()
          })
        });

        // 4. KIRIM NOTIFIKASI KE TELEGRAM
        const pesanTelegram = `💸 *ADA TRANSFERAN MASUK!* 💸\n\n` +
                              `• *ID Transaksi:* \`${txId}\`\n` +
                              `• *Jumlah:* ${amount} ${currency}\n` +
                              `• *Status:* Berhasil\n\n` +
                              `Data telah otomatis dicatat di Supabase.`;

        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: pesanTelegram,
            parse_mode: "Markdown" // Agar teks bisa tebal/kode rapi
          })
        });
      }

      // PayPal meminta respon 200 OK dengan cepat
      return new Response("OK", { status: 200 });

    } catch (err) {
      console.error(err);
      // Tetap kembalikan 200 atau 500 tergantung kebutuhan log Anda
      return new Response("Error Processing Webhook", { status: 500 });
    }
  }
};
