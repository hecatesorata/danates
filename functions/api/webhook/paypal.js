import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
  try {
    // 1. Ambil data JSON yang dikirim oleh PayPal
    const event = await context.request.json();

    // 2. Cek apakah jenis event adalah pembayaran sukses
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const resource = event.resource;
      
      const orderId = resource.id;
      const amount = resource.amount.value;
      const currency = resource.amount.currency_code;
      // Ambil email atau nama pembayar (jika ada)
      const payerEmail = resource.payer?.email_address || 'Anonymous';

      // 3. Inisialisasi Supabase menggunakan Environment Variables Cloudflare
      const supabase = createClient(
        context.env.SUPABASE_URL,
        context.env.SUPABASE_SERVICE_ROLE_KEY
      );

      // 4. Masukkan data ke tabel Supabase (sesuaikan nama tabel Anda, misal: donations)
      const { data, error } = await supabase
        .from('donations')
        .insert([
          { 
            order_id: orderId, 
            amount: amount, 
            currency: currency, 
            donor: payerEmail 
          }
        ]);

      if (error) {
        console.error('Gagal simpan ke Supabase:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }

      return new Response(JSON.stringify({ success: true, message: 'Webhook tercatat di Supabase' }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Untuk event lain dari PayPal yang belum ditangani
    return new Response(JSON.stringify({ received: true }), { status: 200 });

  } catch (err) {
    console.error('Error memproses webhook:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
}
