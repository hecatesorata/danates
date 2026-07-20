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
      const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

      // Kirim data langsung ke REST API Supabase menggunakan fetch bawaan
      const response = await fetch(`${supabaseUrl}/rest/v1/donations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          order_id: orderId,
          amount: amount,
          currency: currency,
          donor: payerEmail
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Gagal simpan ke Supabase:', errText);
        return new Response(JSON.stringify({ error: errText }), { status: 500 });
      }

      return new Response(JSON.stringify({ success: true, message: 'Webhook tercatat di Supabase' }), { 
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
