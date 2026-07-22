// Cloudflare Pages Function
// Route: POST /webhook/paypal
// Menerima IPN/webhook dari PayPal (Payments API classic maupun Orders API),
// simpan ke Supabase, kirim notifikasi Telegram.
//
// CATATAN: signature PayPal (webhook verification via PAYPAL_WEBHOOK_ID) belum
// diverifikasi di sini — kalau mau proteksi lebih ketat, tambahin call ke
// PayPal's /v1/notifications/verify-webhook-signature sebelum memproses event.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   EXCHANGE_RATE          (kurs IDR per 1 USD, dipakai kalau PayPal kirim currency non-USD)
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const DEFAULT_EXCHANGE_RATE = 16300;

export async function onRequestPost({ request, env }) {
  try {
    const event = await request.json();

    const isCompleted =
      event.event_type === 'PAYMENT.SALE.COMPLETED' ||
      event.event_type === 'CHECKOUT.ORDER.APPROVED';

    if (!isCompleted) {
      // Event lain (pending, refund, dll) — abaikan tapi tetap balas 200
      // biar PayPal gak retry terus.
      return new Response(JSON.stringify({ status: 'ignored', event_type: event.event_type }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const resource = event.resource || {};
    const txId = resource.id ? `paypal-${resource.id}` : `paypal-${Date.now()}`;

    // Orders API (v2) pakai resource.amount.value, classic Payments API pakai resource.amount.total
    const rawAmount = parseFloat(
      resource.amount?.value ?? resource.amount?.total ?? '0'
    );
    const currency = (resource.amount?.currency_code || resource.amount?.currency || 'USD').toUpperCase();

    // Nama donatur: Orders API (resource.payer.name) vs classic (resource.payer.payer_info)
    const nameFromOrdersApi = resource.payer?.name
      ? `${resource.payer.name.given_name || ''} ${resource.payer.name.surname || ''}`.trim()
      : '';
    const nameFromClassicApi = resource.payer?.payer_info
      ? `${resource.payer.payer_info.first_name || ''} ${resource.payer.payer_info.last_name || ''}`.trim()
      : '';
    const donor = nameFromOrdersApi || nameFromClassicApi || 'Donatur PayPal';

    if (!rawAmount || rawAmount <= 0) {
      return new Response(JSON.stringify({ error: 'Nominal donasi tidak valid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Progress bar selalu dalam USD. Kalau PayPal kirim currency lain (jarang, tapi jaga-jaga).
    const EXCHANGE_RATE = Number(env.EXCHANGE_RATE) || DEFAULT_EXCHANGE_RATE;
    const amountUSD = currency === 'USD'
      ? rawAmount
      : currency === 'IDR'
        ? Number((rawAmount / EXCHANGE_RATE).toFixed(2))
        : rawAmount; // currency lain: belum ada kurs, simpan apa adanya + tandai di currency_original

    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return new Response(JSON.stringify({ error: 'Supabase belum dikonfigurasi' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/donations`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify({
        amount: amountUSD,
        amount_original: rawAmount,
        currency_original: currency,
        source: 'paypal',
        donor,
        message: '',
        transaction_id: txId,
        raw_payload: event,
      }),
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text();
      console.error('Gagal simpan ke Supabase:', detail);
      return new Response(JSON.stringify({ error: 'Gagal menyimpan ke database', detail }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const inserted = await insertRes.json().catch(() => []);
    const isNew = Array.isArray(inserted) && inserted.length > 0;

    if (isNew && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const pesanTelegram =
        `🎉 *Donasi baru via PayPal!*\n\n` +
        `💰 *Nominal:* ${currency} ${rawAmount} (≈ $${amountUSD.toFixed(2)})\n` +
        `👤 *Donatur:* ${donor}\n` +
        `🆔 *ID:* \`${txId}\``;

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: pesanTelegram,
          parse_mode: 'Markdown',
        }),
      }).catch((err) => console.error('Gagal kirim Telegram:', err));
    }

    return new Response(JSON.stringify({ status: 'success', duplicate: !isNew }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    console.error('PayPal webhook error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
}
