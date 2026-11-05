/**
 * Связка интерфейса и движка: форма → чтение документа → модель → отчёт.
 */
import { CONFIG } from './config.js';
import { ByteLevelTokenizer } from './tokenizer.js';
import { Detector } from './analyze.js';
import { Engine, resolveAsset, fetchWithProgress } from './engine.js';
import { audit } from './checks.js';
import { readFile, textDocument } from './documents.js';
import { renderReport, buildStandaloneHtml, formatDate } from './report.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  form: $('#analysis-form'),
  intro: $('#intro'),
  report: $('#report'),
  text: $('#text'),
  file: $('#file'),
  fileStatus: $('#file-status'),
  dropzone: $('#dropzone'),
  encoding: $('#encoding'),
  threshold: $('#threshold'),
  window: $('#window'),
  precision: $('#precision'),
  backend: $('#backend'),
  error: $('#error'),
  analyze: $('#analyze'),
  cancel: $('#cancel'),
  progressWrap: $('#progress-wrap'),
  progressBar: $('#progress-bar'),
  status: $('#status'),
};

const state = {
  tokenizer: null,
  engine: null,
  engineKey: null,
  detector: null,
  result: null,
  controller: null,
  busy: false,
  cssText: null,
  file: null,
};

const formatSize = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
};

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}

function clearError() {
  els.error.textContent = '';
  els.error.classList.add('hidden');
}

function setProgress(percent, status) {
  els.progressWrap.classList.remove('hidden');
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (status) els.status.textContent = status;
}

function setBusy(busy) {
  state.busy = busy;
  els.analyze.disabled = busy;
  els.analyze.textContent = busy ? 'Идёт проверка…' : 'Проверить работу →';
  els.cancel.classList.toggle('hidden', !busy);
  if (!busy) els.cancel.disabled = false;
}

async function loadTokenizer(onStatus) {
  if (state.tokenizer) return state.tokenizer;
  const resolved = await resolveAsset(CONFIG.files.tokenizer);
  onStatus(
    resolved.source === 'local' ? 'Читаем локальный токенизатор…' : 'Скачиваем tokenizer.json…'
  );
  const bytes = await fetchWithProgress(
    resolved.url,
    (loaded, total) => {
      if (total) onStatus(`Токенизатор: ${Math.round((100 * loaded) / total)}%`);
      else onStatus(`Токенизатор: ${formatSize(loaded)}`);
    },
    'tokenizer.json'
  );
  const spec = JSON.parse(new TextDecoder().decode(bytes));
  state.tokenizer = new ByteLevelTokenizer(spec);
  return state.tokenizer;
}

async function ensureDetector({ precision, backend, onStatus }) {
  const tokenizer = await loadTokenizer(onStatus);
  const key = `${precision}|${backend}`;
  if (state.detector && state.engineKey === key) return state.detector;
  if (state.engine) {
    await state.engine.dispose();
    state.engine = null;
  }
  const engine = await Engine.create({
    precision,
    backend,
    onStatus,
    onProgress: ({ phase, loaded, total }) => {
      if (phase === 'download') {
        if (total) {
          setProgress(
            Math.round((100 * loaded) / total),
            `Скачиваем веса: ${formatSize(loaded)} из ${formatSize(total)}`
          );
        } else {
          setProgress(5, `Скачиваем веса: ${formatSize(loaded)}`);
        }
      } else {
        setProgress(5, 'Инициализируем модель…');
      }
    },
  });
  state.engine = engine;
  state.engineKey = key;
  state.detector = new Detector(tokenizer, engine);
  return state.detector;
}

async function readInput() {
  const file = state.file || (els.file.files && els.file.files[0]);
  if (file) {
    const document = await readFile(file, els.encoding.value);
    document.filename = file.name;
    return document;
  }
  const text = els.text.value;
  if (!text.trim()) throw new Error('Загрузите документ или вставьте текст.');
  return textDocument(text, 'Вставленный текст');
}

function buildResult(document, analysis) {
  const result = Object.assign({}, analysis);
  result.ai_enabled = true;
  result.document = {
    filename: document.filename,
    kind: document.kind,
    encoding: document.encoding,
    paragraphs: document.paragraphs,
    warnings: document.warnings,
  };
  result.audit = audit(document, null);
  result.created_at = formatDate();
  return result;
}

