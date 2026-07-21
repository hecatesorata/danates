export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Ambil payload JSON dari PayPal
    const event = await request.json();

    // 2. Filter event pembayaran sukses
    if (event.event_type === "PAYMENT.SALE.COMPLETED") {
      const payment = event.resource || {};

      const amount = parseFloat(payment.amount?.total || "0");
      const currency = payment.amount?.currency || "USD";

      // Safe-chaining untuk nama donatur
      const firstName = payment.payer?.payer_info?.first_name;
      const lastName = payment.payer?.payer_info?.last_name;

      let donorName = "PayPal Donor";
      if (firstName) {
        donorName = `${firstName} ${lastName || ''}`.trim();
      }

      // 3. SIMPAN KE TABEL 'donations' DI SUPABASE
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
        const errText = await supabaseRes.text();
        console.error("Gagal simpan ke Supabase:", errText);
      } else {
        console.log("Berhasil menyimpan donasi ke Supabase!");
      }

      // 4. KIRIM NOTIFIKASI TELEGRAM (Format Jarvis)
      const pesanTelegram = `*Donasi baru masuk!*\n` +
                            `*Nominal:* ${currency} ${amount}\n` +
                            `*Donatur:* [ ${donorName} ]\n` +
                            `*Sumber:* paypal\n` +
                            `*Pesan:* Terima kasih atas dukungannya!`;

      const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: pesanTelegram,
          parse_mode: "Markdown"
        })
      });

      if (!tgRes.ok) {
        console.error("Gagal kirim ke Telegram:", await tgRes.text());
      }
    }

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("Error Processing Webhook:", err.stack || err);
    return new Response("Error Processing Webhook", { status: 500 });
  }
}
