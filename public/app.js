// =====================================================================
//  PayCheck — frontend logic
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
  auto: 'Ask anything, paste a message, or add a photo…',
  convert: 'e.g. How much is €250?',
  rate: 'e.g. They offered 1.05 euros per pound for £300',
  scam: 'Paste the message or payment request here…',
};

// ---------- Mode buttons ----------
modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
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
  if (!text && !image) return;

  if (welcome) welcome.remove();
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
    addBotCard(messageCard('Sorry, something went wrong. Please try again.'));
  }
});

// ===== TEMPORARY: delete this block in Stage 5 =====
async function analyse(text, image) {
  await new Promise((r) => setTimeout(r, 600)); // pretend to think
  return { type: 'message', text: `You said: "${text || 'a photo'}". Real answers are coming in Stage 5!` };
}
async function renderResult(result) {
  return messageCard(result.text);
}
// ===== END TEMPORARY =====

// =====================================================================
//  Helpers
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
  chat.appendChild(div);
  scrollDown();
}

function addLoading() {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = '<div class="card loading"><span></span><span></span><span></span></div>';
  chat.appendChild(div);
  scrollDown();
  return div;
}

function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
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