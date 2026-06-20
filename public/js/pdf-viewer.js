/**
 * pdf-viewer.js
 * PDF.js canvas + text layer renderer.
 * Fixes: DPR-aware canvas, correct CSS variables for PDF.js TextLayer
 * percentage-based span positioning, no overflow clipping on wrapper.
 */

import * as pdfjsLib from '/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

// ── State ─────────────────────────────────────────────────────────────────────
let pdfDoc     = null;
let totalPages = 0;
let scale      = 1.4;

const container  = document.getElementById('pdfViewerContainer');
const loadingMsg = document.getElementById('pdfLoadingMsg');
const pageInfo   = document.getElementById('pageInfo');
const prevBtn    = document.getElementById('prevPage');
const nextBtn    = document.getElementById('nextPage');
const zoomInBtn  = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomLabel  = document.getElementById('zoomLabel');

// ── PDF Loading ───────────────────────────────────────────────────────────────
async function loadPDF(url) {
  try {
    const task = pdfjsLib.getDocument({ url });
    pdfDoc     = await task.promise;
    totalPages = pdfDoc.numPages;

    if (loadingMsg) loadingMsg.style.display = 'none';
    if (pageInfo)   pageInfo.textContent = `1 / ${totalPages}`;
    if (prevBtn)    prevBtn.disabled = true;
    if (nextBtn)    nextBtn.disabled = totalPages <= 1;

    await renderAllPages();
  } catch (err) {
    if (loadingMsg)
      loadingMsg.innerHTML = `<p style="color:#f87171;font-size:12px;">Failed to load PDF: ${err.message}</p>`;
    console.error('PDF load error:', err);
  }
}

async function renderAllPages() {
  container.querySelectorAll('.pdf-page-wrapper').forEach(p => p.remove());
  for (let i = 1; i <= totalPages; i++) await renderPage(i);
}

