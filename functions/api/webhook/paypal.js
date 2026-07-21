export default {
  async fetch(request, env) {
    // Hanya menerima HTTP POST dari PayPal
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // 1. Ambil payload JSON dari PayPal
      const event = await request.json();

      // 2. Filter event pembayaran sukses
      if (event.event_type === "PAYMENT.SALE.COMPLETED") {
        const payment = event.resource;

        const amount = parseFloat(payment.amount.total);
        const currency = payment.amount.currency;
        
        // Ambil nama donatur jika ada
        const donorName = payment.payer?.payer_info?.first_name 
          ? `${payment.payer.payer_info.first_name} ${payment.payer.payer_info.last_name || ''}`.trim()
          : "PayPal Donor";

        // 3. SIMPAN KE TABEL 'donations' DI SUPABASE (Memakai SERVICE ROLE KEY)
        const supabaseRes = await fetch(`${env.SUPABASE_URL}/rest/v1/donations`, {
          method: "POST",
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            amount: amount,
            source: "paypal",
            raw_payload: event,
            donor: donorName,
            created_at: new Date().toISOString()
          })
        });

        if (!supabaseRes.ok) {
          console.error("Gagal simpan ke Supabase:", await supabaseRes.text());
        }

        // 4. KIRIM NOTIFIKASI TELEGRAM (Format Jarvis)
        const pesanTelegram = `*Donasi baru masuk!*\n` +
                              `*Nominal:* ${currency} ${amount}\n` +
                              `*Donatur:* [ ${donorName} ]\n` +
                              `*Sumber:* paypal\n` +
                              `*Pesan:* Terima kasih atas dukungannya!`;

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

      // Beritahu PayPal bahwa event berhasil diterima
      return new Response("OK", { status: 200 });

    } catch (err) {
      console.error("Error Processing Webhook:", err);
      return new Response("Error Processing Webhook", { status: 500 });
    }
  }
};
