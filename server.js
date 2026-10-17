// =====================================================================
//  PayCheck server
//
//  What it does:
//   1. Shows the website (everything in the "public" folder)
//   2. /api/analyze  - sends the user's message or photo to Claude, which
//                      works out what they want and replies in a fixed format
//   3. /api/rate     - Wise's live exchange rate (needs a Wise token)
//   4. /api/compare  - Wise's comparison of providers (needs a Wise token)
//
//  Secret keys live in the .env file, never in the website code.
//  If a key is missing, that route says "not available" and the website
//  quietly uses its built-in checker or the free European Central Bank rate.
// =====================================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const WISE_TOKEN = process.env.WISE_API_TOKEN;
const WISE_BASE = process.env.WISE_SANDBOX === 'true'
  ? 'https://api.sandbox.transferwise.tech'
  : 'https://api.wise.com';

const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

app.use(express.json({ limit: '8mb' }));  // photos can be large
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
//  The instructions Claude follows
// ---------------------------------------------------------------------
const INSTRUCTIONS = `You are the checking engine inside PayCheck, a website that helps people
(often students and people new to a country) check a payment before they make it.

Read the user's message and any photo, then reply with ONE result:

- "convert": they want to know what an amount is worth in another currency.
  Fill amount, from and to. If they don't say the target currency, use their home currency.
- "rate_check": they were offered an exchange rate (airport, bank, exchange shop, a rate board in a photo)
  and want to know if it's fair. Fill amount, from, to, offeredRate and fee.
  offeredRate means: 1 unit of "from" buys offeredRate units of "to".
  If no amount is given, use 100. If no fee is mentioned, use 0.
- "scam_check": they pasted or photographed a message, invoice, listing or payment request.
  Decide a verdict: "safe" (no warning signs), "caution" (some signs, check first) or "danger" (clear scam signs).
  List each warning sign you found in "reasons" (short, plain English, one sentence each).
  Give 2 to 4 short practical steps in "advice". In the UK, people who think they've been scammed can call 159.
- "message": anything else, or if you need more information. Put a short, friendly reply in "text".

Rules:
- Never do exchange-rate maths yourself. Only extract the numbers; the website calculates everything.
- Currencies must be 3-letter ISO codes in capitals (GBP, EUR, USD...).
- Use plain, simple English. Many users are not confident with money or English.
- Fields that don't apply to the result type: use null for numbers and text, "none" for verdict, [] for lists.`;

// The exact shape Claude must reply in (structured output)
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'amount', 'from', 'to', 'offeredRate', 'fee', 'verdict', 'reasons', 'advice', 'text'],
  properties: {
    type: { type: 'string', enum: ['convert', 'rate_check', 'scam_check', 'message'] },
    amount: { type: ['number', 'null'] },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    offeredRate: { type: ['number', 'null'] },
    fee: { type: ['number', 'null'] },
    verdict: { type: 'string', enum: ['safe', 'caution', 'danger', 'none'] },
    reasons: { type: 'array', items: { type: 'string' } },
    advice: { type: 'array', items: { type: 'string' } },
    text: { type: ['string', 'null'] },
  },
};

const MODE_HINTS = {
  auto: 'The user has not chosen a check. Work out which one they need.',
  convert: 'The user chose "Convert".',
  rate: 'The user chose "Rate check".',
  scam: 'The user chose "Scam check".',
};

// ---------------------------------------------------------------------
//  /api/analyze
// ---------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  if (!claude) return res.status(503).json({ error: 'AI not set up: add ANTHROPIC_API_KEY to .env' });

  const { text = '', image = null, homeCurrency = 'GBP', mode = 'auto' } = req.body || {};
  const content = [];

  // Photo, sent by the website as "data:image/jpeg;base64,...."
  if (image) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(image);
    if (!match) return res.status(400).json({ error: 'Unsupported image' });
    content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }

  content.push({
    type: 'text',
    text: `Home currency: ${homeCurrency}\n${MODE_HINTS[mode] || MODE_HINTS.auto}\n\nUser's message:\n${text || '(no text, see the photo)'}`,
  });

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const result = cleanResult(JSON.parse(textBlock.text));
    res.json(result);
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(502).json({ error: 'The AI check failed' });
  }
});

