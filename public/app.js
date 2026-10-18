// PayProoof
// This file makes the page work: it reads what the user types or photographs,
// gets the real exchange rate, checks for scam warning signs and shows the result.

// --- Find the parts of the page we need ---
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

// Hint text in the message box for each mode
const PLACEHOLDERS = {
  auto: 'Type an amount, a rate or paste a message',
  convert: 'For example: How much is €250?',
  rate: 'For example: They offered 1.05 euros per pound for £300',
  scam: 'Paste the message or payment request here',
};

// ===== The checker =====

// --- Mode buttons ---
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

// --- Example buttons ---
document.querySelectorAll('.example').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.text;
    form.requestSubmit();
  });
});

// --- Photo upload ---
// Phone photos are very big, so we shrink them first to make reading them faster
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

// Removes the attached photo
function clearImage() {
  currentImage = null;
  imageInput.value = '';
  preview.classList.add('hidden');
}

// --- When the user presses Check ---
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
  saveChat();
});

// ===== Keeping your chat =====
// Your checks stay in this tab, even if you refresh, until you press New chat
// or close the tab. Nothing is sent anywhere: it's stored in your own browser.
const CHAT_KEY = 'payprooof-chat';

// Saves the chat so it's still there after a refresh
function saveChat() {
  const data = { html: chat.innerHTML, proofs: [...savedProofs], count: proofCount };
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(data));
  } catch {
    // Photos can make the chat too big to store, so try again without them
    try {
      data.html = data.html.replace(/<img[^>]*>/g, '<p class="note-small">Photo not kept after refresh</p>');
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(data));
    } catch { /* storage not available, the chat just won't survive a refresh */ }
  }
}

// Brings back the chat after a refresh
function restoreChat() {
  let data = null;
  try { data = JSON.parse(sessionStorage.getItem(CHAT_KEY)); } catch { /* nothing saved */ }
  if (!data || !data.html) return;
  chat.innerHTML = data.html;
  (data.proofs || []).forEach(([id, record]) => {
    record.checkedAt = new Date(record.checkedAt);
    savedProofs.set(id, record);
  });
  proofCount = data.count || 0;
  // The Read aloud buttons need setting up again
  chat.querySelectorAll('.speak-btn').forEach((btn) => btn.remove());
  chat.querySelectorAll('.card').forEach(addSpeakButton);
  scrollDown();
}

// New chat: clears your checks and shows the examples again
document.getElementById('newChat').addEventListener('click', () => {
  window.speechSynthesis?.cancel();
  chat.innerHTML = '';
  chat.appendChild(welcome);
  try { sessionStorage.removeItem(CHAT_KEY); } catch { /* nothing to clear */ }
  input.focus();
});

// ===== Understanding the message =====

// Works out what the user wants and returns the result to show
async function analyse(text, image) {
  const homeCurrency = homeSelect.value;

  // If there's a photo, read the text in it and check that text too
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

// --- Choosing which check to run ---

// Decides which check to run: scam check, rate check or conversion
function localAnalyse(text, home, mode) {
  const scamReasons = SCAM_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.reason);
  const rateOffer = parseRateOffer(text);
  const amounts = findAmounts(text);

  const scam = {
    type: 'scam_check',
    verdict: scamReasons.length === 0 ? 'safe' : scamReasons.length === 1 ? 'caution' : 'danger',
    reasons: scamReasons,
  };
  // A scam warning is never hidden: if warning signs are found, that check is shown too
  const withScamCheck = (main) => (scamReasons.length ? { type: 'both', results: [scam, main] } : main);

  const makeConvert = () => {
    if (!amounts.length) return null;
    const first = amounts[0];
    let to = findTarget(text) || home;
    if (to === first.currency) to = first.currency === home ? (home === 'EUR' ? 'GBP' : 'EUR') : home;
    return { type: 'convert', amount: first.value, from: first.currency, to };
  };

  const askRate = { type: 'message', text: 'Tell me the rate you were offered and the amount, for example: "1.05 euros per pound for £300".' };
  const askAnything = { type: 'message', text: 'Include an amount and a currency, for example "How much is €250?", or paste a message to check it for scams.' };

  if (mode === 'scam') return scam;

  if (mode === 'rate') {
    if (rateOffer) return withScamCheck(rateOffer);
    return scamReasons.length ? scam : askRate;
  }

  if (mode === 'convert') {
    const convert = makeConvert();
    if (convert) return withScamCheck(convert);
    return scamReasons.length ? scam : askAnything;
  }

  // "Work it out for me"
  if (rateOffer) return withScamCheck(rateOffer);
  if (scamReasons.length) return scam;
  return makeConvert() || askAnything;
}

// --- Understanding currencies in normal writing ---

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

// Turns a word or symbol like "euros" or "€" into a currency code like EUR
function toCode(token) {
  if (!token) return null;
  const word = token.toLowerCase();
  if (CURRENCY_WORDS[word]) return CURRENCY_WORDS[word];
  // Only accept a 3-letter code in capitals, so the word "try" isn't read as Turkish lira
  if (token === token.toUpperCase() && SUPPORTED.includes(token)) return token;
  return null;
}

