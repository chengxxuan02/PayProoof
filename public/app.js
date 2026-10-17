// =====================================================================
//  PayProoof - frontend logic
//
//  Sections in this file:
//   1. The checker (mode buttons, examples, photos, sending messages)
//   2. TEMPORARY replies (replaced in Stage 5)
//   3. Helpers for showing messages and cards
//   4. Accessibility settings
//   5. Visual effects (banknote lens, scrolling coin)
// =====================================================================

const BACKEND_URL = '/api/analyze';

// ---------- Find the parts of the page we need ----------
const chat = document.getElementById('chat');
const welcome = document.getElementById('welcome');
const form = document.getElementById('composer');
const input = document.getElementById('messageInput');
const imageInput = document.getElementById('imageInput');
const preview = document.getElementById('imagePreview');
const previewImg = document.getElementById('previewImg');
const removeImageBtn = document.getElementById('removeImage');
const homeSelect = document.getElementById('homeCurrency');
const modeButtons = document.querySelectorAll('.mode');

let currentMode = 'auto';
let currentImage = null; // the attached photo

const PLACEHOLDERS = {
  auto: 'Type an amount, a rate or paste a message',
  convert: 'For example: How much is €250?',
  rate: 'For example: They offered 1.05 euros per pound for £300',
  scam: 'Paste the message or payment request here',
};

// =====================================================================
//  1. The checker
// =====================================================================

// ---------- Mode buttons ----------
modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-checked', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
    currentMode = btn.dataset.mode;
    input.placeholder = PLACEHOLDERS[currentMode];
    input.focus();
  });
});

// ---------- Example buttons ----------
document.querySelectorAll('.example').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.text;
    form.requestSubmit();
  });
});

// ---------- Photo upload ----------
// Phone photos are huge, so we shrink them before sending them to the AI
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      currentImage = canvas.toDataURL('image/jpeg', 0.85);
      previewImg.src = currentImage;
      preview.classList.remove('hidden');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

removeImageBtn.addEventListener('click', clearImage);

function clearImage() {
  currentImage = null;
  imageInput.value = '';
  preview.classList.add('hidden');
}

// ---------- When the user presses Check ----------
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  const image = currentImage;
  if (!text && !image) {
    input.focus();
    return;
  }

  if (welcome && welcome.isConnected) welcome.remove();
  addUserMessage(text, image);
  input.value = '';
  clearImage();

  const loading = addLoading();
  try {
    const result = await analyse(text, image);
    result.userText = text;
    const html = await renderResult(result);
    loading.remove();
    addBotCard(html);
  } catch (err) {
    console.error(err);
    loading.remove();
    addBotCard(messageCard("Today's exchange rate didn't load. Wait a moment and try again."));
  }
});

// =====================================================================
//  2. Working out what the user wants, and showing the answer
// =====================================================================

async function analyse(text, image) {
  const homeCurrency = homeSelect.value;

  // Ask the AI backend first (the server from Stage 8)
  try {
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, image, homeCurrency, mode: currentMode }),
    });
    if (res.ok) return await res.json();
  } catch (e) {
    // No backend running, so we use the built-in checker below
  }

  // No AI: read any text in the photo with Tesseract (free, runs in the browser)
  if (image) {
    const photoText = await readPhotoText(image);
    if (!photoText && !text) {
      return { type: 'message', text: "I couldn't find any text in that photo. Try a clearer, closer photo, or type what it says." };
    }
    text = `${text} ${photoText}`.trim();
  }
  return localAnalyse(text, homeCurrency, currentMode);
}

// Reads the text in a photo. Tesseract downloads its reading data the first
// time, so the first photo takes a few seconds longer.
let photoReader = null;
async function readPhotoText(image) {
  if (!window.Tesseract) return '';
  try {
    if (!photoReader) photoReader = await Tesseract.createWorker('eng');
    const { data } = await photoReader.recognize(image);
    return data.text.replace(/\s+/g, ' ').trim();
  } catch (err) {
    console.error('Photo reading failed:', err);
    return '';
  }
}

// ---------- Built-in checker (works without the AI) ----------

function localAnalyse(text, home, mode) {
  const scamReasons = SCAM_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.reason);
  const rateOffer = parseRateOffer(text);
  const amounts = findAmounts(text);

  // Scam check
  if (mode === 'scam' || (mode === 'auto' && scamReasons.length && !rateOffer)) {
    const verdict = scamReasons.length === 0 ? 'safe' : scamReasons.length === 1 ? 'caution' : 'danger';
    return { type: 'scam_check', verdict, reasons: scamReasons };
  }

  // Rate check
  if (mode === 'rate' || (mode === 'auto' && rateOffer)) {
    if (!rateOffer) {
      return { type: 'message', text: 'Tell me the rate you were offered and the amount, for example: "1.05 euros per pound for £300".' };
    }
    return rateOffer;
  }

  // Convert
  if (amounts.length) {
    const first = amounts[0];
    let to = findTarget(text) || home;
    if (to === first.currency) to = first.currency === home ? (home === 'EUR' ? 'GBP' : 'EUR') : home;
    return { type: 'convert', amount: first.value, from: first.currency, to };
  }

  return { type: 'message', text: 'Include an amount and a currency, for example "How much is €250?", or paste a message to check it for scams.' };
}

