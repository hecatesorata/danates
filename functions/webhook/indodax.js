// Cloudflare Pages Function
// Route: GET /webhook/indodax  (dipicu cron eksternal, BUKAN webhook asli —
// Indodax gak nyediain webhook buat deposit masuk, jadi ini harus di-poll)
//
// Cara kerja:
//   1. Panggil Private REST API Indodax (method transHistory) buat ambil
//      daftar deposit 7 hari terakhir.
//   2. Convert tiap deposit ke USD:
//        - Deposit IDR      -> amount_usd = idr / EXCHANGE_RATE
//        - Deposit crypto   -> ambil harga terakhir dari ticker publik Indodax
//                               (coin_idr), lalu idr_value / EXCHANGE_RATE
//   3. Cek transaction_id yang udah ada di Supabase, skip yang udah pernah masuk.
//   4. Insert yang baru + kirim notifikasi Telegram.
//
// Endpoint ini dilindungi CRON_SECRET (query param ?token=... atau header
// X-Cron-Secret) supaya gak bisa dipanggil sembarangan orang dari luar.
//
// Env vars:
//   INDODAX_API_KEY
//   INDODAX_SECRET_KEY        (butuh permission "view" di Indodax Trade API)
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   EXCHANGE_RATE              (kurs IDR per 1 USD, misal 16300)
//   CRON_SECRET                (token rahasia buat proteksi endpoint ini)
//   TELEGRAM_BOT_TOKEN         (opsional)
//   TELEGRAM_CHAT_ID           (opsional)

const DEFAULT_EXCHANGE_RATE = 16300;

export async function onRequestGet(context) {
  return handleSync(context);
}

export async function onRequestPost(context) {
  return handleSync(context);
}

async function handleSync({ request, env }) {
  // --- Proteksi endpoint ---
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('token') || request.headers.get('x-cron-secret') || '';
  if (env.CRON_SECRET && providedSecret !== env.CRON_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const apiKey = (env.INDODAX_API_KEY || '').trim();
  const secretKey = (env.INDODAX_SECRET_KEY || '').trim();
  const supabaseUrl = (env.SUPABASE_URL || '').trim();
  const supabaseServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const EXCHANGE_RATE = Number(env.EXCHANGE_RATE) || DEFAULT_EXCHANGE_RATE;

  if (!apiKey || !secretKey || !supabaseUrl || !supabaseServiceKey) {
    return jsonResponse({ error: 'Environment variables belum lengkap di Cloudflare!' }, 500);
  }

  try {
    const deposits = await fetchIndodaxDeposits(apiKey, secretKey);

    // Ambil transaction_id yang udah pernah tersimpan, buat cegah duplikat.
    const existingRes = await fetch(
      `${supabaseUrl}/rest/v1/donations?source=eq.indodax&select=transaction_id`,
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      }
    );
    const existingData = existingRes.ok ? await existingRes.json() : [];
    const processedTxIds = new Set(
      Array.isArray(existingData) ? existingData.map((r) => r.transaction_id).filter(Boolean) : []
    );

    const tickerCache = new Map(); // cache harga per koin biar gak fetch berkali-kali dalam 1 run
    let addedCount = 0;
    const addedSummaries = [];

    for (const currency in deposits) {
      const list = deposits[currency] || [];

      for (const tx of list) {
        if (tx.status !== 'success' && tx.status !== 'done') continue;

        const txId = `indodax-${currency}-${tx.deposit_id || tx.tx || tx.submit_time}`;
        if (processedTxIds.has(txId)) continue;

        const rawAmount = parseFloat(tx.amount || tx.rp || 0);
        if (rawAmount <= 0) continue;

        let idrValue;
        if (currency.toLowerCase() === 'idr') {
          idrValue = rawAmount;
        } else {
          const lastPrice = await getCoinPriceInIdr(currency, tickerCache);
          if (lastPrice === null) {
            // Gak nemu harga koin ini (mungkin delisted/typo pair) — skip drpd salah hitung.
            console.warn(`Gak nemu harga ticker buat koin ${currency}, deposit ${txId} dilewati`);
            continue;
          }
          idrValue = rawAmount * lastPrice;
        }

        const amountUSD = Number((idrValue / EXCHANGE_RATE).toFixed(2));
        if (amountUSD <= 0) continue;

        const insertRes = await fetch(`${supabaseUrl}/rest/v1/donations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            Prefer: 'return=minimal,resolution=ignore-duplicates',
          },
          body: JSON.stringify({
            amount: amountUSD,
            amount_original: rawAmount,
            currency_original: currency.toUpperCase(),
            source: 'indodax',
            donor: 'Donatur Indodax',
            message: '',
            transaction_id: txId,
            raw_payload: tx,
          }),
        });

        if (insertRes.ok) {
          addedCount++;
          addedSummaries.push({ txId, amountUSD, rawAmount, currency: currency.toUpperCase() });

          if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
            const message =
              `🎉 *Donasi Baru via Indodax!*\n` +
              `💰 Nominal: $${amountUSD.toFixed(2)} (${rawAmount} ${currency.toUpperCase()})\n` +
              `🆔 ID: \`${txId}\``;
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'Markdown',
              }),
            }).catch((err) => console.error('Gagal kirim Telegram:', err));
          }
        }
      }
    }

    return jsonResponse({ status: 'success', new_transactions: addedCount, details: addedSummaries }, 200);
  } catch (err) {
    console.error('Indodax sync error:', err);
    return jsonResponse({ status: 'error', message: err.message }, 500);
  }
}

async function fetchIndodaxDeposits(apiKey, secretKey) {
  const timestamp = Date.now();
  const bodyParams = new URLSearchParams();
  bodyParams.append('method', 'transHistory');
  bodyParams.append('timestamp', timestamp.toString());

  const bodyString = bodyParams.toString();
  const signature = await generateHmacSha512(secretKey, bodyString);

  const response = await fetch('https://indodax.com/tapi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Key: apiKey,
      Sign: signature,
    },
    body: bodyString,
  });

  const result = await response.json();

  if (result.success !== 1) {
    throw new Error('Gagal mengambil data Indodax: ' + (result.error || JSON.stringify(result)));
  }

  return result.return.deposit || {};
}

// Ambil harga terakhir koin dalam IDR dari ticker publik Indodax (gak butuh auth).
// https://indodax.com/api/{pair}/ticker
async function getCoinPriceInIdr(coin, cache) {
  const key = coin.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await fetch(`https://indodax.com/api/${key}_idr/ticker`);
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    const data = await res.json();
    const last = parseFloat(data?.ticker?.last);
    const price = Number.isFinite(last) && last > 0 ? last : null;
    cache.set(key, price);
    return price;
  } catch (err) {
    cache.set(key, null);
    return null;
  }
}

async function generateHmacSha512(secretKey, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
