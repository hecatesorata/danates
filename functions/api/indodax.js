// Helper HMAC-SHA512 Web Crypto API
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
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { env } = context;
  
  try {
    const result = await processIndodaxDeposits(env);
    return new Response(JSON.stringify({ status: "success", detail: result }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

async function processIndodaxDeposits(env) {
  // Bersihkan spasi atau karakter newline tak sengaja dari env
  const apiKey = (env.INDODAX_API_KEY || '').trim();
  const secretKey = (env.INDODAX_SECRET_KEY || '').trim();
  const supabaseUrl = (env.SUPABASE_URL || '').trim();
  const supabaseServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!apiKey || !secretKey || !supabaseUrl || !supabaseServiceKey) {
    throw new Error("Environment variables belum lengkap di Cloudflare!");
  }

  // Waktu timestamp server dalam milidetik
  const timestamp = Date.now();
  
  // Buat query string untuk Trade API Indodax
  const bodyParams = new URLSearchParams();
  bodyParams.append('method', 'transHistory');
  bodyParams.append('timestamp', timestamp.toString());

  const bodyString = bodyParams.toString();
  const signature = await generateHmacSha512(secretKey, bodyString);

  const response = await fetch('https://indodax.com/tapi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Key': apiKey,
      'Sign': signature
    },
    body: bodyString
  });

  const result = await response.json();

  if (result.success !== 1) {
    throw new Error("Gagal mengambil data Indodax: " + (result.error || JSON.stringify(result)));
  }

  const deposits = result.return.deposit || {};
  const IDR_TO_USD_RATE = parseFloat(env.EXCHANGE_RATE || '0.000064');

  const existingRes = await fetch(`${supabaseUrl}/rest/v1/donations?platform=eq.Indodax&select=transaction_id`, {
    headers: {
      'apikey': supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`
    }
  });
  
  const existingData = await existingRes.json();
  const processedTxIds = new Set((existingData || []).map(item => item.transaction_id));

  let addedCount = 0;

  for (const currency in deposits) {
    const list = deposits[currency] || [];
    
    for (const tx of list) {
      if (tx.status !== 'success' && tx.status !== 'done') continue;

      const txId = `INDODAX-${tx.deposit_id || tx.txid || tx.type + '-' + tx.submit_time}`;
      if (processedTxIds.has(txId)) continue;

      let rawAmount = parseFloat(tx.amount || 0);
      let amountInUSD = currency.toLowerCase() === 'rp' ? rawAmount * IDR_TO_USD_RATE : rawAmount;

      if (amountInUSD <= 0) continue;

      const insertRes = await fetch(`${supabaseUrl}/rest/v1/donations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          amount: amountInUSD.toFixed(2),
          donor_name: 'Donatur Indodax',
          platform: 'Indodax',
          transaction_id: txId
        })
      });

      if (insertRes.ok) {
        addedCount++;
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          const message = `🎉 *Donasi Baru via Indodax!*\n💰 Jumlah: $${amountInUSD.toFixed(2)} (${rawAmount} ${currency.toUpperCase()})\n🆔 ID: \`${txId}\``;
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: 'Markdown'
            })
          });
        }
      }
    }
  }

  return `Selesai. ${addedCount} transaksi baru ditambahkan.`;
}