// ---------- Understanding currencies in normal writing ----------

// Currencies the live rate service supports
const SUPPORTED = ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'INR',
  'JPY', 'MXN', 'MYR', 'PHP', 'SAR', 'SEK', 'SGD', 'THB', 'USD', 'ZAR'];

// Words and symbols people use for each currency
const CURRENCY_WORDS = {
  '£': 'GBP', pound: 'GBP', pounds: 'GBP', gbp: 'GBP', quid: 'GBP', sterling: 'GBP',
  '€': 'EUR', euro: 'EUR', euros: 'EUR', eur: 'EUR',
  '$': 'USD', dollar: 'USD', dollars: 'USD', usd: 'USD',
  '¥': 'JPY', yen: 'JPY', jpy: 'JPY',
  '₹': 'INR', rupee: 'INR', rupees: 'INR', inr: 'INR',
  '₱': 'PHP', php: 'PHP',
  yuan: 'CNY', rmb: 'CNY', cny: 'CNY', renminbi: 'CNY',
  dirham: 'AED', dirhams: 'AED', aed: 'AED',
  riyal: 'SAR', riyals: 'SAR', sar: 'SAR',
  ringgit: 'MYR', myr: 'MYR',
  krona: 'SEK', kronor: 'SEK', sek: 'SEK',
  franc: 'CHF', francs: 'CHF', chf: 'CHF',
  baht: 'THB', thb: 'THB', rand: 'ZAR', zar: 'ZAR', reais: 'BRL', brl: 'BRL',
  aud: 'AUD', cad: 'CAD', sgd: 'SGD', hkd: 'HKD', mxn: 'MXN',
};

function toCode(token) {
  if (!token) return null;
  const word = token.toLowerCase();
  if (CURRENCY_WORDS[word]) return CURRENCY_WORDS[word];
  // Only accept a 3-letter code in capitals, so the word "try" isn't read as Turkish lira
  if (token === token.toUpperCase() && SUPPORTED.includes(token)) return token;
  return null;
}

const toNum = (s) => parseFloat(String(s).replace(/,/g, ''));

// Finds amounts like "£300", "250 euros" or "EUR 40"
function findAmounts(text) {
  const found = [];
  for (const m of text.matchAll(/([£€$¥₹₱])\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    found.push({ value: toNum(m[2]), currency: toCode(m[1]), index: m.index });
  }
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?([A-Za-zł]+)/g)) {
    const code = toCode(m[2]);
    if (code) found.push({ value: toNum(m[1]), currency: code, index: m.index });
  }
  for (const m of text.matchAll(/\b([A-Z]{3})\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const code = toCode(m[1]);
    if (code) found.push({ value: toNum(m[2]), currency: code, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

// Finds the currency to convert into: "in pounds", "to USD", "into euros"
function findTarget(text) {
  for (const m of text.matchAll(/\b(?:in|into|to)\s+([A-Za-zł£€$¥₹₱]+)/gi)) {
    const code = toCode(m[1]);
    if (code) return code;
  }
  return null;
}

// Finds an exchange rate someone was offered, e.g. "1.02 euros per pound"
function parseRateOffer(text) {
  let offeredRate = null, from = null, to = null, matched = '';

  // "1.02 euros per pound", "1.02 EUR for each GBP"
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([A-Za-z€$£¥₹₱]+)\s*(?:per|for each|for every|for one|for a|for 1|to the|to a|to 1|=)\s*(?:1\s*)?([A-Za-z€$£¥₹₱]+)/gi)) {
    const t = toCode(m[2]), f = toCode(m[3]);
    if (t && f && t !== f) { offeredRate = toNum(m[1]); to = t; from = f; matched = m[0]; break; }
  }

  // "£1 = €1.05" or "1 GBP = 1.05 EUR"
  if (!offeredRate) {
    const m = text.match(/([£€$¥₹₱]|[A-Z]{3})\s?1\s*=\s*([£€$¥₹₱]|[A-Z]{3})?\s?(\d+(?:\.\d+)?)\s*([A-Z]{3})?/);
    if (m) { from = toCode(m[1]); to = toCode(m[2] || m[4]); offeredRate = toNum(m[3]); matched = m[0]; }
  }

  // "1 pound = 0.98 euro", "1 GBP = 1.10 EUR", "1 pound gets you 1.05 euros"
  if (!offeredRate) {
    const m = text.match(/\b1\s*([A-Za-z€$£¥₹₱]+)\s*(?:=|is|gets?(?: you)?|buys?)\s*([€$£¥₹₱])?\s?(\d+(?:\.\d+)?)\s*([A-Za-z]+)?/i);
    if (m) {
      const f = toCode(m[1]), t = toCode(m[2] || m[4]);
      if (f && t && f !== t) { from = f; to = t; offeredRate = toNum(m[3]); matched = m[0]; }
    }
  }

  // "rate of 1.05" + "£300 to euros"
  if (!offeredRate) {
    const m = text.match(/rate\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)/i);
    const amounts = findAmounts(text.replace(m ? m[0] : '', ' '));
    if (m && amounts.length) {
      offeredRate = toNum(m[1]); from = amounts[0].currency; to = findTarget(text); matched = m[0];
    }
  }

  if (!offeredRate || !from || !to || from === to) return null;

  let rest = text.replace(matched, ' ');
  const fee = parseFee(rest);
  // Remove the fee so it isn't mistaken for the amount
  rest = rest.replace(/(?:fee|commission|charge)\D{0,15}?\d+(?:\.\d+)?|[£€$¥₹₱]?\d+(?:\.\d+)?\s*(?:[A-Za-z]+\s)?(?:fee|commission)/i, ' ');
  const amounts = findAmounts(rest);
  const inFrom = amounts.find((a) => a.currency === from);
  const inTo = amounts.find((a) => a.currency === to);
  let amount = 100;
  if (inFrom) amount = inFrom.value;
  else if (inTo) amount = inTo.value / offeredRate;

  return { type: 'rate_check', amount, from, to, offeredRate, fee };
}

function parseFee(text) {
  const m = text.match(/(?:fee|commission|charge)\D{0,15}?(\d+(?:\.\d+)?)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:[A-Za-z]+\s)?(?:fee|commission)/i);
  return m ? toNum(m[1]) : 0;
}

