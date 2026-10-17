
// =====================================================================
//  PayCheck - frontend logic
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
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    currentImage = reader.result;
    previewImg.src = currentImage;
    preview.classList.remove('hidden');
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
    const html = await renderResult(result);
    loading.remove();
    addBotCard(html);
  } catch (err) {
    console.error(err);
    loading.remove();
    addBotCard(messageCard("That check didn't work. Check your internet connection and try again."));
  }
});
 
// =====================================================================
//  2. TEMPORARY: delete this whole section in Stage 5
// =====================================================================
async function analyse(text, image) {
  await new Promise((r) => setTimeout(r, 600)); // pretend to think
  return { type: 'message', text: `You sent: "${text || 'a photo'}". Real answers arrive in Stage 5.` };
}
async function renderResult(result) {
  return messageCard(result.text);
}
// ===== END TEMPORARY =====
 // =====================================================================
//  Compare providers
// =====================================================================

// Example providers. markup = how much worse than the real rate (0.025 = 2.5%)
// fee = what they charge, in the currency you send
const EXAMPLE_PROVIDERS = [
  { name: 'Wise', markup: 0, fee: (amount) => Math.max(1, amount * 0.0045) },
  { name: 'Overseas bank', markup: 0.015, fee: () => 15 },
  { name: 'UK high-street bank', markup: 0.025, fee: () => 10 },
  { name: 'Airport exchange desk', markup: 0.09, fee: () => 0 },
];

const compareAmount = document.getElementById('compareAmount');
const compareTo = document.getElementById('compareTo');
const compareFromCode = document.getElementById('compareFromCode');
const compareNote = document.getElementById('compareNote');
const compareResults = document.getElementById('compareResults');
let compareTimer = null;

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
}

// Gets each provider's result: Wise's real data if the backend has it, otherwise examples
async function getProviderQuotes(from, to, amount) {
  try {
    const res = await fetch(`/api/compare?from=${from}&to=${to}&amount=${amount}`);
    if (res.ok) {
      const data = await res.json();
      if (data.providers && data.providers.length) return { providers: data.providers, live: true };
    }
  } catch (e) {
    // No backend yet
  }

  const { rate } = await getRate(from, to);
  const providers = EXAMPLE_PROVIDERS.map((p) => {
    const fee = p.fee(amount);
    const theirRate = rate * (1 - p.markup);
    return { name: p.name, rate: theirRate, fee, received: Math.max(0, amount - fee) * theirRate };
  });
  return { providers, live: false };
}

async function updateCompare() {
  const from = homeSelect.value;
  const to = compareTo.value;
  const amount = parseFloat(compareAmount.value);

  if (!amount || amount <= 0) {
    compareResults.innerHTML = '<p class="sub">Enter an amount above 0 to compare.</p>';
    return;
  }

  try {
    const { providers, live } = await getProviderQuotes(from, to, amount);
    providers.sort((a, b) => b.received - a.received);
    const best = providers[0].received;
    const worst = providers[providers.length - 1].received;

    compareNote.textContent = live
      ? "Live prices from Wise's comparison data."
      : "Example fees, using today's real mid-market rate. Change the amount or currency to try it.";

    compareResults.innerHTML = `
      <ul class="providers">
        ${providers.map((p, i) => `
          <li class="provider ${i === 0 ? 'best' : ''}">
            <div>
              <div class="provider-name">${escapeHtml(p.name)}${live ? '' : ' (example)'}</div>
              ${i === 0 ? '<span class="provider-badge"><svg aria-hidden="true"><use href="#i-safe"/></svg>Most received</span>' : ''}
            </div>
            <div class="provider-rate">Rate ${p.rate.toFixed(4)}<br>Fee ${money(p.fee, from)}</div>
            <div class="provider-gets">${money(p.received, to)}</div>
            <div class="provider-bar" aria-hidden="true"><span style="width:${((p.received / best) * 100).toFixed(1)}%"></span></div>
          </li>`).join('')}
      </ul>
      <div class="compare-summary">
        <strong>${money(best - worst, to)}</strong>
        <span>difference between the best and worst option</span>
      </div>`;
  } catch (err) {
    console.error(err);
    compareResults.innerHTML = "<p class=\"sub\">Couldn't load today's rate. Check your internet connection and try again.</p>";
  }
}

// Wait until the user stops typing before updating
function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(updateCompare, 300);
}

compareAmount.addEventListener('input', scheduleCompare);
compareTo.addEventListener('change', updateCompare);
document.getElementById('compareForm').addEventListener('submit', (e) => e.preventDefault());
homeSelect.addEventListener('change', () => {
  fillCompareCurrencies();
  updateCompare();
});
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
    const saved = JSON.parse(localStorage.getItem('paycheck-access') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}
 
function saveSettings() {
  try {
    localStorage.setItem('paycheck-access', JSON.stringify(settings));
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
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    el.style.stroke = 'var(--line)';
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
    add('ellipse', { cx: 300, cy: 100, rx: 44, ry: 14, transform: `rotate(${i * 7.5} 300 100)`, 'stroke-width': 0.6, opacity: 0.8 });
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
 
// ---------- Start everything ----------
drawNotePattern();
setUpLens();
applySettings();
fillCompareCurrencies();
updateCompare();