// ── Page Renderer ─────────────────────────────────────────────────────────────
//
// WHY HIGHLIGHTS APPEAR AS FRAGMENTED ISLANDS:
// ─────────────────────────────────────────────
// PDF.js TextLayer positions every character span using percentages:
//
//   span.style.left = (100 * x / pageWidth_pt)  + '%'
//   span.style.top  = (100 * y / pageHeight_pt) + '%'
//
// Internally it also calls setLayerDimensions(), which sets the text layer
// container's width/height using the CSS round() function:
//
//   width  = round(down, var(--total-scale-factor) * pageWidth_pt  px, var(--scale-round-x))
//   height = round(down, var(--total-scale-factor) * pageHeight_pt px, var(--scale-round-y))
//
// If --total-scale-factor / --scale-round-x / --scale-round-y are NOT set on
// the container, round() evaluates to 0px → container has zero dimensions →
// all % positions resolve to 0px → every span piles at the origin or
// scatters to wrong positions → the "fragmented island" highlight pattern.
//
// Additionally, if we hard-code the container's width/height in px AFTER
// TextLayer.render() runs, we override what setLayerDimensions() computed and
// break the relationship between container size and span percentages again.
//
// THE FIX:
// 1. Set --total-scale-factor, --scale-factor, --scale-round-x/y on the text
//    layer BEFORE calling TextLayer constructor.
// 2. Do NOT override the text layer's width/height after render() — let
//    setLayerDimensions() own those values.
// 3. Use a DPR-scaled viewport for the canvas backing store (crisp on HiDPI).
// 4. Use the unscaled CSS-pixel viewport for TextLayer so spans land in CSS px.
//
async function renderPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const dpr  = window.devicePixelRatio || 1;

  // CSS-pixel viewport → text layer positioning & wrapper layout dimensions
  const cssViewport  = page.getViewport({ scale });
  // Physical-pixel viewport → canvas backing store (crisp rendering on HiDPI)
  const physViewport = page.getViewport({ scale: scale * dpr });

  const cssW = Math.floor(cssViewport.width);
  const cssH = Math.floor(cssViewport.height);

  // Pixel rounding granularity: 1px standard, 1/DPR on HiDPI screens.
  // This matches what PDF.js's own web viewer (web/viewer.js) uses.
  const roundX = `${1 / dpr}px`;
  const roundY = `${1 / dpr}px`;

  // ── Wrapper ────────────────────────────────────────────────────────────────
  // overflow:visible is critical — any overflow:hidden here clips the right
  // edge of the text layer if sub-pixel drift occurs between the wrapper
  // and the CSS-computed text layer size.
  const wrapper = document.createElement('div');
  wrapper.className    = 'pdf-page-wrapper';
  wrapper.dataset.page = pageNum;
  wrapper.style.cssText = [
    'position:relative',
    `width:${cssW}px`,
    `height:${cssH}px`,
    'overflow:visible',
    'flex-shrink:0',
  ].join(';') + ';';

  // ── Canvas ─────────────────────────────────────────────────────────────────
  // Backing store uses physical pixels (physViewport) for crispness.
  // CSS size uses CSS pixels so the canvas occupies the same layout box
  // as the wrapper; the browser down-scales the hi-res bitmap automatically.
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = Math.floor(physViewport.width);
  canvas.height = Math.floor(physViewport.height);
  canvas.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    `width:${cssW}px`,
    `height:${cssH}px`,
    'display:block',
    'border-radius:3px',
  ].join(';') + ';';

  // ── Text layer ─────────────────────────────────────────────────────────────
  // Set ALL CSS variables the official PDF.js CSS expects BEFORE TextLayer
  // is constructed. The official chain (from pdf_viewer.css) is:
  //
  //   --total-scale-factor = calc(var(--scale-factor) * var(--user-unit))
  //   --text-scale-factor  = calc(var(--total-scale-factor) * var(--min-font-size))
  //   font-size per span   = calc(var(--text-scale-factor) * var(--font-height))
  //   transform per span   = rotate(--rotate) scaleX(--scale-x) scale(--min-font-size-inv)
  //
  // PDF.js sets --scale-x, --rotate, --font-height per span via JS.
  // The CSS rules in workspace.ejs read those variables and apply the actual
  // transform. Without the CSS rules, the variables are set but never consumed
  // as actual transforms — spans render at natural browser width → island gaps.
  //
  // Do NOT set explicit width/height — setLayerDimensions() inside
  // TextLayer.render() sets them via CSS round() using these variables.
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className      = 'textLayer';
  textLayerDiv.style.position = 'absolute';
  textLayerDiv.style.left     = '0px';
  textLayerDiv.style.top      = '0px';
  // Official variable chain
  textLayerDiv.style.setProperty('--scale-factor',       String(scale));
  textLayerDiv.style.setProperty('--user-unit',          '1');
  textLayerDiv.style.setProperty('--total-scale-factor', String(scale));  // explicit fallback
  textLayerDiv.style.setProperty('--scale-round-x',      roundX);
  textLayerDiv.style.setProperty('--scale-round-y',      roundY);
  textLayerDiv.innerHTML = '';

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayerDiv);
  container.appendChild(wrapper);

  // Render the canvas at physical-pixel resolution (crisp on all DPR screens)
  await page.render({ canvasContext: ctx, viewport: physViewport }).promise;

  // Render the text layer at CSS-pixel resolution so every span's percentage
  // position resolves relative to CSS pixels, matching the visible glyphs
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayerDiv,
    viewport: cssViewport,  // ← CSS viewport (NOT physViewport)
  });
  await textLayer.render();
  // ↑ After this, textLayerDiv.style.width/height are set by setLayerDimensions()
  //   using round(down, --total-scale-factor * pageWidth_pt px, --scale-round-x).
  //   Do NOT reassert them with raw px values — that would break the alignment.
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function setZoom(v) {
  scale = Math.min(3.0, Math.max(0.5, v));
  if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
  renderAllPages();
}
if (zoomInBtn)  zoomInBtn.addEventListener('click',  () => setZoom(scale + 0.2));
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(scale - 0.2));

// ── Page tracking via scroll ──────────────────────────────────────────────────
container.addEventListener('scroll', () => {
  let current = 1;
  const cRect = container.getBoundingClientRect();
  container.querySelectorAll('.pdf-page-wrapper').forEach(w => {
    if (w.getBoundingClientRect().top <= cRect.top + cRect.height / 2)
      current = parseInt(w.dataset.page);
  });
  if (pageInfo) pageInfo.textContent = `${current} / ${totalPages}`;
  if (prevBtn)  prevBtn.disabled = current <= 1;
  if (nextBtn)  nextBtn.disabled = current >= totalPages;
});

if (prevBtn) prevBtn.addEventListener('click', () => jumpPage(-1));
if (nextBtn) nextBtn.addEventListener('click', () => jumpPage(+1));