// ---------- Scam warning signs ----------

const SCAM_RULES = [
  { re: /urgent|immediately|right now|today only|within \d* ?hours?|asap|last chance/i,
    reason: "Pressure to pay quickly. Scammers rush you so you don't stop to check." },
  { re: /(bank|account|payment) details (have )?(changed|been updated|updated)|new (bank )?account|changed (our|my|their) (bank|account)/i,
    reason: 'Says the bank details have changed. This is one of the most common invoice and landlord scams.' },
  { re: /deposit|holding fee|secure the (flat|room|property|house)|before (the )?viewing|without (a )?viewing/i,
    reason: 'Asks for a deposit to "secure" a place. Fake rental listings often do this before you\'ve seen it.' },
  { re: /gift ?cards?|itunes|steam card|crypto|bitcoin|usdt/i,
    reason: 'Asks for gift cards or crypto. Real companies and landlords never ask for these.' },
  { re: /overpa(id|yment)|refund the difference|sent (you )?too much/i,
    reason: 'An "overpayment" refund request. A classic trick to get you to send money back.' },
  { re: /verify your (account|identity|details)|account (will be )?(suspended|locked|closed)|click (the|this) link/i,
    reason: 'Threatens your account or asks you to click a link to "verify".' },
  { re: /(hmrc|police|home office|visa|tax).{0,60}(fine|arrest|deport|penalty)|(fine|arrest|deport|penalty).{0,60}(hmrc|police|home office|visa|tax)/i,
    reason: "Claims to be an authority threatening fines, arrest or your visa. Real authorities don't demand payment by message." },
  { re: /don'?t tell|keep (this|it) (secret|between us)|confidential/i,
    reason: 'Asks you to keep it secret. A big warning sign.' },
  { re: /western union|moneygram|friends and family/i,
    reason: 'Asks for a payment method with no protection if something goes wrong.' },
  { re: /(mum|mom|dad).{0,40}new (phone|number)|new (phone|number).{0,40}(mum|mom|dad)/i,
    reason: '"New number" family message. A common impersonation scam.' },
];

