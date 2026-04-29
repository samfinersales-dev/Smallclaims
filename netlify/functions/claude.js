// netlify/functions/claude.js — SmallClaims
//
// Generates state-specific small claims court documents from a paid checkout session.
// Payment-gated: requires a paid Stripe session_id whose payment_link is in this
// product's allowlist. No anonymous calls — prevents abuse as a free Claude proxy.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://smallclaimsforms.net',
  'https://www.smallclaimsforms.net',
];

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject overly-large bodies before doing any work
  if (event.body && event.body.length > 200_000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { prompt, sessionId } = body;

  if (!prompt || typeof prompt !== 'string' || prompt.length > 4000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid prompt' }) };
  }

  // ─── PAYMENT GATE ────────────────────────────────────────────────────────
  // Require a paid Stripe Checkout session whose payment_link is in this
  // product's allowlist. This is what makes the endpoint un-abusable as a
  // free general-purpose Claude proxy.
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return { statusCode: 402, headers, body: JSON.stringify({ error: 'Payment required' }) };
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (err.type === 'StripeInvalidRequestError') {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    console.error('[smallclaims-claude] stripe.retrieve error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }

  if (session.payment_status !== 'paid') {
    return { statusCode: 402, headers, body: JSON.stringify({ error: 'Payment not completed' }) };
  }

  // Cross-product allowlist (this Stripe account is shared across 5 products)
  const allowlist = (process.env.STRIPE_PLINK_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    if (!session.payment_link || !allowlist.includes(session.payment_link)) {
      console.log(
        `[smallclaims-claude] rejected — payment_link ${session.payment_link || '(none)'} ` +
        `not in allowlist; session=${sessionId.slice(0, 20)}`
      );
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Wrong product' }) };
    }
  } else {
    console.warn('[smallclaims-claude] STRIPE_PLINK_ALLOWLIST not set — accepting all paid sessions (UNSAFE)');
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[smallclaims-claude] ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // Abort the upstream call if it takes >22s, so we have time to send a clean
  // error response before Netlify's hard 26s function timeout kicks in.
  const upstreamCtrl = new AbortController();
  const upstreamTimer = setTimeout(() => upstreamCtrl.abort(), 22000);

  const startMs = Date.now();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: upstreamCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(upstreamTimer);

    const elapsedMs = Date.now() - startMs;
    const data = await response.json();

    if (!response.ok) {
      console.error('[smallclaims-claude] Anthropic error:', response.status, JSON.stringify(data).slice(0, 500), `elapsed=${elapsedMs}ms`);
      const errType = data?.error?.type || 'unknown';
      const errMsg = data?.error?.message || 'unknown error';
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Generation service temporarily unavailable. Please try again.',
          debug: { upstream_status: response.status, type: errType, message: errMsg.slice(0, 200), elapsed_ms: elapsedMs },
        }),
      };
    }

    console.log(`[smallclaims-claude] success elapsed=${elapsedMs}ms`);
    return { statusCode: 200, headers, body: JSON.stringify({ content: data.content }) };
  } catch (err) {
    clearTimeout(upstreamTimer);
    const elapsedMs = Date.now() - startMs;
    if (err.name === 'AbortError') {
      console.error('[smallclaims-claude] upstream timeout after', elapsedMs, 'ms');
      return {
        statusCode: 504,
        headers,
        body: JSON.stringify({
          error: 'Generation took too long. Please try again.',
          debug: { type: 'upstream_timeout', elapsed_ms: elapsedMs },
        }),
      };
    }
    console.error('[smallclaims-claude] error:', err.message, `elapsed=${elapsedMs}ms`);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Server error',
        debug: { type: err.name || 'unknown', message: (err.message || '').slice(0, 200), elapsed_ms: elapsedMs },
      }),
    };
  }
};
