// netlify/functions/verify-payment.js
// Verifies a Stripe Checkout session is paid before allowing content generation.
// The front-end passes session_id (from Stripe's success URL) and this function
// confirms with Stripe's API that the session was actually paid.
//
// Usage from front-end:
//   const r = await fetch('/.netlify/functions/verify-payment', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ session_id: '...' })
//   });
//   const data = await r.json();
//   if (data.paid) { /* show content */ }

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async function(event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON' });
  }

  const { session_id } = body;

  if (!session_id || typeof session_id !== 'string') {
    return jsonResponse(400, { paid: false, error: 'Missing session_id' });
  }

  // Reject obviously fake session IDs (must start with cs_)
  if (!session_id.startsWith('cs_')) {
    return jsonResponse(400, { paid: false, error: 'Invalid session format' });
  }

  try {
    // Ask Stripe: is this a real, paid checkout session?
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      return jsonResponse(200, {
        paid: true,
        customer_email: session.customer_details?.email || null,
        amount: session.amount_total,
        currency: session.currency,
      });
    } else {
      return jsonResponse(403, {
        paid: false,
        error: 'Session exists but payment not completed',
        status: session.payment_status,
      });
    }
  } catch (err) {
    // Stripe throws if session_id doesn't exist at all
    if (err.type === 'StripeInvalidRequestError') {
      return jsonResponse(403, {
        paid: false,
        error: 'Session not found — payment not verified',
      });
    }
    console.error('verify-payment error:', err);
    return jsonResponse(500, { paid: false, error: 'Server error' });
  }
};
