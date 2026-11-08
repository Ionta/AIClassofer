/**
 * Сборка разметки отчёта и автономного HTML-файла.
 * Отчёт содержит только результат проверки на ИИ-признаки.
 * Все пользовательские строки экранируются.
 */
import { countWords } from './analyze.js';
import { MODEL_INFO } from './config.js';

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const numberFormat = new Intl.NumberFormat('ru-RU');

/** Карта текста: подсветка окон модели. */
export function highlight(result) {
  const text = result.text;
  const spans = result.spans || [];
  const points = new Set([0, text.length]);
  for (const span of spans) {
    points.add(span.start);
    points.add(span.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const parts = [];
  let index = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    while (index + 1 < spans.length && spans[index].end <= from) index += 1;
    const span =
      spans[index] && spans[index].start <= from && from < spans[index].end ? spans[index] : null;
    const value = escapeHtml(text.slice(from, to));
    if (span && span.flagged) {
      const score = span.score;
      const className = score >= 0.97 ? 'ai-vhigh' : score >= 0.9 ? 'ai-high' : 'ai-medium';
      const title = `ИИ-признаки · оценка модели ${score.toFixed(3)} (не вероятность авторства)`;
      parts.push(
        `<mark class="highlight ${className}" title="${escapeHtml(title)}">${value}</mark>`
      );
    } else {
      parts.push(value);
    }
  }
  return parts.join('');
}

function stat(label, value, description, bar) {
  return (
    `<div class="stat"><span class="label">${escapeHtml(label)}</span>` +
    `<span class="value">${escapeHtml(value)}</span>` +
    `<span class="hint">${escapeHtml(description)}</span>` +
    (bar === undefined || bar === null
      ? ''
      : `<div class="bar"><i style="width:${Math.max(0, Math.min(100, bar))}%"></i></div>`) +
    '</div>'
  );
}

export function reportBody(result, options = {}) {
  const interactive = options.interactive !== false;
  const doc = result.document || { filename: 'Текст', kind: 'text', warnings: [] };
  const sentenceMode = result.window_mode !== 'tokens';
  const perWindow = result.sentences_per_window || 3;
  const minWords = result.min_words ?? 20;
  const spans = result.spans || [];
  const total = result.text.length;
  const words = countWords(result.text);
  const assessedShare = result.assessed_share ?? 0;
  const aiLabel = result.ai_enabled === false
    ? 'Отключено'
    : !assessedShare
      ? 'Нет оценки'
      : result.highlighted_share === null
        ? '—'
        : `${result.highlighted_share}%`;
  const flaggedWindows = spans.filter((span) => span.flagged).length;
  const unscored = spans.filter((span) => span.score === null).length;

  const actions = interactive
    ? '<div class="actions no-print">' +
      '<button type="button" class="secondary small" data-action="new">← Новая проверка</button>' +
      '<button type="button" class="secondary small" data-action="html">↓ HTML</button>' +
      '<button type="button" class="secondary small" data-action="json">↓ JSON</button>' +
      '<button type="button" class="secondary small" data-action="print">Печать / PDF</button>' +
      '</div>'
    : '';

  const unscoredNotice = unscored
    ? `<p class="notice">${unscored} из ${spans.length} окон короче ${minWords} слов и не оценены. ` +
      'Увеличьте число предложений на окно или уменьшите «Минимум слов в окне» в настройках.</p>'
    : '';

  const warnings = (doc.warnings || [])
    .map((warning) => `<p class="notice info">${escapeHtml(warning)}</p>`)
    .join('');

  const spanRows = spans
    .map((span, index) => {
      const score = span.score === null ? 'Недостаточно текста' : span.score.toFixed(3);
      const verdict = span.flagged ? 'ИИ-признаки' : span.score === null ? 'Не оценено' : 'Ниже порога';
      const sentences = sentenceMode
        ? `<td>${span.sentences ? (span.split ? '1 (длинное)' : span.sentences) : '—'}</td>`
        : '';
      return (
        `<tr><td>${index + 1}</td><td>${span.start}–${span.end}</td>${sentences}` +
        `<td class="score">${escapeHtml(score)}</td><td>${escapeHtml(verdict)}</td></tr>`
      );
    })
    .join('');

  return (
    '<div class="section-head"><div class="eyebrow">' +
    `Результаты проверки / ${escapeHtml(result.created_at || '')}</div>${actions}</div>` +
    '<h1>Отчёт о вашей работе</h1>' +
    `<p class="lede file-title">${escapeHtml(doc.filename || 'Текст')}</p>` +
    `<p class="hint">${numberFormat.format(words)} слов · ${numberFormat.format(total)} символов · ` +
    `${escapeHtml((doc.kind || 'text').toUpperCase())}</p>` +
    '<div class="stats">' +
    stat('ИИ-признаки', aiLabel, 'доля непробельных символов выше порога', result.highlighted_share || 0) +
    stat('Оценено моделью', `${assessedShare}%`, 'от непробельных символов', assessedShare) +
    stat(
      'Подсвечено окон',
      `${flaggedWindows} из ${spans.length}`,
      sentenceMode ? `окна по ${perWindow} предложениям` : 'окна по токенам'
    ) +
    '</div>' +
    `<p class="notice">${escapeHtml(result.notice)}</p>` +
    '<nav class="report-nav no-print">' +
    '<a href="#text-map">01 / Карта текста</a><a href="#method">02 / Метод и ограничения</a></nav>' +
    '<div class="report-single">' +
    `<section id="text-map" class="card"><div class="section-head"><h2>Карта текста</h2>` +
    `<span class="tag">${flaggedWindows} окон с ИИ-признаками</span></div>` +
    '<div class="legend">' +
    '<span><i class="swatch" style="background:#ffecbb"></i>Выше порога</span>' +
    '<span><i class="swatch" style="background:#ffc5a8"></i>≥ 0,90</span>' +
    '<span><i class="swatch" style="background:#ffa5a0"></i>≥ 0,97</span>' +
    '</div>' +
    '<p class="hint">Наведите курсор на подсветку, чтобы увидеть оценку окна. ' +
    (sentenceMode
      ? `Окно — до ${perWindow} целых предложений (не больше ${result.window_tokens} токенов), поэтому слова и фразы не разрываются. `
      : 'Окно режется по токенам и может пересекать слова и предложения. ') +
    `Окно короче ${minWords} слов не оценивается. Неподсвеченный текст также может быть сгенерирован.</p>` +
    unscoredNotice +
    `<article class="document">${highlight(result)}</article></section>` +
    `<section id="method" class="card"><h2>Как получен результат</h2>` +
    `<p class="hint">Модель: ${escapeHtml(MODEL_INFO.repo)}<br>Ревизия: ${escapeHtml(MODEL_INFO.revision)}<br>` +
    `Порог: ${escapeHtml(String(result.threshold))} · ` +
    (sentenceMode
      ? `окно: до ${perWindow} предложений (не больше ${escapeHtml(String(result.window_tokens))} токенов). `
      : `окно: ${escapeHtml(String(result.window_tokens))} токенов. `) +
    'Оценка softmax не калибрована как вероятность авторства.</p>' +
    '<p class="hint">Процент — доля непробельных символов в окнах выше порога. Позиции в таблице — ' +
    'индексы UTF-16 JS, конец не включён. Проверка не определяет плагиат и не подтверждает авторство; ' +
    'оформление, орфография и структура работы не проверяются.</p>' +
    `<details><summary>Оценки всех фрагментов (${spans.length})</summary>` +
    '<div class="table-wrap"><table><thead><tr><th>Окно</th><th>Позиции</th>' +
    (sentenceMode ? '<th>Предложений</th>' : '') +
    '<th>Оценка модели</th><th>Результат</th></tr></thead>' +
    `<tbody>${spanRows}</tbody></table></div></details></section>` +
    '</div>' +
    '<footer class="footer">AI Text Lab · статичная версия. Отчёт содержит полный исходный текст. ' +
    'Для сохранения PDF используйте печать браузера с включённой фоновой графикой.</footer>'
  );
}

export function renderReport(container, result) {
  container.innerHTML = reportBody(result, { interactive: true });
}

export function buildStandaloneHtml(result, cssText) {
  const title = `Отчёт · ${(result.document && result.document.filename) || 'текст'}`;
  return (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><style>${cssText}</style></head>` +
    `<body><main class="container">${reportBody(result, { interactive: false })}</main></body></html>`
  );
}

export function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())} (UTC${sign}${hours}:${minutes})`
  );
}