// ---------- Live exchange rates ----------
// 1. Wise's rate, through our server (if it has a Wise token)
// 2. Otherwise, the European Central Bank rate from Frankfurter
async function getRate(from, to) {
  if (from === to) return { rate: 1, date: new Date().toISOString(), source: 'none' };
  if (!SUPPORTED.includes(from) || !SUPPORTED.includes(to)) {
    throw new Error(`Unsupported currency: ${from} or ${to}`);
  }

  try {
    const res = await fetch(`/api/rate?from=${from}&to=${to}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rate) return { rate: data.rate, date: data.date, source: 'Wise' };
    }
  } catch (e) {
    // No server
  }

  const res = await fetch(`https://api.frankfurter.dev/v2/rate/${from.toLowerCase()}/${to.toLowerCase()}`);
  if (!res.ok) throw new Error(`Frankfurter replied ${res.status}`);
  const data = await res.json();
  if (!data.rate) throw new Error('No rate in the reply');
  return { rate: data.rate, date: data.date, source: 'Frankfurter' };
}

// =====================================================================
//  Result cards
// =====================================================================

// The AI may say green/amber/red; the page uses safe/caution/danger
function normaliseVerdict(v) {
  return { green: 'safe', amber: 'caution', red: 'danger' }[v] || (['safe', 'caution', 'danger'].includes(v) ? v : 'caution');
}

const VERDICT_ICON = { safe: 'i-safe', caution: 'i-caution', danger: 'i-danger' };

function verdictBadge(verdict, label) {
  return `<span class="verdict ${verdict}"><svg aria-hidden="true"><use href="#${VERDICT_ICON[verdict]}"/></svg>${label}</span>`;
}

async function renderResult(result) {
  switch (result.type) {
    case 'convert': return renderConvert(result);
    case 'rate_check': return renderRate(result);
    case 'scam_check': return renderScam(result);
    default: return messageCard(result.text || "I couldn't understand that. Try including an amount, like €250.");
  }
}

function wiseLink(from, to, amount) {
  const url = `https://wise.com/gb/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate?amount=${Math.round(amount * 100) / 100}`;
  return `<a class="card-link" href="${url}" target="_blank" rel="noopener">See this conversion on Wise</a>`;
}

// ---------- Convert ----------
async function renderConvert({ amount, from, to }) {
  const { rate, date, source } = await getRate(from, to);
  const converted = amount * rate;

  return `
    <div class="card">
      <div class="convert-visual" aria-hidden="true">
        <span class="coin-chip">${from}</span>
        <svg viewBox="0 0 40 20"><path d="M2 10h34m-8-7l8 7-8 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="coin-chip to">${to}</span>
      </div>
      <div class="card-label">${money(amount, from)} is worth</div>
      <div class="big">${money(converted, to)}</div>
      <div class="rows">
        <div class="row"><span>Exchange rate</span><span>1 ${from} = ${rate.toFixed(4)} ${to}</span></div>
        <div class="row"><span>The other way</span><span>1 ${to} = ${(1 / rate).toFixed(4)} ${from}</span></div>
      </div>
      <p class="note-small">This is the mid-market rate, the fairest rate there is. Banks and exchange desks usually give you less.</p>
      ${wiseLink(from, to, amount)}
      <div class="meta">Mid-market rate from ${source}, ${formatDate(date)}</div>
    </div>`;
}

// ---------- Rate check ----------
async function renderRate({ amount, from, to, offeredRate, fee = 0 }) {
  const { rate: realRate, date, source } = await getRate(from, to);

  // If the rate looks upside down (e.g. 0.87 instead of 1.15), flip it
  let note = '';
  const ratio = offeredRate / realRate;
  if ((ratio < 0.5 || ratio > 1.5) && Math.abs(1 / offeredRate / realRate - 1) < 0.5) {
    offeredRate = 1 / offeredRate;
    note = '<p class="note-small">The rate you entered looked upside down, so it has been flipped.</p>';
  }

  const shouldGet = amount * realRate;
  const willGet = Math.max(0, amount - (fee || 0)) * offeredRate;
  const lossInTo = Math.max(0, shouldGet - willGet);
  const lossInFrom = lossInTo / realRate;
  const percent = (lossInTo / shouldGet) * 100;

  const verdict = percent < 1 ? 'safe' : percent < 3 ? 'caution' : 'danger';
  const labels = { safe: 'Fair rate', caution: 'Check first: pricey', danger: 'Stop: rip-off rate' };
  const advice = {
    safe: 'This is close to the real rate. Good to go.',
    caution: "You're paying a noticeable markup. Compare with a cheaper provider first.",
    danger: "You're losing a lot here. Avoid this if you can and use a provider that gives the real rate.",
  };

  return `
    <div class="card">
      ${verdictBadge(verdict, labels[verdict])}
      <div class="card-label">Hidden cost of this exchange</div>
      <div class="big">${money(lossInFrom, from)}</div>
      <div class="sub">That's ${percent.toFixed(1)}% less than you should get.</div>
      <div class="sub">${advice[verdict]}</div>
      <div class="rate-bars" aria-hidden="true">
        <div class="rate-bar"><span>Real rate</span><div class="bar"><span style="width:100%"></span></div></div>
        <div class="rate-bar offered"><span>Their offer</span><div class="bar"><span style="width:${Math.max(2, (willGet / shouldGet) * 100).toFixed(1)}%"></span></div></div>
      </div>
      <div class="rows">
        <div class="row"><span>You exchange</span><span>${money(amount, from)}</span></div>
        <div class="row"><span>Rate offered</span><span>1 ${from} = ${offeredRate.toFixed(4)} ${to}</span></div>
        <div class="row"><span>Real rate</span><span>1 ${from} = ${realRate.toFixed(4)} ${to}</span></div>
        ${fee ? `<div class="row"><span>Fee</span><span>${money(fee, from)}</span></div>` : ''}
        <div class="row"><span>You'd get</span><span>${money(willGet, to)}</span></div>
        <div class="row"><span>At the real rate</span><span>${money(shouldGet, to)}</span></div>
      </div>
      ${note}
      ${verdict !== 'safe' ? wiseLink(from, to, amount) : ''}
      ${trustButton(`Hi, can you give me a second opinion before I pay? I'm about to change ${money(amount, from)} at a rate of 1 ${from} = ${offeredRate.toFixed(4)} ${to}${fee ? ` with a ${money(fee, from)} fee` : ''}. PayProoof says it's ${{ safe: 'a fair rate', caution: 'a pricey rate', danger: 'a rip-off rate' }[verdict]}: I'd get ${money(willGet, to)} instead of ${money(shouldGet, to)} at the real rate, so I'd lose about ${money(lossInFrom, from)}, which is ${percent.toFixed(1)}% of my money. Should I go ahead?`)}
      <div class="meta">Mid-market rate from ${source}, ${formatDate(date)}</div>
    </div>`;
}

// ---------- Scam check ----------
function renderScam({ verdict, reasons = [], advice, userText = '' }) {
  verdict = normaliseVerdict(verdict);
  const labels = { safe: 'Looks fine', caution: 'Check first', danger: "Stop: don't send this money" };
  const defaultAdvice = {
    safe: [
      'No common scam warning signs were found.',
      'Still only pay people you know or have checked yourself.',
    ],
    caution: [
      "Don't pay yet.",
      'Contact the person using a phone number or email you already had, not one from this message.',
      'If in doubt, ask someone you trust before paying.',
    ],
    danger: [
      "Don't send any money.",
      'Check with the person or company using their official contact details.',
      "If you've already paid, call your bank straight away. In the UK you can dial 159.",
    ],
  };
  const steps = advice && advice.length ? advice : defaultAdvice[verdict];

  return `
    <div class="card">
      ${verdictBadge(verdict, labels[verdict])}
      <h3>Warning signs found</h3>
      ${reasons.length
        ? `<ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : '<p class="sub">None of the common warning signs were found.</p>'}
      <h3>What to do</h3>
      <ul>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      ${trustButton(scamShareText(verdict, labels[verdict], reasons, userText))}
      <div class="meta">A quick safety check, not a guarantee.</div>
    </div>`;
}

// =====================================================================
//  Ask someone you trust
// =====================================================================

function trustButton(message) {
  return `<button type="button" class="trust-btn" data-share="${escapeHtml(message)}">
    <svg aria-hidden="true"><use href="#i-people"/></svg>Ask someone you trust</button>`;
}

function scamShareText(verdict, label, reasons, userText) {
  const quoted = userText ? `\n\nThe message says:\n"${userText.length > 400 ? `${userText.slice(0, 400)}…` : userText}"` : '';
  const signs = reasons.length ? `\n\nWarning signs it found:\n${reasons.map((r) => `- ${r}`).join('\n')}` : '';
  return `Hi, can you give me a second opinion before I pay anything? PayProoof says: ${label}.${signs}${quoted}\n\nWhat do you think I should do?`;
}

const trustPanel = document.getElementById('trustPanel');
const trustMessage = document.getElementById('trustMessage');
const trustStatus = document.getElementById('trustStatus');
const trustShareBtn = document.getElementById('trustShare');

// Keeps the WhatsApp, text and email links matching the message
function updateTrustLinks() {
  const text = trustMessage.value;
  const encoded = encodeURIComponent(text);
  document.getElementById('trustWhatsApp').href = `https://wa.me/?text=${encoded}`;
  document.getElementById('trustSms').href = `sms:?&body=${encoded}`;
  document.getElementById('trustEmail').href = `mailto:?subject=${encodeURIComponent('Can you check this before I pay?')}&body=${encoded}`;
}

function openTrust(message) {
  trustMessage.value = message;
  trustStatus.textContent = '';
  updateTrustLinks();
  trustShareBtn.classList.toggle('hidden', !navigator.share);
  trustPanel.showModal();
}

chat.addEventListener('click', (e) => {
  const btn = e.target.closest('.trust-btn');
  if (btn) openTrust(btn.dataset.share);
});
trustMessage.addEventListener('input', updateTrustLinks);
document.getElementById('closeTrust').addEventListener('click', () => trustPanel.close());
trustPanel.addEventListener('click', (e) => {
  if (e.target === trustPanel) trustPanel.close();
});

document.getElementById('trustCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(trustMessage.value);
    trustStatus.textContent = 'Copied. Paste it into any app to send it.';
  } catch {
    trustMessage.select();
    trustStatus.textContent = 'Press Ctrl+C (or long-press and Copy) to copy the message.';
  }
});