// Reads numbers written in different styles: 1,234.56 / 1.234,56 / 12,50 / 1.02
function toNum(s) {
  let t = String(s);
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot > -1 && lastComma > -1) {
    // Both appear: whichever comes last is the decimal point
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    t = t.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma > -1) {
    // Only commas: "1,234" is a thousand, "12,50" is a decimal
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if ((t.match(/\./g) || []).length > 1) {
    // "1.234.567" uses dots for thousands
    t = t.replace(/\./g, '');
  }
  return parseFloat(t);
}

// Finds amounts like "£300", "250 euros" or "EUR 40"
function findAmounts(text) {
  const found = [];
  for (const m of text.matchAll(/([£€$¥₹₱])\s?(\d(?:[\d.,]*\d)?)/g)) {
    found.push({ value: toNum(m[2]), currency: toCode(m[1]), index: m.index });
  }
  for (const m of text.matchAll(/(\d(?:[\d.,]*\d)?)\s?([A-Za-zł]+)/g)) {
    const code = toCode(m[2]);
    if (code) found.push({ value: toNum(m[1]), currency: code, index: m.index });
  }
  for (const m of text.matchAll(/\b([A-Z]{3})\s?(\d(?:[\d.,]*\d)?)/g)) {
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
  // Remove other lines of a rate board ("GBP 1 = USD 1.18") so they aren't read as the amount
  rest = rest.replace(/(?:[£€$¥₹₱]|[A-Z]{3})\s?1\s*=\s*(?:[£€$¥₹₱]|[A-Z]{3})?\s?\d+(?:\.\d+)?(?:\s*[A-Z]{3})?/g, ' ');
  const feeInfo = parseFee(rest);
  // Remove the fee so it isn't mistaken for the amount
  if (feeInfo.value) rest = rest.replace(/\d+(?:\.\d+)?\s?%\s*(?:fee|commission|charge)|(?:fee|commission|charge)\s*(?:of\s*)?\d+(?:\.\d+)?\s?%|(?:fee|commission|charge)[^\d,;.%]{0,12}?\d+(?:\.\d+)?|[£€$¥₹₱]?\d+(?:\.\d+)?\s*(?:pounds?|euros?|dollars?)?\s*(?:fee|commission)/i, ' ');
  const amounts = findAmounts(rest);
  const inFrom = amounts.find((a) => a.currency === from);
  const inTo = amounts.find((a) => a.currency === to);
  let amount = 100;
  if (inFrom) amount = inFrom.value;
  else if (inTo) amount = inTo.value / offeredRate;

  const fee = feeInfo.percent ? (amount * feeInfo.value) / 100 : feeInfo.value;
  return {
    type: 'rate_check', amount, from, to, offeredRate, fee,
    feePercent: feeInfo.percent ? feeInfo.value : null,
    amountGuessed: !inFrom && !inTo,
  };
}

// Finds a fee: either an amount ("£5 fee") or a percentage ("2% fee")
function parseFee(text) {
  // "No commission", "zero fees", "fee-free" mean no fee
  if (/\b(?:no|zero|0%?)\s+(?:fees?|commission)|(?:fee|commission)[- ]free/i.test(text)) return { value: 0, percent: false };
  const pct = text.match(/(\d+(?:\.\d+)?)\s?%\s*(?:fee|commission|charge)/i)
    || text.match(/(?:fee|commission|charge)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s?%/i);
  if (pct) return { value: toNum(pct[1]), percent: true };
  const m = text.match(/(?:fee|commission|charge)[^\d,;.%]{0,12}?(\d+(?:\.\d+)?)(?!\s?%)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:pounds?|euros?|dollars?)?\s*(?:fee|commission)/i);
  return { value: m ? toNum(m[1]) : 0, percent: false };
}

// --- Scam warning signs ---

// Each rule is a pattern to look for, and the reason it's a warning sign
const SCAM_RULES = [
  { re: /urgent|immediately|right now|today only|within \d* ?hours?|asap|last chance/i,
    reason: "Pressure to pay quickly. Scammers rush you so you don't stop to check." },
  { re: /(bank|account|payment) details (have )?(changed|been updated|updated)|new (bank )?account|changed (our|my|their) (bank|account)/i,
    reason: 'Says the bank details have changed. Changed payment details are a common sign of invoice and rental scams.' },
  { re: /deposit|holding fee|secure the (flat|room|property|house)|before (the )?viewing|without (a )?viewing/i,
    reason: 'Asks for a deposit to "secure" a place, possibly before you\'ve seen it. This is a common sign of rental scams.' },
  { re: /gift ?cards?|itunes|steam card|crypto|bitcoin|usdt/i,
    reason: 'Asks to be paid in gift cards, vouchers or crypto. Banks, landlords and authorities like HMRC don\'t ask for payment this way.' },
  { re: /overpa(id|yment)|refund the difference|sent (you )?too much/i,
    reason: 'An "overpayment" refund request. A classic trick to get you to send money back.' },
  { re: /verify your (account|identity|details)|account (will be )?(suspended|locked|closed)|click (the|this) link/i,
    reason: 'Threatens your account or asks you to click a link to "verify".' },
  { re: /(hmrc|police|home office|visa|tax).{0,60}(fine|arrest|deport|penalty)|(fine|arrest|deport|penalty).{0,60}(hmrc|police|home office|visa|tax)/i,
    reason: 'Threatens fines, arrest or your visa. HMRC says it never threatens arrest, so this is a strong warning sign.' },
  { re: /don'?t tell|keep (this|it) (secret|between us)|confidential/i,
    reason: 'Asks you to keep it secret. A big warning sign.' },
  { re: /western union|moneygram|friends and family/i,
    reason: 'Asks for a payment method that is hard to reverse if something goes wrong.' },
  { re: /(mum|mom|dad).{0,40}new (phone|number)|new (phone|number).{0,40}(mum|mom|dad)/i,
    reason: '"New number" family message. A common impersonation scam.' },
];