// Makes sure the website only gets sensible values
function cleanResult(r) {
  const code = (c) => (typeof c === 'string' && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : null);
  const num = (n) => (typeof n === 'number' && isFinite(n) && n >= 0 ? n : null);

  if (r.type === 'convert' && num(r.amount) && code(r.from) && code(r.to)) {
    return { type: 'convert', amount: r.amount, from: code(r.from), to: code(r.to) };
  }
  if (r.type === 'rate_check' && num(r.offeredRate) && code(r.from) && code(r.to)) {
    return {
      type: 'rate_check',
      amount: num(r.amount) || 100,
      from: code(r.from),
      to: code(r.to),
      offeredRate: r.offeredRate,
      fee: num(r.fee) || 0,
    };
  }
  if (r.type === 'scam_check') {
    return {
      type: 'scam_check',
      verdict: ['safe', 'caution', 'danger'].includes(r.verdict) ? r.verdict : 'caution',
      reasons: (r.reasons || []).slice(0, 8),
      advice: (r.advice || []).slice(0, 5),
    };
  }
  return { type: 'message', text: r.text || "I couldn't work that out. Try including an amount, a rate, or the message you want checked." };
}

// ---------------------------------------------------------------------
//  Wise: live rate and provider comparison
// ---------------------------------------------------------------------
async function wiseGet(url) {
  const res = await fetch(`${WISE_BASE}${url}`, {
    headers: { Authorization: `Bearer ${WISE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Wise replied ${res.status}`);
  return res.json();
}

const isCode = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c);

app.get('/api/rate', async (req, res) => {
  const { from, to } = req.query;
  if (!WISE_TOKEN) return res.status(404).json({ error: 'No Wise token' });
  if (!isCode(from) || !isCode(to)) return res.status(400).json({ error: 'Bad currency' });

  try {
    const data = await wiseGet(`/v1/rates?source=${from}&target=${to}`);
    const latest = Array.isArray(data) ? data[0] : data;
    res.json({ rate: latest.rate, date: latest.time });
  } catch (err) {
    console.error('Wise rate error:', err.message);
    res.status(502).json({ error: 'Wise rate unavailable' });
  }
});

app.get('/api/compare', async (req, res) => {
  const { from, to } = req.query;
  const amount = parseFloat(req.query.amount);
  if (!WISE_TOKEN) return res.status(404).json({ error: 'No Wise token' });
  if (!isCode(from) || !isCode(to) || !(amount > 0)) return res.status(400).json({ error: 'Bad request' });

  try {
    const data = await wiseGet(`/v3/comparisons/?sourceCurrency=${from}&targetCurrency=${to}&sendAmount=${amount}`);
    const providers = (data.providers || [])
      .filter((p) => p.quotes && p.quotes.length)
      .map((p) => ({
        name: p.name,
        rate: p.quotes[0].rate,
        fee: p.quotes[0].fee,
        received: p.quotes[0].receivedAmount,
      }))
      .filter((p) => typeof p.received === 'number')
      .slice(0, 6);
    res.json({ providers });
  } catch (err) {
    console.error('Wise compare error:', err.message);
    res.status(502).json({ error: 'Wise comparison unavailable' });
  }
});

// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`PayCheck is running at http://localhost:${PORT}`);
  console.log(`AI: ${claude ? `on (${MODEL})` : 'off, add ANTHROPIC_API_KEY to .env'}`);
  console.log(`Wise data: ${WISE_TOKEN ? `on (${WISE_BASE})` : 'off, using example fees and ECB rates'}`);
});