async function runAnalysis() {
  if (state.busy) return;
  clearError();
  const threshold = Number(els.threshold.value);
  const windowTokens = Number(els.window.value);
  if (!Number.isFinite(threshold) || threshold < 0.01 || threshold > 0.99) {
    showError('Порог должен быть числом от 0.01 до 0.99.');
    return;
  }
  if (!Number.isInteger(windowTokens) || windowTokens < 64 || windowTokens > 510) {
    showError('Размер окна должен быть целым числом от 64 до 510.');
    return;
  }

  setBusy(true);
  setProgress(2, 'Готовимся…');
  state.controller = new AbortController();
  const started = performance.now();

  try {
    const document = await readInput();
    if (document.text.length > CONFIG.maxChars) {
      throw new Error(
        `Лимит — ${CONFIG.maxChars.toLocaleString('ru-RU')} символов. Разделите работу на части.`
      );
    }
    setProgress(4, 'Токенизируем текст…');
    const detector = await ensureDetector({
      precision: els.precision.value,
      backend: els.backend.value,
      onStatus: (message) => setProgress(4, message),
    });
    setProgress(6, 'Оцениваем окна…');
    const analysis = await detector.analyze({
      text: document.text,
      threshold,
      windowTokens,
      signal: state.controller.signal,
      onProgress: ({ done, total }) => {
        const percent = 6 + (92 * done) / total;
        const elapsed = (performance.now() - started) / 1000;
        const left = Math.max(0, Math.round((elapsed / done) * (total - done)));
        setProgress(percent, `Окно ${done} из ${total} · осталось примерно ${left} с`);
      },
    });
    const result = buildResult(document, analysis);
    state.result = result;
    renderReport(els.report, result);
    els.report.classList.remove('hidden');
    els.intro.classList.add('hidden');
    setProgress(100, 'Готово.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      setProgress(0, 'Проверка отменена.');
    } else {
      console.warn('Проверка не выполнена:', error && error.message);
      showError(error && error.message ? error.message : 'Не удалось выполнить проверку.');
      setProgress(0, 'Остановлено из-за ошибки.');
    }
  } finally {
    state.controller = null;
    setBusy(false);
    if (!els.error.textContent && els.progressBar.style.width === '100%') {
      setTimeout(() => els.progressWrap.classList.add('hidden'), 800);
    }
  }
}

async function getCssText() {
  if (state.cssText) return state.cssText;
  try {
    const response = await fetch(new URL('./style.css', import.meta.url));
    if (response.ok) state.cssText = await response.text();
  } catch (error) {
    /* ниже — минимальный запасной вариант */
  }
  if (!state.cssText) {
    state.cssText =
      'body{font:15px/1.6 Segoe UI,Arial,sans-serif;color:#202137;background:#fff;margin:0}' +
      '.container{max-width:900px;margin:auto;padding:24px}.card{margin:0 0 18px}' +
      '.document{white-space:pre-wrap;line-height:1.7}mark.ai-medium{background:#ffecbb}' +
      'mark.ai-high{background:#ffc5a8}mark.ai-vhigh{background:#ffa5a0}' +
      'mark.mechanical{box-shadow:inset 0 -2px 0 #a98ef0}.hidden{display:none}' +
      'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e4e4ee;padding:6px 8px;text-align:left}';
  }
  return state.cssText;
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stem() {
  const name = (state.result && state.result.document && state.result.document.filename) || 'текст';
  return name.replace(/\.[^.]+$/, '').slice(0, 100) || 'текст';
}

async function exportHtml() {
  if (!state.result) return;
  const css = await getCssText();
  download(
    `${stem()}-отчёт.html`,
    buildStandaloneHtml(state.result, css),
    'text/html;charset=utf-8'
  );
}

function exportJson() {
  if (!state.result) return;
  download(
    `${stem()}-отчёт.json`,
    JSON.stringify(state.result, null, 2),
    'application/json;charset=utf-8'
  );
}

function showIntro() {
  els.report.classList.add('hidden');
  els.report.innerHTML = '';
  els.intro.classList.remove('hidden');
  els.progressWrap.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyFilter(category) {
  for (const button of els.report.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === category));
  }
  for (const issue of els.report.querySelectorAll('.issue[data-category]')) {
    issue.hidden = category !== 'all' && issue.dataset.category !== category;
  }
}

function setFile(file) {
  state.file = file || null;
  if (!file) els.file.value = '';
  els.fileStatus.textContent = file
    ? `${file.name} · ${formatSize(file.size)}`
    : 'DOCX или TXT · до 10 МБ';
  if (file) els.text.value = '';
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAnalysis();
});

els.cancel.addEventListener('click', () => {
  if (state.controller) state.controller.abort();
});

els.file.addEventListener('change', () => {
  const file = els.file.files && els.file.files[0];
  setFile(file);
});

els.text.addEventListener('input', () => {
  if (els.text.value.trim() && state.file) setFile(null);
});

for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('dragover');
  });
}
els.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) setFile(file);
});

els.report.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]');
  if (action) {
    const name = action.dataset.action;
    if (name === 'new') showIntro();
    if (name === 'html') exportHtml();
    if (name === 'json') exportJson();
    if (name === 'print') window.print();
    return;
  }
  const filter = event.target.closest('[data-filter]');
  if (filter) applyFilter(filter.dataset.filter);
});

window.addEventListener('beforeprint', () => {
  for (const details of document.querySelectorAll('details')) {
    details.dataset.wasOpen = String(details.open);
    details.open = true;
  }
});
window.addEventListener('afterprint', () => {
  for (const details of document.querySelectorAll('details')) {
    if (details.dataset.wasOpen !== undefined) {
      details.open = details.dataset.wasOpen === 'true';
      delete details.dataset.wasOpen;
    }
  }
});

export { state };