// Gets the real exchange rate between two currencies from Frankfurter
async function getRate(from, to) {
  if (from === to) return { rate: 1, date: new Date().toISOString(), source: 'none' };
  if (!SUPPORTED.includes(from) || !SUPPORTED.includes(to)) {
    throw new Error(`Unsupported currency: ${from} or ${to}`);
  }

  // Frankfurter: today's rates first, then the European Central Bank feed as a backup.
  // We keep whichever answer is most recent, so an old rate is never used by mistake.
  const answers = [];
  try {
    const res = await fetch(`https://api.frankfurter.dev/v2/rates?base=${from}&quotes=${to}`);
    if (res.ok) {
      const data = await res.json();
      const row = Array.isArray(data) ? data.find((r) => r.quote === to) : null;
      if (row && row.rate) answers.push({ rate: row.rate, date: row.date });
    }
  } catch (e) { /* try the backup */ }

  if (!answers.length || daysOld(answers[0].date) > 3) {
    try {
      const res = await fetch(`https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`);
      if (res.ok) {
        const data = await res.json();
        if (data.rates && data.rates[to]) answers.push({ rate: data.rates[to], date: data.date });
      }
    } catch (e) { /* no backup available */ }
  }

  if (!answers.length) throw new Error('No exchange rate available');
  answers.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { ...answers[0], source: 'Frankfurter' };
}

// ===== Result cards =====

// Makes sure a verdict is one of: safe, caution or danger
function normaliseVerdict(v) {
  return { green: 'safe', amber: 'caution', red: 'danger' }[v] || (['safe', 'caution', 'danger'].includes(v) ? v : 'caution');
}

// Which icon goes with each verdict
const VERDICT_ICON = { safe: 'i-safe', caution: 'i-caution', danger: 'i-danger' };

// The coloured label at the top of a result, with its shape
function verdictBadge(verdict, label) {
  return `<span class="verdict ${verdict}"><svg aria-hidden="true"><use href="#${VERDICT_ICON[verdict]}"/></svg>${label}</span>`;
}

// Picks the right card to show for each type of result
async function renderResult(result) {
  switch (result.type) {
    case 'convert': return renderConvert(result);
    case 'rate_check': return renderRate(result);
    case 'both': {
      const parts = [];
      for (const part of result.results) parts.push(await renderResult({ ...part, userText: result.userText }));
      return parts.join('');
    }
    case 'scam_check': return renderScam(result);
    default: return messageCard(result.text || "I couldn't understand that. Try including an amount, like €250.");
  }
}

// Link that opens the same conversion on Wise's website
function wiseLink(from, to, amount) {
  const url = `https://wise.com/gb/currency-converter/${from.toLowerCase()}-to-${to.toLowerCase()}-rate?amount=${Math.round(amount * 100) / 100}`;
  return `<a class="card-link" href="${url}" target="_blank" rel="noopener">See this conversion on Wise</a>`;
}

