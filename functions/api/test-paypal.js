export async function onRequest(context) {
  const { env } = context;

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const supabaseUrl = env.SUPABASE_URL || "https://jnkhrqvlqtamdclvwacx.supabase.co";
  const supabaseKey = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impua2hycXZscXRhbWRjbHZ3YWN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5ODQ0ODUsImV4cCI6MjA5OTU2MDQ4NX0.rNYh35Beg93OJIG-6aF-zRLDfwD2wZFX_wSRmS3v-II";

  const mockTxId = "PAYPAL-TEST-" + Math.floor(100000 + Math.random() * 900000);
  const mockAmountUSD = 25.00; // Simulasi donasi $25 USD

  try {
    // 1. Simpan dummy data ke Supabase
    const dbResponse = await fetch(`${supabaseUrl}/rest/v1/donations`, {
      method: "POST",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        amount: mockAmountUSD
      })
    });

    if (!dbResponse.ok) {
      const errText = await dbResponse.text();
      throw new Error(`Gagal menyimpan ke Supabase: ${errText}`);
    }

    // 2. Kirim Notifikasi ke Telegram
    let telegramStatus = "Not sent (Missing Credentials)";
    if (botToken && chatId) {
      const message = `🎉 *Tes Transaksi PayPal Berhasil!*\n\n` +
                      `🆔 *ID Transaksi:* \`${mockTxId}\`\n` +
                      `💵 *Nominal (USD):* $${mockAmountUSD.toFixed(2)}\n` +
                      `📌 *Status:* Integration Tested`;

      const teleResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown"
        })
      });

      const teleData = await teleResponse.json();
      telegramStatus = teleData.ok ? "Success" : `Failed: ${teleData.description}`;
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Simulasi transaksi PayPal berhasil!",
      data: {
        transaction_id: mockTxId,
        amount_usd: mockAmountUSD,
        telegram_status: telegramStatus
      }
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