function jumpPage(delta) {
  const cur    = parseInt((pageInfo ? pageInfo.textContent : '1').split('/')[0].trim());
  const target = Math.max(1, Math.min(totalPages, cur + delta));
  container.querySelector(`[data-page="${target}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Floating selection menu ───────────────────────────────────────────────────
const menu         = document.getElementById('selectionMenu');
const shortActions = document.getElementById('shortActions');
const longActions  = document.getElementById('longActions');
const menuDivider  = document.getElementById('menuDivider');
let   selectedText = '';

function positionMenu(x, y) {
  menu.style.display = 'flex';
  requestAnimationFrame(() => {
    const mw = menu.offsetWidth  || 175;
    const mh = menu.offsetHeight || 110;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: just below-right of cursor (natural context-menu feel)
    let px = x + 6;
    let py = y + 6;

    // Flip left if the menu would overflow the right edge of the viewport
    if (px + mw > vw - 8) px = x - mw - 6;

    // Flip above if the menu would overflow the bottom edge
    if (py + mh > vh - 8) py = y - mh - 6;

    // Hard clamp to keep it fully on screen
    if (px < 8)      px = 8;
    if (py < 8)      py = 8;

    menu.style.left = `${px}px`;
    menu.style.top  = `${py}px`;
  });
}

function applyMenuMode(text) {
  const isLong = text.trim().split(/\s+/).length >= 1000;
  shortActions.style.display = isLong ? 'none' : 'flex';
  longActions.style.display  = isLong ? 'flex' : 'none';
  if (menuDivider) menuDivider.style.display = 'none';
  shortActions.style.flexDirection = 'column';
  longActions.style.flexDirection  = 'column';
}

function showMenuAt(x, y, text) {
  selectedText = text;
  applyMenuMode(text);
  positionMenu(x, y);
}

function hideMenu() {
  menu.style.display = 'none';
  selectedText       = '';
}

function isEditableTarget(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
}

// Trigger 1: immediate show on mouseup — menu appears right next to cursor
document.addEventListener('mouseup', (e) => {
  if (menu.contains(e.target)) return;
  if (isEditableTarget(e.target)) return;

  // Capture cursor position NOW before rAF delay changes it
  const cursorX = e.clientX;
  const cursorY = e.clientY;

  requestAnimationFrame(() => {
    const sel  = window.getSelection();
    const text = sel?.toString().trim() ?? '';

    if (text.length < 3) {
      sel?.removeAllRanges();
      hideMenu();
      return;
    }

    if (sel.rangeCount > 1) {
      const first = sel.getRangeAt(0);
      sel.removeAllRanges();
      sel.addRange(first);
    }

    // Position at the actual cursor, not the selection bounding rect.
    // Using rect.right placed the menu far from the cursor on wide selections.
    showMenuAt(cursorX, cursorY, text);
  });
});

// Trigger 2: right-click — suppress native menu and show ours at cursor
document.addEventListener('contextmenu', (e) => {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (text.length < 3) return;

  e.preventDefault(); // always suppress native menu when text is selected
  showMenuAt(e.clientX, e.clientY, text);
});

// Hide on outside click
document.addEventListener('mousedown', (e) => {
  if (menu.contains(e.target)) return;
  if (isEditableTarget(e.target)) { hideMenu(); return; }
  window.getSelection()?.removeAllRanges();
  hideMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!isEditableTarget(document.activeElement)) window.getSelection()?.removeAllRanges();
    hideMenu();
  }
});

// Menu action dispatch
menu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !selectedText) return;

  const action = btn.dataset.action;
  const text   = selectedText;
  window.getSelection()?.removeAllRanges();
  hideMenu();

  switch (action) {
    case 'explain':
    case 'summarize': window.aiTabs.triggerExplain(text, action); break;
    case 'quiz':
    case 'exam':      window.aiTabs.triggerQuiz(text, action);    break;
    case 'flashcards':window.aiTabs.triggerFlashcards(text);      break;
  }
});

// ── Layout refresh hook (sidebar collapse/expand) ─────────────────────────────
window.pdfViewer = {
  refreshLayout: () => { if (pdfDoc) renderAllPages(); },
};

// ── Boot ──────────────────────────────────────────────────────────────────────
if (typeof PDF_URL === 'string' && PDF_URL) {
  loadPDF(PDF_URL);
}

// ── Re-render on DPR change (window moved between screens / browser zoom) ─────
let lastDPR = window.devicePixelRatio || 1;
function watchDPR() {
  const dpr = window.devicePixelRatio || 1;
  if (Math.abs(dpr - lastDPR) > 0.01) {
    lastDPR = dpr;
    if (pdfDoc) renderAllPages();
  }
  window.matchMedia(`(resolution: ${dpr}dppx)`)
    .addEventListener('change', watchDPR, { once: true });
}
watchDPR();
