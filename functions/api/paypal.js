export async function onRequestPost(context) {
  try {
    const event = await context.request.json();

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const resource = event.resource;
      
      const orderId = resource.id;
      const amount = resource.amount.value;
      const currency = resource.amount.currency_code;
      const payerEmail = resource.payer?.email_address || 'Anonymous';

      const supabaseUrl = context.env.SUPABASE_URL;
      const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
      const botToken = context.env.TELEGRAM_BOT_TOKEN;
      const chatId = context.env.TELEGRAM_CHAT_ID;

      // 1. Simpan data transaksi ke REST API Supabase
      const response = await fetch(`${supabaseUrl}/rest/v1/donations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          amount: parseFloat(amount)
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Gagal simpan ke Supabase:', errText);
        return new Response(JSON.stringify({ error: errText }), { status: 500 });
      }

      // 2. Kirim Notifikasi ke Telegram
      if (botToken && chatId) {
        const message = `🎉 *Donasi PayPal Masuk!*\n\n` +
                        `🆔 *Order ID:* \`${orderId}\`\n` +
                        `💵 *Nominal:* $${parseFloat(amount).toFixed(2)} ${currency}\n` +
                        `👤 *Pengirim:* ${payerEmail}`;

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
          })
        });
      }

      return new Response(JSON.stringify({ success: true, message: 'Webhook tercatat & notifikasi terkirim' }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });

  } catch (err) {
    console.error('Error memproses webhook:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
}