trustShareBtn.addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'Can you check this before I pay?', text: trustMessage.value });
  } catch {
    // The person closed the share menu
  }
});

function formatDate(date) {
  const d = new Date(date);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// =====================================================================
//  Compare offers
//  Every number here is either the live real rate or something the user typed.
// =====================================================================

const compareAmount = document.getElementById('compareAmount');
const compareTo = document.getElementById('compareTo');
const compareFromCode = document.getElementById('compareFromCode');
const realRateBox = document.getElementById('realRate');
const offersBox = document.getElementById('offers');
const compareResults = document.getElementById('compareResults');
const wiseCompareLink = document.getElementById('wiseCompareLink');
let compareTimer = null;
let offerCount = 0;

// Fills the "They receive in" list with currency names
function fillCompareCurrencies() {
  const from = homeSelect.value;
  const previous = compareTo.value;
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { /* older browsers */ }

  compareTo.innerHTML = SUPPORTED
    .filter((code) => code !== from)
    .map((code) => `<option value="${code}">${code}${names ? `, ${names.of(code)}` : ''}</option>`)
    .join('');

  const fallback = from === 'EUR' ? 'GBP' : 'EUR';
  compareTo.value = previous && previous !== from ? previous : fallback;
  compareFromCode.textContent = from;
  updateOfferLabels();
}

// Adds a row where the user types one offer
function addOffer(name = '') {
  offerCount += 1;
  const id = offerCount;
  const row = document.createElement('div');
  row.className = 'offer';
  row.innerHTML = `
    <label class="field">
      <span>Provider</span>
      <input type="text" class="offer-name" value="${escapeHtml(name)}" placeholder="For example: my bank" autocomplete="off">
    </label>
    <label class="field">
      <span class="rate-label">Their rate</span>
      <input type="number" class="offer-rate" min="0" step="any" inputmode="decimal" placeholder="0.00">
    </label>
    <label class="field">
      <span class="fee-label">Their fee</span>
      <input type="number" class="offer-fee" min="0" step="any" inputmode="decimal" placeholder="0">
    </label>
    <button type="button" class="icon-btn offer-remove" aria-label="Remove this offer">
      <svg aria-hidden="true"><use href="#i-close"/></svg>
    </button>`;
  row.querySelectorAll('input').forEach((el) => el.addEventListener('input', scheduleCompare));
  row.querySelector('.offer-remove').addEventListener('click', () => {
    row.remove();
    updateCompare();
  });
  offersBox.appendChild(row);
  updateOfferLabels();
  return row;
}

// Shows the right currencies in each row's labels, e.g. "Their rate (1 GBP = ? EUR)"
function updateOfferLabels() {
  const from = homeSelect.value;
  const to = compareTo.value;
  offersBox.querySelectorAll('.rate-label').forEach((el) => { el.textContent = `Their rate: 1 ${from} = how many ${to}`; });
  offersBox.querySelectorAll('.fee-label').forEach((el) => { el.textContent = `Their fee in ${from}`; });
}

async function updateCompare() {
  const from = homeSelect.value;
  const to = compareTo.value;
  const amount = parseFloat(compareAmount.value);
  wiseCompareLink.href = `https://wise.com/gb/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate?amount=${amount || 1000}`;

  if (!amount || amount <= 0) {
    realRateBox.innerHTML = '';
    compareResults.innerHTML = '<p class="sub">Enter an amount above 0 to compare.</p>';
    return;
  }

  let real;
  try {
    real = await getRate(from, to);
  } catch (err) {
    console.error(err);
    realRateBox.innerHTML = "<p class=\"sub\">Today's exchange rate didn't load. Wait a moment and change the amount to try again.</p>";
    compareResults.innerHTML = '';
    return;
  }

  const fair = amount * real.rate;
  realRateBox.innerHTML = `
    <div class="real-rate-label">At the real rate, with no fees, they would receive</div>
    <div class="real-rate-amount">${money(fair, to)}</div>
    <div class="sub">1 ${from} = ${real.rate.toFixed(4)} ${to}. Live mid-market rate from ${real.source}, ${formatDate(real.date)}.</div>`;

  // Read the offers the user has typed
  const offers = [];
  offersBox.querySelectorAll('.offer').forEach((row, i) => {
    let rate = parseFloat(row.querySelector('.offer-rate').value);
    const fee = parseFloat(row.querySelector('.offer-fee').value) || 0;
    const name = row.querySelector('.offer-name').value.trim() || `Offer ${i + 1}`;
    if (!(rate > 0)) return;
    // If a rate looks upside down (e.g. 0.87 instead of 1.15), flip it
    let flipped = false;
    if (Math.abs(rate / real.rate - 1) > 0.5 && Math.abs(1 / rate / real.rate - 1) < 0.5) {
      rate = 1 / rate;
      flipped = true;
    }
    const received = Math.max(0, amount - fee) * rate;
    const loss = Math.max(0, fair - received);
    const percent = (loss / fair) * 100;
    offers.push({ name, rate, fee, received, loss, percent, flipped });
  });

  if (!offers.length) {
    compareResults.innerHTML = '<p class="sub compare-empty">Add the rate and fee you\'ve been offered to see how it compares.</p>';
    return;
  }

  offers.sort((a, b) => b.received - a.received);
  const labels = { safe: 'Fair', caution: 'Pricey', danger: 'Rip-off' };

  compareResults.innerHTML = `
    <ul class="providers">
      ${offers.map((o, i) => {
        const verdict = o.percent < 1 ? 'safe' : o.percent < 3 ? 'caution' : 'danger';
        return `
          <li class="provider ${i === 0 && offers.length > 1 ? 'best' : ''}">
            <div>
              <div class="provider-name">${escapeHtml(o.name)}</div>
              ${verdictBadge(verdict, labels[verdict])}
            </div>
            <div class="provider-rate">Rate ${o.rate.toFixed(4)}<br>Fee ${money(o.fee, from)}${o.flipped ? '<br>Rate flipped, it looked upside down' : ''}</div>
            <div class="provider-gets">${money(o.received, to)}<span class="provider-loss">${o.loss > 0 ? `${money(o.loss, to)} less, ${o.percent.toFixed(1)}%` : 'Same as the real rate'}</span></div>
            <div class="provider-bar" aria-hidden="true"><span style="width:${Math.max(2, (o.received / fair) * 100).toFixed(1)}%"></span></div>
          </li>`;
      }).join('')}
    </ul>
    ${offers.length > 1 ? `
      <div class="compare-summary">
        <strong>${money(offers[0].received - offers[offers.length - 1].received, to)}</strong>
        <span>more with ${escapeHtml(offers[0].name)} than with ${escapeHtml(offers[offers.length - 1].name)}</span>
      </div>` : ''}`;
}

// Wait until the user stops typing before updating
function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(updateCompare, 350);
}

