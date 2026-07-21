export async function onRequest(context) {
  const { env, request } = context;

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const supabaseUrl = env.SUPABASE_URL || "https://jnkhrqvlqtamdclvwacx.supabase.co";
  const supabaseKey = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impua2hycXZscXRhbWRjbHZ3YWN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5ODQ0ODUsImV4cCI6MjA5OTU2MDQ4NX0.rNYh35Beg93OJIG-6aF-zRLDfwD2wZFX_wSRmS3v-II";
  const mode = env.PAYPAL_MODE || "sandbox";

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const body = await request.json();
    const eventType = body.event_type;
    const resource = body.resource || {};

    // Tangkap event pembayaran sukses dari PayPal
    if (eventType === "PAYMENT.CAPTURE.COMPLETED" || eventType === "CHECKOUT.ORDER.APPROVED") {
      const txId = resource.id || "PAYPAL-" + Date.now();
      const amountUSD = parseFloat(resource.amount?.value || resource.purchase_units?.[0]?.amount?.value || 0);

      // 1. Catat ke Supabase
      if (amountUSD > 0) {
        await fetch(`${supabaseUrl}/rest/v1/donations`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            amount: amountUSD
          })
        });
      }

      // 2. Kirim pesan ke Telegram
      if (botToken && chatId) {
        const message = `🎉 *Donasi Baru via PayPal!*\n\n` +
                        `🆔 *ID Transaksi:* \`${txId}\`\n` +
                        `💵 *Nominal:* $${amountUSD.toFixed(2)} USD\n` +
                        `📌 *Mode:* ${mode.toUpperCase()}`;

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown"
          })
        });
      }
    }

    return new Response(JSON.stringify({ status: "success" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