// --- Convert ---
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
      <p class="read-as">Read as: converting ${money(amount, from)} into ${to}. If that's not right, type it again more clearly.</p>
      <div class="card-label">${money(amount, from)} is worth</div>
      <div class="big">${money(converted, to)}</div>
      <div class="rows">
        <div class="row"><span>Exchange rate</span><span>1 ${from} = ${rate.toFixed(4)} ${to}</span></div>
        <div class="row"><span>The other way</span><span>1 ${to} = ${(1 / rate).toFixed(4)} ${from}</span></div>
      </div>
      <div class="convert-controls">
        <label>Show in
          <select class="convert-to" data-amount="${amount}" data-from="${from}">
            ${SUPPORTED.filter((c) => c !== from).map((c) => `<option value="${c}"${c === to ? ' selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="convert-swap" data-amount="${amount}" data-from="${to}" data-to="${from}">
          <svg aria-hidden="true"><use href="#i-swap"/></svg>Swap: ${money(amount, to)} into ${from}</button>
      </div>
      <p class="note-small">This is the mid-market rate: the midpoint between the price to buy and the price to sell a currency. Banks and exchange desks often give you less.</p>
      ${wiseLink(from, to, amount)}
      ${saveButton({
        kind: 'Conversion',
        headline: `${money(amount, from)} is worth ${money(converted, to)}`,
        rows: [['Exchange rate', `1 ${from} = ${rate.toFixed(4)} ${to}`], ['The other way', `1 ${to} = ${(1 / rate).toFixed(4)} ${from}`]],
        notes: [RATE_NOTE(source, date)],
      })}
      ${goodToKnow([RATE_NOTE(source, date)])}
    </div>`;
}

// Redraws a conversion card in place with new currencies
async function updateConvertCard(card, amount, from, to) {
  try {
    const holder = document.createElement('div');
    holder.innerHTML = await renderConvert({ amount, from, to });
    const fresh = holder.firstElementChild;
    addSpeakButton(fresh);
    card.replaceWith(fresh);
    fresh.querySelector('.convert-swap')?.focus();
    saveChat();
  } catch (err) {
    console.error(err);
  }
}

chat.addEventListener('change', (e) => {
  const select = e.target.closest('.convert-to');
  if (select) updateConvertCard(select.closest('.card'), parseFloat(select.dataset.amount), select.dataset.from, select.value);
});
chat.addEventListener('click', (e) => {
  const btn = e.target.closest('.convert-swap');
  if (btn) updateConvertCard(btn.closest('.card'), parseFloat(btn.dataset.amount), btn.dataset.from, btn.dataset.to);
});

// --- Rate check ---
async function renderRate({ amount, from, to, offeredRate, fee = 0, feePercent = null, amountGuessed = false }) {
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
  const rateNotes = [
    RATE_NOTE(source, date),
    "Fair, pricey and rip-off are PayProoof's own guide, not an official standard: under 1%, 1% to 3%, and over 3% less than the real rate.",
    ...(amountGuessed ? ['No amount was found, so this check uses 100 as an example.'] : []),
  ];
  const advice = {
    safe: 'This is close to the real rate.',
    caution: "You're paying a noticeable markup. Compare with a cheaper provider first.",
    danger: "You're losing a lot here. Avoid this if you can and use a provider that gives the real rate.",
  };

  const feeText = fee ? `, with a ${money(fee, from)} fee${feePercent ? `, which is ${feePercent}% of the amount` : ''}` : ', with no fee';
  return `
    <div class="card">
      ${verdictBadge(verdict, labels[verdict])}
      <p class="read-as">Read as: exchanging ${money(amount, from)} into ${to} at 1 ${from} = ${offeredRate.toFixed(4)} ${to}${feeText}. If that's not right, type it again more clearly.</p>
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
      ${saveButton({
        kind: 'Rate check',
        verdict,
        verdictLabel: labels[verdict],
        headline: `Hidden cost: ${money(lossInFrom, from)}, ${percent.toFixed(1)}% less than the real rate`,
        rows: [
          ['You exchange', money(amount, from)],
          ['Rate offered', `1 ${from} = ${offeredRate.toFixed(4)} ${to}`],
          ['Real rate', `1 ${from} = ${realRate.toFixed(4)} ${to}`],
          ...(fee ? [['Fee', money(fee, from)]] : []),
          ["You'd get", money(willGet, to)],
          ['At the real rate', money(shouldGet, to)],
        ],
        steps: [advice[verdict]],
        notes: rateNotes,
      })}
      ${trustButton(`Hi, can you give me a second opinion before I pay? I'm about to change ${money(amount, from)} at a rate of 1 ${from} = ${offeredRate.toFixed(4)} ${to}${fee ? ` with a ${money(fee, from)} fee` : ''}. PayProoof says it's ${{ safe: 'a fair rate', caution: 'a pricey rate', danger: 'a rip-off rate' }[verdict]}: I'd get ${money(willGet, to)} instead of ${money(shouldGet, to)} at the real rate, so I'd lose about ${money(lossInFrom, from)}, which is ${percent.toFixed(1)}% of my money. Should I go ahead?`)}
      ${goodToKnow(rateNotes)}
    </div>`;
}

// --- Scam check ---
function renderScam({ verdict, reasons = [], advice, userText = '' }) {
  verdict = normaliseVerdict(verdict);
  const labels = { safe: 'No warning signs found', caution: 'Check first', danger: "Stop: don't send this money" };
  const defaultAdvice = {
    safe: [
      "None of the common warning signs PayProoof looks for were found. This doesn't prove the person or the payment is genuine.",
      'Only pay people you know, or confirm who they are using contact details you find yourself.',
    ],
    caution: [
      "Don't pay yet.",
      'Contact the person using a phone number or email you already had, not one from this message.',
      'If in doubt, ask someone you trust before paying.',
    ],
    danger: [
      "Don't send any money.",
      'Check with the person or company using contact details you find yourself, not ones in this message.',
      "If you've already paid, call your bank straight away. In the UK, calling 159 connects you to most major banks. If yours isn't covered, use the number on the back of your card.",
      'Report it to Report Fraud at reportfraud.police.uk or on 0300 123 2040. In Scotland, call Police Scotland on 101.',
    ],
  };
  const steps = advice && advice.length ? advice : defaultAdvice[verdict];
  const beforeYouPay = verdict === 'danger' ? [] : BEFORE_YOU_PAY;
  const forThisSituation = situationTips(userText);

  return `
    <div class="card">
      ${verdictBadge(verdict, labels[verdict])}
      <h3>Warning signs found</h3>
      ${reasons.length
        ? `<ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : '<p class="sub">None of the common warning signs were found.</p>'}
      <h3>What to do</h3>
      <ul>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      ${adviceList('Before you pay', beforeYouPay)}
      ${adviceList('For this situation', forThisSituation)}
      ${saveButton({
        kind: 'Scam check',
        verdict,
        verdictLabel: labels[verdict],
        reasons,
        steps,
        message: userText,
        sections: [
          { title: 'Before you pay', items: beforeYouPay },
          { title: 'For this situation', items: forThisSituation },
        ],
        notes: [SCAM_NOTE, ADVICE_SOURCE],
      })}
      ${trustButton(scamShareText(verdict, labels[verdict], reasons, userText))}
      ${goodToKnow([SCAM_NOTE, ADVICE_SOURCE])}
    </div>`;
}

// How many days old a rate is
function daysOld(date) {
  const d = new Date(date);
  return isNaN(d) ? 999 : Math.floor((Date.now() - d.getTime()) / 86400000);
}

// ===== Good to know =====
// Honest notes shown under every result, so nobody is misled

// Note about where the rate comes from, with a warning if it's old
const RATE_NOTE = (source, date) => {
  const age = daysOld(date);
  const warning = age > 4
    ? ` Warning: this rate is ${age} days old because a newer one wasn't available, so today's real rate may be different.`
    : '';
  return `Rates come from ${source}, which publishes reference rates from central banks once each working day, so they don't move minute by minute like the rates on Google or in banking apps. This one is from ${formatDate(date)}.${warning}`;
};