compareAmount.addEventListener('input', scheduleCompare);
compareTo.addEventListener('change', () => {
  updateOfferLabels();
  updateCompare();
});
document.getElementById('compareForm').addEventListener('submit', (e) => e.preventDefault());
document.getElementById('addOffer').addEventListener('click', () => {
  addOffer().querySelector('.offer-name').focus();
});
homeSelect.addEventListener('change', () => {
  fillCompareCurrencies();
  updateCompare();
});

// Start with two empty offers to fill in
addOffer();
addOffer();

// =====================================================================
//  3. Helpers
// =====================================================================

function messageCard(text) {
  return `<div class="card"><p class="text">${escapeHtml(text)}</p></div>`;
}

function addUserMessage(text, image) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = (image ? `<img src="${image}" alt="Your photo">` : '') + escapeHtml(text || '');
  chat.appendChild(div);
  scrollDown();
}

function addBotCard(html) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = html;

  // Every result gets a "Read aloud" button
  const card = div.querySelector('.card');
  if (card && 'speechSynthesis' in window) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'speak-btn';
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-sound"/></svg> Read aloud';
    btn.addEventListener('click', () => speak(cardText(card)));
    card.appendChild(btn);
  }

  chat.appendChild(div);
  scrollDown();
  if (settings.readAloud && card) speak(cardText(card));
}

