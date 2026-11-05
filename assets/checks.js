/**
 * Механические проверки текста и проверка структуры работы.
 * Порт mechanics()/audit() из thesis.py без нормоконтроля оформления DOCX.
 */

const RULES = [
  {
    code: 'double_space',
    pattern: '(?<=\\S)[ \\t]{2,}(?=\\S)',
    title: 'Лишние пробелы',
    advice: 'Оставьте один пробел; для отступа используйте параметры абзаца.',
  },
  {
    code: 'space_before',
    pattern: '[^\\S\\r\\n]+(?=[,;:!?]|\\.(?!\\.))',
    title: 'Пробел перед знаком',
    advice: 'Уберите пробел перед знаком препинания. Проверьте контекст формул.',
  },
  {
    code: 'missing_space',
    pattern: '(?<=[а-яёА-ЯЁ])[,;:!?](?=[а-яёА-ЯЁ])',
    title: 'Нет пробела после знака',
    advice: 'Добавьте пробел после знака препинания.',
  },
  {
    code: 'repeat',
    pattern: '(?<![\\p{L}\\p{N}_])([а-яёА-ЯЁ]{2,})[ \\t]+\\1(?![\\p{L}\\p{N}_])',
    flags: 'iu',
    title: 'Возможный повтор слова',
    advice: 'Проверьте, нужен ли повтор одного и того же слова.',
  },
  {
    code: 'dash',
    pattern: '(?<=\\S)[ \\t]+-[ \\t]+(?=\\S)',
    title: 'Дефис вместо тире',
    advice: 'Если это пунктуационное тире, используйте «—». В формулах проверьте знак вручную.',
  },
  {
    code: 'quotes',
    pattern: '"[^"\\r\\n]{1,250}"',
    title: 'Прямые кавычки',
    advice: 'В русском тексте обычно используют «ёлочки». Проверьте цитаты и код.',
  },
  {
    code: 'mixed',
    pattern:
      '(?<![\\p{L}\\p{N}_])(?=[a-zа-яё]*[a-z])(?=[a-zа-яё]*[а-яё])[a-zа-яё]{3,}(?![\\p{L}\\p{N}_])',
    flags: 'iu',
    title: 'Смешение алфавитов',
    advice: 'В одном слове есть кириллица и латиница. Проверьте похожие буквы.',
  },
  {
    code: 'punctuation',
    pattern: '[,;:]{2,}|[!?]{3,}',
    title: 'Повтор знаков',
    advice: 'Проверьте повторяющиеся знаки препинания.',
  },
];

const COMPILED = RULES.map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, 'g' + (rule.flags || 'u')),
}));

const LIMIT = 1500;

const STRUCTURE = [
  ['Содержание', '^\\s*(?:содержание|оглавление)\\s*$'],
  ['Введение', '^\\s*введение\\.?\\s*$'],
  ['Заключение', '^\\s*заключение\\.?\\s*$'],
  [
    'Список источников',
    '^\\s*(?:библиография|библиографический список|список (?:использованн[а-я]+ )?(?:литературы|источников))\\.?\\s*$',
  ],
];

export const MANUAL_CHECKS = [
  'Титульный лист, подписи и комплект документов из LMS.',
  'Сквозная нумерация и реальные номера страниц в оглавлении (нужен рендер Word).',
  'Библиографические описания, ссылки, формулы, подписи рисунков и таблиц.',
  'Орфография, смысл, достоверность источников и аргументация. Здесь проверяются только механические признаки.',
  'Правила кафедры имеют приоритет. Проверки оформления в этой веб-версии не выполняются.',
];

export function mechanics(text) {
  const issues = [];
  const counts = {};
  for (const rule of COMPILED) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(text)) !== null) {
      if (match[0] === '') {
        rule.regex.lastIndex += 1;
        continue;
      }
      counts[rule.code] = (counts[rule.code] || 0) + 1;
      if (issues.length < LIMIT) {
        issues.push({
          code: rule.code,
          category: 'mechanical',
          severity: 'review',
          title: rule.title,
          message: rule.advice,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
  }
  issues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { issues, counts };
}

/**
 * @param {{text: string, kind: string, filename: string}} document
 * @param {object} rules профиль (не используется, оставлен для совместимости отчёта)
 */
export function audit(document, rules) {
  const { issues, counts } = mechanics(document.text);
  const checks = [];
  for (const [title, pattern] of STRUCTURE) {
    const regex = new RegExp(pattern, 'im');
    const found = regex.test(document.text);
    checks.push({
      title,
      actual: found ? 'Заголовок найден' : 'Заголовок не найден',
      expected: 'Отдельный раздел',
      status: found ? 'pass' : 'review',
    });
    if (!found) {
      issues.push({
        category: 'structure',
        severity: 'review',
        title: title + ' · проверьте наличие',
        message:
          'Не найден отдельный заголовок. Раздел может называться иначе; ' +
          'проверьте структуру по методичке.',
        start: null,
        end: null,
      });
    }
  }
  checks.push({
    title: 'Оформление DOCX (поля, шрифт, интервалы)',
    actual: null,
    expected: 'Проверьте в Word или в Python-версии приложения',
    status: 'unknown',
  });
  issues.sort((a, b) => (a.start === null ? 1 : 0) - (b.start === null ? 1 : 0) || (a.start ?? 0) - (b.start ?? 0));
  issues.forEach((issue, index) => {
    issue.id = index + 1;
  });
  const statusCounts = { pass: 0, fail: 0, unknown: 0, review: 0 };
  for (const check of checks) statusCounts[check.status] = (statusCounts[check.status] || 0) + 1;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    issues,
    mechanical_counts: counts,
    mechanical_total: total,
    mechanics_truncated: total > LIMIT,
    checks,
    status_counts: statusCounts,
    formatting_total: 0,
    structure_total: issues.filter((issue) => issue.category === 'structure').length,
    manual: MANUAL_CHECKS,
    profile: rules,
  };
}