// Advice checked against Take Five to Stop Fraud, UK Finance, GOV.UK and Which? in October 2026
const BEFORE_YOU_PAY = [
  "Take a moment. It's OK to refuse or ignore a request for money. Someone genuine won't rush or panic you.",
  "When you pay by bank transfer, your bank checks the name against the account. If it says the name doesn't match, don't pay until you've contacted the person yourself, and be wary of anyone who tells you to ignore it.",
  'If bank details have changed, phone the person or company on a number you already had, not one from the message.',
];
const RENT_TIP = 'Renting in England? Your landlord or letting agent must put your deposit in a government-approved protection scheme within 30 days of getting it. Ask which scheme they use, and view the place in person if you can. Wales, Scotland and Northern Ireland have their own rules and schemes.';
const BUY_TIP = "Buying something? Paying by credit card for something that costs over £100 and up to £30,000 can give you extra protection under Section 75 of the Consumer Credit Act. This doesn't apply to debit cards.";
const ADVICE_SOURCE = 'Advice is based on guidance from Take Five to Stop Fraud, UK Finance, GOV.UK and Which?, checked in October 2026.';

// Extra advice that only appears when the message is about renting or buying
function situationTips(text = '') {
  const tips = [];
  if (/\b(deposit|rent|renting|flat|room|landlord|tenan\w*|letting|lease|viewing|property)\b/i.test(text)) tips.push(RENT_TIP);
  if (/\b(buy|buying|bought|purchase|order|seller|selling|for sale|marketplace|tickets?|item|delivery|parcel)\b/i.test(text)) tips.push(BUY_TIP);
  return tips;
}

