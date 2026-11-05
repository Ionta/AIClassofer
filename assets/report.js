/**
 * Сборка разметки отчёта и автономного HTML-файла.
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

/** Карта текста: подсветка окон модели и механических замечаний. */
export function highlight(result) {
  const text = result.text;
  const spans = result.spans || [];
  const issues = (result.audit && result.audit.issues) || [];
  const events = new Map();
  for (const issue of issues) {
    const start = issue.start;
    const end = issue.end;
    if (start === null || end === null || start === undefined || end === undefined || start >= end) continue;
    if (!events.has(start)) events.set(start, []);
    events.get(start).push({ add: true, issue });
    if (!events.has(end)) events.set(end, []);
    events.get(end).push({ add: false, issue });
  }
  const boundaries = new Set([0, text.length]);
  for (const key of events.keys()) boundaries.add(key);
  for (const span of spans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const active = new Map();
  const anchored = new Set();
  const parts = [];
  let spanIndex = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    for (const event of events.get(from) || []) {
      if (event.add) active.set(event.issue.id, event.issue);
      else active.delete(event.issue.id);
    }
    while (spanIndex + 1 < spans.length && spans[spanIndex].end <= from) spanIndex += 1;
    const span = spans[spanIndex] && spans[spanIndex].start <= from && from < spans[spanIndex].end
      ? spans[spanIndex]
      : null;

    const classes = [];
    const labels = [];
    if (span && span.flagged) {
      const score = span.score;
      classes.push(score >= 0.97 ? 'ai-vhigh' : score >= 0.9 ? 'ai-high' : 'ai-medium');
      labels.push(
        `ИИ-признаки · оценка модели ${score.toFixed(3)} (не вероятность авторства)`
      );
    }
    const values = [...active.values()];
    if (values.some((issue) => issue.category === 'mechanical')) classes.push('mechanical');
    if (values.some((issue) => issue.category === 'formatting')) classes.push('formatting');
    for (const issue of values.slice(0, 6)) labels.push(`${issue.title}: ${issue.message}`);

    let anchors = '';
    for (const issue of values) {
      if (!anchored.has(issue.id)) {
        anchors += `<span id="text-${issue.id}"></span>`;
        anchored.add(issue.id);
      }
    }
    const value = escapeHtml(text.slice(from, to));
    if (classes.length) {
      parts.push(
        `${anchors}<mark class="highlight ${classes.join(' ')}" title="${escapeHtml(labels.join(' · '))}">${value}</mark>`
      );
    } else {
      parts.push(anchors + value);
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

const CATEGORY_NAMES = {
  mechanical: 'Механика',
  formatting: 'Оформление',
  structure: 'Структура',
};

const STATUS_NAMES = {
  pass: 'Соответствует',
  fail: 'Отклонение',
  unknown: 'Не проверено',
  review: 'Проверьте вручную',
};

export function reportBody(result, options = {}) {
  const interactive = options.interactive !== false;
  const audit = result.audit || {
    issues: [],
    checks: [],
    status_counts: {},
    mechanical_total: 0,
    structure_total: 0,
    manual: [],
  };
  const doc = result.document || { filename: 'Текст', kind: 'text', warnings: [] };
  const total = result.text.length;
  const words = countWords(result.text);
  const ai = result.highlighted_share;
  const aiLabel = result.ai_enabled === false
    ? 'Отключено'
    : !result.assessed_share
      ? 'Нет оценки'
      : (ai === null ? '—' : `${ai}%`);
  const flaggedWindows = (result.spans || []).filter((span) => span.flagged).length;
  const actions = interactive
    ? '<div class="actions no-print">' +
      '<button type="button" class="secondary small" data-action="new">← Новая проверка</button>' +
      '<button type="button" class="secondary small" data-action="html">↓ HTML</button>' +
      '<button type="button" class="secondary small" data-action="json">↓ JSON</button>' +
      '<button type="button" class="secondary small" data-action="print">Печать / PDF</button>' +
      '</div>'
    : '';

  const issuesHtml = [];
  for (const issue of audit.issues) {
    const category = CATEGORY_NAMES[issue.category] || issue.category;
    const anchor = issue.start === null || issue.start === undefined
      ? ''
      : `<blockquote>${escapeHtml(
          result.text.slice(
            Math.max(0, issue.start - 35),
            Math.min(total, Math.max(issue.end, issue.start + 70))
          )
        )}</blockquote><a href="#text-${issue.id}">К месту в тексте ↑</a>`;
    issuesHtml.push(
      `<div class="issue" id="issue-${issue.id}" data-category="${escapeHtml(issue.category)}">` +
        `<span class="tag review">${escapeHtml(category)}</span>` +
        `<h3>${escapeHtml(issue.title)}</h3>` +
        `<p>${escapeHtml(issue.message)}</p>${anchor}</div>`
    );
  }

  const checkRows = audit.checks
    .map(
      (check) =>
        '<tr>' +
        `<td>${escapeHtml(check.title)}</td>` +
        `<td>${escapeHtml(check.actual === null || check.actual === undefined ? 'Не удалось определить' : check.actual)}</td>` +
        `<td>${escapeHtml(check.expected)}</td>` +
        `<td><span class="tag ${escapeHtml(check.status)}">${escapeHtml(STATUS_NAMES[check.status] || check.status)}</span></td>` +
        '</tr>'
    )
    .join('');

  const spanRows = (result.spans || [])
    .map((span, index) => {
      const score = span.score === null ? 'Недостаточно текста' : span.score.toFixed(3);
      const verdict = span.flagged ? 'ИИ-признаки' : span.score === null ? 'Не оценено' : 'Ниже порога';
      return (
        `<tr><td>${index + 1}</td><td>${span.start}–${span.end}</td>` +
        `<td class="score">${escapeHtml(score)}</td><td>${escapeHtml(verdict)}</td></tr>`
      );
    })
    .join('');

  const counts = audit.status_counts || {};
  const summary = ['pass', 'fail', 'unknown', 'review']
    .map((key) => `${counts[key] || 0} ${
      { pass: 'соответствует', fail: 'отклонений', unknown: 'не проверено', review: 'для ручной проверки' }[key]
    }`)
    .join(' · ');

  const warnings = (doc.warnings || [])
    .map((warning) => `<p class="notice info">${escapeHtml(warning)}</p>`)
    .join('');

  const truncated = audit.mechanics_truncated
    ? '<p class="notice">Механических замечаний больше 1500: в списке показаны первые 1500 найденных мест, счётчик включает все совпадения.</p>'
    : '';

  const filters = interactive
    ? '<div class="filters no-print">' +
      '<button type="button" class="filter" data-filter="all" aria-pressed="true">Все</button>' +
      '<button type="button" class="filter" data-filter="mechanical" aria-pressed="false">Механика</button>' +
      '<button type="button" class="filter" data-filter="structure" aria-pressed="false">Структура</button>' +
      '</div>'
    : '';

  return (
    '<div class="section-head"><div class="eyebrow">' +
    `Результаты проверки / ${escapeHtml(result.created_at || '')}</div>${actions}</div>` +
    '<h1>Отчёт о вашей работе</h1>' +
    `<p class="lede file-title">${escapeHtml(doc.filename || 'Текст')}</p>` +
    `<p class="hint">${numberFormat.format(words)} слов · ${numberFormat.format(total)} символов · ` +
    `${escapeHtml((doc.kind || 'text').toUpperCase())}</p>` +
    '<div class="stats">' +
    stat('ИИ-признаки', aiLabel, `${flaggedWindows} подсвеченных окон`, ai || 0) +
    stat('Оценено моделью', `${result.assessed_share}%`, 'от непробельных символов', result.assessed_share) +
    stat('Механические замечания', String(audit.mechanical_total || 0), 'мест для внимательной вычитки') +
    stat('Структура', String(audit.structure_total || 0), 'замечаний по разделам') +
    '</div>' +
    `<p class="notice">${escapeHtml(result.notice)}</p>` +
    '<nav class="report-nav no-print">' +
    '<a href="#text-map">01 / Карта текста</a><a href="#compliance">02 / Проверки</a>' +
    '<a href="#method">03 / Метод и ограничения</a></nav>' +
    '<div class="grid"><div>' +
    `<section id="text-map" class="card"><div class="section-head"><h2>Карта текста</h2>` +
    `<span class="tag">${flaggedWindows} окон с ИИ-признаками</span></div>` +
    '<div class="legend">' +
    '<span><i class="swatch" style="background:#ffecbb"></i>Выше порога</span>' +
    '<span><i class="swatch" style="background:#ffc5a8"></i>≥ 0,90</span>' +
    '<span><i class="swatch" style="background:#ffa5a0"></i>≥ 0,97</span>' +
    '<span><i class="swatch" style="background:#d9d2fa"></i>Механика / структура</span>' +
    '</div>' +
    '<p class="hint">Наведите курсор на подсветку, чтобы увидеть замечание. Окно короче 20 слов не оценивается. ' +
    'Неподсвеченный текст также может быть сгенерирован.</p>' +
    `<article class="document">${highlight(result)}</article></section>` +
    `<section id="compliance" class="card"><h2>Проверки структуры и механики</h2>` +
    `<p class="hint">${escapeHtml(summary)}</p>${warnings}` +
    '<p class="hint">Проверка оформления DOCX (шрифты, поля, интервалы) в этой веб-версии не выполняется: ' +
    'она осталась в Python-приложении.</p>' +
    `<details><summary>Все измерения и результаты (${audit.checks.length})</summary>` +
    '<div class="table-wrap"><table><thead><tr><th>Параметр</th><th>В документе</th><th>Ожидается</th><th>Статус</th></tr></thead>' +
    `<tbody>${checkRows}</tbody></table></div></details></section>` +
    `<section class="card"><h2>Перед сдачей проверьте вручную</h2><ul class="checklist">` +
    (audit.manual || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') +
    '</ul></section>' +
    `<section id="method" class="card"><h2>Как получен результат</h2>` +
    `<p class="hint">Модель: ${escapeHtml(MODEL_INFO.repo)}<br>Ревизия: ${escapeHtml(MODEL_INFO.revision)}<br>` +
    `Порог: ${escapeHtml(String(result.threshold))} · окно: ${escapeHtml(String(result.window_tokens))} токенов. ` +
    'Оценка softmax не калибрована как вероятность авторства.</p>' +
    '<p class="hint">Процент — доля непробельных символов в окнах выше порога. Окна идут по токенам и могут ' +
    'пересекать слова и предложения. Позиции в таблице — индексы UTF-16 JS, конец не включён. ' +
    'Проверка не определяет плагиат и не заменяет нормоконтроль кафедры.</p>' +
    `<details><summary>Оценки всех фрагментов (${(result.spans || []).length})</summary>` +
    '<div class="table-wrap"><table><thead><tr><th>Окно</th><th>Позиции</th><th>Оценка модели</th><th>Результат</th></tr></thead>' +
    `<tbody>${spanRows}</tbody></table></div></details></section>` +
    '</div><aside class="sticky card report-side"><h2>Что поправить</h2>' +
    '<p class="hint">Откройте место в тексте и проверьте рекомендацию по контексту.</p>' +
    filters +
    truncated +
    (issuesHtml.length
      ? issuesHtml.join('')
      : '<p class="hint">Замечаний по выполненным проверкам не найдено. Проверьте пункты, требующие ручного просмотра.</p>') +
    '</aside></div>' +
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