function addLoading() {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = '<div class="card loading" aria-label="Checking"><span></span><span></span><span></span></div>';
  chat.appendChild(div);
  scrollDown();
  return div;
}

function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

// The text of a card, without the button labels
function cardText(card) {
  const copy = card.cloneNode(true);
  copy.querySelectorAll('button').forEach((b) => b.remove());
  return copy.innerText.replace(/\s+/g, ' ').trim();
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-GB';
  window.speechSynthesis.speak(utterance);
}

function money(value, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =====================================================================
//  4. Accessibility settings (saved in the browser)
// =====================================================================

const root = document.documentElement;
const panel = document.getElementById('accessPanel');
const DEFAULTS = {
  textSize: '1',
  easyFont: false,
  spacing: false,
  contrast: false,
  cbPalette: false,
  reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  readAloud: false,
};
let settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('payprooof-access') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem('payprooof-access', JSON.stringify(settings));
  } catch {
    // Saving isn't possible (e.g. private browsing). Settings still work for this visit.
  }
}

// Turns settings into data-... attributes on <html>, which style.css reacts to
function applySettings() {
  root.style.setProperty('--scale', settings.textSize);
  ['easyFont', 'spacing', 'contrast', 'cbPalette', 'reduceMotion'].forEach((key) => {
    if (settings[key]) root.dataset[key] = '';
    else delete root.dataset[key];
  });
  // Keep the panel's switches in sync
  panel.querySelectorAll('[data-setting]').forEach((box) => {
    box.checked = !!settings[box.dataset.setting];
  });
  panel.querySelectorAll('input[name="textSize"]').forEach((radio) => {
    radio.checked = radio.value === settings.textSize;
  });
  updateScrollEffect();
}