// Shows a heading with a list of advice under it
function adviceList(title, items) {
  return items.length ? `<h3>${title}</h3><ul>${items.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : '';
}

// Reminder that the scam check can't catch everything
const SCAM_NOTE = 'This check looks for common warning signs. It can miss new kinds of scams and can flag genuine messages, so always confirm with the person or company directly before you pay.';

// The "Good to know" box under each result
function goodToKnow(notes) {
  return `<div class="good-to-know"><strong>Good to know</strong><ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`;
}

// ===== Save a PayProoof =====
// Turns a result into an image the user can keep as a record

const savedProofs = new Map();
let proofCount = 0;

// Remembers what's in a result and adds the Save button for it
function saveButton(record) {
  proofCount += 1;
  record.checkedAt = new Date();
  savedProofs.set(String(proofCount), record);
  return `<button type="button" class="save-btn" data-proof="${proofCount}">
    <svg aria-hidden="true"><use href="#i-save"/></svg>Save a PayProoof</button>`;
}

[chat, document.getElementById('compareResults')].forEach((area) => {
  area.addEventListener('click', (e) => {
    const btn = e.target.closest('.save-btn');
    if (btn) downloadProof(savedProofs.get(btn.dataset.proof));
  });
});

// Splits text into lines that fit a width
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines;
}

// Draws the verdict shape: circle, triangle or octagon
function drawVerdictShape(ctx, verdict, x, y, size, colour) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  const r = size / 2;
  if (verdict === 'safe') {
    ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  } else if (verdict === 'caution') {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + size, y + size);
    ctx.lineTo(x, y + size);
  } else {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      ctx.lineTo(x + r + r * Math.cos(a), y + r + r * Math.sin(a));
    }
  }
  ctx.closePath();
  ctx.fill();

  // The mark inside each shape: a tick, an exclamation mark or a cross
  ctx.lineWidth = size * 0.12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (verdict === 'safe') {
    ctx.strokeStyle = '#ffffff';
    ctx.moveTo(x + size * 0.28, y + size * 0.52);
    ctx.lineTo(x + size * 0.44, y + size * 0.68);
    ctx.lineTo(x + size * 0.72, y + size * 0.36);
  } else if (verdict === 'caution') {
    ctx.strokeStyle = '#1a1a1a';
    ctx.moveTo(x + r, y + size * 0.38);
    ctx.lineTo(x + r, y + size * 0.62);
    ctx.moveTo(x + r, y + size * 0.8);
    ctx.lineTo(x + r, y + size * 0.8);
  } else {
    ctx.strokeStyle = '#ffffff';
    ctx.moveTo(x + size * 0.34, y + size * 0.34);
    ctx.lineTo(x + size * 0.66, y + size * 0.66);
    ctx.moveTo(x + size * 0.66, y + size * 0.34);
    ctx.lineTo(x + size * 0.34, y + size * 0.66);
  }
  ctx.stroke();
}

// Draws the saved PayProoof image
function drawProof(record) {
  const css = getComputedStyle(document.documentElement);
  const col = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const dark = col('--band-dark', '#1e1b4b');
  const bright = col('--band-bright', '#f5ebdd');
  const ink = col('--ink', '#1b1838');
  const muted = col('--muted', '#57537a');
  const verdictColour = { safe: col('--safe', '#3f7d12'), caution: col('--caution', '#e0a82e'), danger: col('--danger', '#b3125a') };
  const font = col('--font-body', 'sans-serif');

  const W = 1080;
  const P = 70;
  const textW = W - P * 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Work out every line first, so we know how tall the image needs to be
  const blocks = [];
  const add = (type, text, size, weight = 400, colour = ink, gap = 10) => blocks.push({ type, text, size, weight, colour, gap });
  const when = record.checkedAt.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  add('text', record.kind, 30, 700, muted, 6);
  if (record.verdict) blocks.push({ type: 'verdict', verdict: record.verdict, text: record.verdictLabel, gap: 24 });
  if (record.headline) add('text', record.headline, 40, 700, ink, 24);
  (record.rows || []).forEach(([label, value]) => blocks.push({ type: 'row', label, value, gap: 4 }));
  if (record.rows && record.rows.length) blocks.push({ type: 'space', h: 20 });
  if (record.reasons) {
    add('heading', 'Warning signs found', 30, 700, ink, 8);
    (record.reasons.length ? record.reasons : ['None of the common warning signs were found.']).forEach((r) => add('bullet', r, 26, 400, ink, 6));
    blocks.push({ type: 'space', h: 16 });
  }
  if (record.message) {
    add('heading', 'The message checked', 30, 700, ink, 8);
    add('text', `"${record.message.length > 500 ? `${record.message.slice(0, 500)}…` : record.message}"`, 24, 400, muted, 16);
  }
  if (record.steps && record.steps.length) {
    add('heading', 'What to do', 30, 700, ink, 8);
    record.steps.forEach((s) => add('bullet', s, 26, 400, ink, 6));
    blocks.push({ type: 'space', h: 16 });
  }
  (record.sections || []).filter((s) => s.items && s.items.length).forEach((s) => {
    add('heading', s.title, 30, 700, ink, 8);
    s.items.forEach((item) => add('bullet', item, 26, 400, ink, 6));
    blocks.push({ type: 'space', h: 16 });
  });
  blocks.push({ type: 'notes', notes: ['PayProoof is a quick check, not financial or legal advice.', ...(record.notes || [])] });

  // Measure
  const lineH = (size) => Math.round(size * 1.4);
  let height = 170 + P;
  const prepared = blocks.map((b) => {
    if (b.type === 'text' || b.type === 'heading' || b.type === 'bullet') {
      ctx.font = `${b.weight} ${b.size}px ${font}`;
      b.lines = wrapText(ctx, b.text, b.type === 'bullet' ? textW - 34 : textW);
      b.h = b.lines.length * lineH(b.size) + b.gap;
    } else if (b.type === 'verdict') {
      b.h = 64 + b.gap;
    } else if (b.type === 'row') {
      b.h = 46 + b.gap;
    } else if (b.type === 'space') {
      b.h = b.h;
    } else if (b.type === 'notes') {
      ctx.font = `400 23px ${font}`;
      b.lines = b.notes.map((n) => wrapText(ctx, n, textW - 60));
      b.h = 70 + b.lines.reduce((sum, l) => sum + l.length * lineH(23) + 8, 0) + 30;
    }
    height += b.h;
    return b;
  });
  height += 90;

  canvas.width = W;
  canvas.height = height;

  // Background and header
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, height);
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, W, 140);
  ctx.fillStyle = bright;
  ctx.font = `800 48px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('PayProoof', P, 70);
  ctx.font = `400 24px ${font}`;
  ctx.textAlign = 'right';
  ctx.fillText(`Checked ${when}`, W - P, 70);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  let y = 140 + 60;
  prepared.forEach((b) => {
    if (b.type === 'text' || b.type === 'heading') {
      ctx.font = `${b.weight} ${b.size}px ${font}`;
      ctx.fillStyle = b.colour;
      b.lines.forEach((l, i) => ctx.fillText(l, P, y + i * lineH(b.size) + b.size));
    } else if (b.type === 'bullet') {
      ctx.font = `${b.weight} ${b.size}px ${font}`;
      ctx.fillStyle = b.colour;
      ctx.fillText('•', P + 4, y + b.size);
      b.lines.forEach((l, i) => ctx.fillText(l, P + 34, y + i * lineH(b.size) + b.size));
    } else if (b.type === 'verdict') {
      drawVerdictShape(ctx, b.verdict, P, y, 56, verdictColour[b.verdict]);
      ctx.font = `700 36px ${font}`;
      ctx.fillStyle = ink;
      ctx.fillText(b.text, P + 76, y + 42);
    } else if (b.type === 'row') {
      ctx.strokeStyle = '#e4e2ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(P, y + 46);
      ctx.lineTo(W - P, y + 46);
      ctx.stroke();
      ctx.font = `400 26px ${font}`;
      ctx.fillStyle = muted;
      ctx.fillText(b.label, P, y + 32);
      ctx.font = `700 26px ${font}`;
      ctx.fillStyle = ink;
      ctx.textAlign = 'right';
      ctx.fillText(b.value, W - P, y + 32);
      ctx.textAlign = 'left';
    } else if (b.type === 'notes') {
      ctx.fillStyle = '#f6f4fb';
      ctx.strokeStyle = muted;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(P, y, textW, b.h - 20, 18);
      ctx.fill();
      ctx.stroke();
      ctx.font = `700 26px ${font}`;
      ctx.fillStyle = ink;
      ctx.fillText('Good to know', P + 30, y + 46);
      let ny = y + 70;
      ctx.font = `400 23px ${font}`;
      b.lines.forEach((lines) => {
        lines.forEach((l, i) => ctx.fillText(l, P + 30, ny + i * lineH(23) + 23));
        ny += lines.length * lineH(23) + 8;
      });
    }
    y += b.h;
  });

  ctx.font = `400 22px ${font}`;
  ctx.fillStyle = muted;
  ctx.fillText('Made with PayProoof. Keep this as a record of what you checked.', P, height - 45);
  return canvas;
}

