export async function onRequestPost({ request, env }) {
  try {
    const event = await request.json();

    // Periksa apakah event dari PayPal adalah pembayaran selesai (Checkout Order Completed / Sale Completed)
    if (event.event_type === 'PAYMENT.SALE.COMPLETED' || event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const resource = event.resource;
      
      // Ambil nominal dan mata uang dari transaksi PayPal
      const amount = resource.amount ? parseFloat(resource.amount.total || resource.amount.value) : 0;
      const donorName = resource.payer?.name ? `${resource.payer.name.given_name} ${resource.payer.name.surname}` : 'Donatur PayPal';

      // Masukkan data ke database Supabase Anda menggunakan REST API
      const supabaseResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/donations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': env.SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          donor_name: donorName,
          amount: amount,
          platform: 'paypal',
          created_at: new Date().toISOString()
        })
      });

      if (!supabaseResponse.ok) {
        throw new Error('Gagal menyimpan ke database Supabase');
      }
    }

    return new Response(JSON.stringify({ status: 'success' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
}