panel.querySelectorAll('[data-setting]').forEach((box) => {
  box.addEventListener('change', () => {
    settings[box.dataset.setting] = box.checked;
    if (box.dataset.setting === 'readAloud' && !box.checked) window.speechSynthesis?.cancel();
    applySettings();
    saveSettings();
  });
});

panel.querySelectorAll('input[name="textSize"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    settings.textSize = radio.value;
    applySettings();
    saveSettings();
  });
});

document.getElementById('resetAccess').addEventListener('click', () => {
  settings = { ...DEFAULTS };
  applySettings();
  saveSettings();
});

document.getElementById('accessBtn').addEventListener('click', () => panel.showModal());
document.getElementById('closeAccess').addEventListener('click', () => panel.close());
// Clicking the dark area outside the panel closes it
panel.addEventListener('click', (e) => {
  if (e.target === panel) panel.close();
});

// =====================================================================
//  5. Visual effects
// =====================================================================

// ---------- Banknote pattern (fine swirling lines, like security printing) ----------
function drawNotePattern() {
  const svg = document.getElementById('notePattern');
  const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => { if (k !== 'colour') el.setAttribute(k, v); });
    el.style.stroke = attrs.colour || 'var(--line)';
    el.style.fill = 'none';
    svg.appendChild(el);
  };

  // Wavy lines across the note
  for (let row = 0; row < 16; row++) {
    let d = `M -10 ${row * 16}`;
    for (let x = -10; x <= 410; x += 10) {
      d += ` L ${x} ${(row * 16 + Math.sin(x / 26 + row * 0.6) * 6).toFixed(1)}`;
    }
    add('path', { d, 'stroke-width': 0.5, opacity: 0.35 });
  }

  // Two rosettes made of rotated ellipses
  for (let i = 0; i < 36; i++) {
    add('ellipse', { cx: 300, cy: 100, rx: 88, ry: 30, transform: `rotate(${i * 5} 300 100)`, 'stroke-width': 0.6, opacity: 0.55 });
  }
  for (let i = 0; i < 24; i++) {
    add('ellipse', { cx: 300, cy: 100, rx: 44, ry: 14, transform: `rotate(${i * 7.5} 300 100)`, 'stroke-width': 0.6, opacity: 0.9, colour: 'var(--accent)' });
  }
}

// ---------- Magnifying lens that follows the mouse ----------
function setUpLens() {
  const note = document.getElementById('note');
  const micro = note.querySelector('.note-micro');
  micro.textContent = 'GENUINE MID-MARKET RATE '.repeat(140);

  note.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const box = note.getBoundingClientRect();
    note.style.setProperty('--x', `${e.clientX - box.left}px`);
    note.style.setProperty('--y', `${e.clientY - box.top}px`);
    note.classList.add('is-checking');
  });
  note.addEventListener('pointerleave', () => note.classList.remove('is-checking'));
}

// ---------- Coin that moves down "How it works" as you scroll ----------
const stepsList = document.getElementById('steps');
const stepItems = stepsList.querySelectorAll('.step');
let scrollTicking = false;

function updateScrollEffect() {
  scrollTicking = false;
  if (settings.reduceMotion) {
    stepsList.style.setProperty('--p', 1);
    stepItems.forEach((s) => s.classList.add('is-reached'));
    return;
  }
  const middle = window.innerHeight * 0.6;
  const box = stepsList.getBoundingClientRect();
  const progress = Math.min(1, Math.max(0, (middle - box.top) / box.height));
  stepsList.style.setProperty('--p', progress.toFixed(3));

  stepItems.forEach((step) => {
    const r = step.getBoundingClientRect();
    step.classList.toggle('is-reached', r.top + r.height / 2 < middle);
  });
}

window.addEventListener('scroll', () => {
  if (!scrollTicking) {
    scrollTicking = true;
    requestAnimationFrame(updateScrollEffect);
  }
}, { passive: true });
window.addEventListener('resize', updateScrollEffect);

// ---------- Live rate on the banknote ----------
async function updateNoteRate() {
  const from = homeSelect.value;
  const to = from === 'EUR' ? 'GBP' : 'EUR';
  const amountEl = document.getElementById('noteAmount');
  const lineEl = document.getElementById('noteLine');
  amountEl.textContent = money(300, from);
  try {
    const { rate } = await getRate(from, to);
    lineEl.textContent = `Today's real rate: 1 ${from} = ${rate.toFixed(4)} ${to}`;
  } catch (err) {
    lineEl.textContent = 'Live rates from Frankfurter';
  }
}
homeSelect.addEventListener('change', updateNoteRate);

// ---------- Start everything ----------
drawNotePattern();
setUpLens();
applySettings();
fillCompareCurrencies();
updateCompare();
updateNoteRate();