// Downloads the image, or opens the share menu on phones
function downloadProof(record) {
  if (!record) return;
  const canvas = drawProof(record);
  const t = record.checkedAt;
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
  canvas.toBlob((blob) => {
    const file = new File([blob], `payprooof-${stamp}.png`, { type: 'image/png' });
    // On phones, offer the share menu so it can go straight to Photos or Files
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(hover: none)').matches) {
      navigator.share({ files: [file], title: 'My PayProoof' }).catch(() => {});
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }, 'image/png');
}

// ===== Ask someone you trust =====

// The "Ask someone you trust" button, with the message ready to send
function trustButton(message) {
  return `<button type="button" class="trust-btn" data-share="${escapeHtml(message)}">
    <svg aria-hidden="true"><use href="#i-people"/></svg>Ask someone you trust</button>`;
}

// Writes the message to send after a scam check
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

// Opens the panel for sending the message
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

// Shows a date like "17 October 2026"
function formatDate(date) {
  const d = new Date(date);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ===== Compare offers =====
// Every number here is either the live real rate or something the user typed.

const compareAmount = document.getElementById('compareAmount');
const compareTo = document.getElementById('compareTo');
const compareFrom = document.getElementById('compareFrom');
const realRateBox = document.getElementById('realRate');
const offersBox = document.getElementById('offers');
const compareResults = document.getElementById('compareResults');
const wiseCompareLink = document.getElementById('wiseCompareLink');
let compareTimer = null;
let offerCount = 0;

// Fills both currency lists. Sending starts as "My currency" but can be anything.
function fillCompareCurrencies(from = compareFrom.value || homeSelect.value) {
  const previous = compareTo.value;
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { /* older browsers */ }

  compareFrom.innerHTML = SUPPORTED.map((code) => `<option value="${code}">${code}</option>`).join('');
  compareFrom.value = from;

  compareTo.innerHTML = SUPPORTED
    .filter((code) => code !== from)
    .map((code) => `<option value="${code}">${code}${names ? `, ${names.of(code)}` : ''}</option>`)
    .join('');

  const fallback = from === 'EUR' ? 'GBP' : 'EUR';
  compareTo.value = previous && previous !== from ? previous : fallback;
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
  const from = compareFrom.value;
  const to = compareTo.value;
  offersBox.querySelectorAll('.rate-label').forEach((el) => { el.textContent = `Their rate: 1 ${from} = how many ${to}`; });
  offersBox.querySelectorAll('.fee-label').forEach((el) => { el.textContent = `Their fee in ${from}`; });
}

// Works out what each offer gives and shows them from best to worst
async function updateCompare() {
  const from = compareFrom.value;
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
    // Split the loss into the part from a worse rate and the part from the fee
    const ratePercent = Math.max(0, ((real.rate - rate) / real.rate) * 100);
    const feePercent = (fee / amount) * 100;
    offers.push({ name, rate, fee, received, loss, percent, flipped, ratePercent, feePercent });
  });

  if (!offers.length) {
    compareResults.innerHTML = '<p class="sub compare-empty">Add the rate and fee you\'ve been offered to see how it compares.</p>';
    return;
  }

  offers.sort((a, b) => b.received - a.received);
  const labels = { safe: 'Fair', caution: 'Pricey', danger: 'Rip-off' };
  const compareNotes = [
    'The offers are the rates and fees you typed in. Check them with each provider before you pay, as prices can change during the day.',
    RATE_NOTE(real.source, real.date),
    "Fair, pricey and rip-off are PayProoof's own guide, not an official standard: under 1%, 1% to 3%, and over 3% less than the real rate.",
  ];

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
            <div class="provider-gets">${money(o.received, to)}<span class="provider-loss">${o.loss > 0 ? `${money(o.loss, to)} less, ${o.percent.toFixed(1)}%` : 'Same as the real rate'}</span>${o.loss > 0 && o.fee > 0 ? `<span class="provider-split">${o.ratePercent.toFixed(1)}% from the rate, ${o.feePercent.toFixed(1)}% from the fee</span>` : ''}</div>
            <div class="provider-bar" aria-hidden="true"><span style="width:${Math.max(2, (o.received / fair) * 100).toFixed(1)}%"></span></div>
          </li>`;
      }).join('')}
    </ul>
    ${offers.length > 1 ? `
      <div class="compare-summary">
        <strong>${money(offers[0].received - offers[offers.length - 1].received, to)}</strong>
        <span>more with ${escapeHtml(offers[0].name)} than with ${escapeHtml(offers[offers.length - 1].name)}</span>
      </div>` : ''}
    ${saveButton({
      kind: 'Comparison',
      headline: offers.length > 1
        ? `${offers[0].name} gives the most: ${money(offers[0].received, to)}`
        : `${offers[0].name}: ${money(offers[0].received, to)}`,
      rows: [
        ['You send', money(amount, from)],
        ['At the real rate, with no fees', money(fair, to)],
        ...offers.map((o) => [
          `${o.name}: rate ${o.rate.toFixed(4)}, fee ${money(o.fee, from)}`,
          money(o.received, to),
        ]),
      ],
      notes: compareNotes,
    })}
    ${goodToKnow(compareNotes)}`;
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
  fillCompareCurrencies(homeSelect.value);
  updateCompare();
});
compareFrom.addEventListener('change', () => {
  fillCompareCurrencies(compareFrom.value);
  updateCompare();
});
// Swap: what you send becomes what they receive, and the other way round
document.getElementById('compareSwap').addEventListener('click', () => {
  const oldFrom = compareFrom.value;
  const oldTo = compareTo.value;
  fillCompareCurrencies(oldTo);
  compareTo.value = oldFrom;
  updateOfferLabels();
  updateCompare();
});

// Start with two empty offers to fill in
addOffer();
addOffer();

// ===== Helpers =====

// A simple card with a message in it
function messageCard(text) {
  return `<div class="card"><p class="text">${escapeHtml(text)}</p></div>`;
}

// Shows what the user sent, on the right
function addUserMessage(text, image) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = (image ? `<img src="${image}" alt="Your photo">` : '') + escapeHtml(text || '');
  chat.appendChild(div);
  scrollDown();
}

// Shows a result card in the chat
function addBotCard(html) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = html;

  // Every result gets a "Read aloud" button
  const cards = [...div.querySelectorAll('.card')];
  cards.forEach(addSpeakButton);

  chat.appendChild(div);
  scrollDown();
  if (settings.readAloud && cards.length) speak(cards.map(cardText).join(' '));
}

// Adds a "Read aloud" button to a result card
function addSpeakButton(card) {
  if (!('speechSynthesis' in window)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak-btn';
  btn.innerHTML = '<svg aria-hidden="true"><use href="#i-sound"/></svg> Read aloud';
  btn.addEventListener('click', () => speak(cardText(card)));
  card.appendChild(btn);
}

// Shows the loading dots while a check runs
function addLoading() {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = '<div class="card loading" aria-label="Checking"><span></span><span></span><span></span></div>';
  chat.appendChild(div);
  scrollDown();
  return div;
}

// Scrolls the chat to the newest message
function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

// The text of a card, without the button labels
function cardText(card) {
  const copy = card.cloneNode(true);
  copy.querySelectorAll('button').forEach((b) => b.remove());
  return copy.innerText.replace(/\s+/g, ' ').trim();
}

// Reads text out loud using the browser's voice
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-GB';
  window.speechSynthesis.speak(utterance);
}

// Shows a number as money, like £12.50
function money(value, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

// Makes text safe to put on the page
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Accessibility settings =====
// Saved in the browser so they stay the same next time

const root = document.documentElement;
const panel = document.getElementById('accessPanel');
// Settings when nothing has been changed yet
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

// Loads saved settings from the browser
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('payprooof-access') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

// Saves settings in the browser
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

// ===== Visual effects =====

// --- Banknote pattern ---
// Fine swirling lines, like the security printing on real notes
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

// --- Magnifying lens that follows the mouse ---
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

// --- Coin that moves down "How it works" as you scroll ---
const stepsList = document.getElementById('steps');
const stepItems = stepsList.querySelectorAll('.step');
let scrollTicking = false;

// Moves the coin and lights up each step as the page scrolls
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

// --- Live rate on the banknote ---
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

// --- Logo eyes follow the mouse (or your finger) ---
function setUpEyes() {
  const pupils = document.querySelectorAll('.wordmark .pupil');
  if (!pupils.length) return;
  const look = (x, y) => {
    if (document.documentElement.hasAttribute('data-reduce-motion')) return;
    pupils.forEach((pupil) => {
      const box = pupil.parentElement.getBoundingClientRect();
      const angle = Math.atan2(y - (box.top + box.height / 2), x - (box.left + box.width / 2));
      const reach = box.width * 0.2;
      pupil.style.setProperty('--px', `${Math.cos(angle) * reach}px`);
      pupil.style.setProperty('--py', `${Math.sin(angle) * reach}px`);
    });
  };
  window.addEventListener('pointermove', (e) => look(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerdown', (e) => look(e.clientX, e.clientY), { passive: true });
}

// --- Start everything ---
drawNotePattern();
setUpLens();
setUpEyes();
applySettings();
restoreChat();
fillCompareCurrencies();
updateCompare();
updateNoteRate();