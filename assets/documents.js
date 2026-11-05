/**
 * Чтение DOCX и TXT прямо в браузере.
 * ZIP разбирается вручную, deflate распаковывается встроенным DecompressionStream,
 * XML — DOMParser. Никаких библиотек и загрузок файла на сервер.
 */

const MAX_FILE = 10 * 1024 * 1024;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SKIP = new Set(['drawing', 'pict', 'del', 'txbxContent']);

function fail(message) {
  throw new Error(message);
}

function u16(view, offset) {
  return view.getUint16(offset, true);
}
function u32(view, offset) {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(view) {
  const max = Math.min(view.byteLength, 65557);
  for (let i = view.byteLength - 22; i >= view.byteLength - max && i >= 0; i--) {
    if (u32(view, i) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    fail('Этот браузер не умеет распаковывать DOCX (нет DecompressionStream). Обновите браузер.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipArchive {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    const eocd = findEndOfCentralDirectory(this.view);
    if (eocd < 0) fail('Файл не является исправным DOCX (ZIP).');
    const count = u16(this.view, eocd + 10);
    const offset = u32(this.view, eocd + 16);
    if (count > 4096) fail('В DOCX слишком много частей.');
    this.entries = new Map();
    let total = 0;
    let pointer = offset;
    for (let i = 0; i < count; i++) {
      if (pointer + 46 > this.bytes.length) fail('Повреждённая структура DOCX.');
      if (u32(this.view, pointer) !== 0x02014b50) fail('Повреждённый каталог DOCX.');
      const method = u16(this.view, pointer + 10);
      const compressed = u32(this.view, pointer + 20);
      const size = u32(this.view, pointer + 24);
      const nameLength = u16(this.view, pointer + 28);
      const extraLength = u16(this.view, pointer + 30);
      const commentLength = u16(this.view, pointer + 32);
      const localOffset = u32(this.view, pointer + 42);
      const nameBytes = this.bytes.subarray(pointer + 46, pointer + 46 + nameLength);
      const name = new TextDecoder('utf-8').decode(nameBytes);
      total += size;
      this.entries.set(name, { method, compressed, size, localOffset });
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    if (total > 64 * 1024 * 1024) fail('Распакованный DOCX слишком большой (лимит 64 МБ).');
  }

  async read(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const local = entry.localOffset;
    if (u32(this.view, local) !== 0x04034b50) fail('Повреждённый заголовок DOCX.');
    const nameLength = u16(this.view, local + 26);
    const extraLength = u16(this.view, local + 28);
    const start = local + 30 + nameLength + extraLength;
    const data = this.bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) return data;
    if (entry.method !== 8) fail('В DOCX используется неподдерживаемое сжатие.');
    return inflateRaw(data);
  }
}

function hasAncestor(node, names) {
  let parent = node.parentNode;
  while (parent) {
    if (parent.localName && names.has(parent.localName)) return true;
    parent = parent.parentNode;
  }
  return false;
}

function paragraphText(element, doc) {
  let output = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const name = child.localName;
      if (SKIP.has(name)) continue;
      if (name === 't') {
        output += child.textContent || '';
      } else if (name === 'tab') {
        output += '\t';
      } else if (name === 'br' || name === 'cr') {
        output += '\n';
      } else {
        walk(child);
      }
    }
  };
  walk(element);
  return output;
}

export async function readDocx(file) {
  if (file.size > MAX_FILE) fail('Максимальный размер файла — 10 МБ.');
  const buffer = await file.arrayBuffer();
  const archive = new ZipArchive(buffer);
  if (!archive.entries.has('word/document.xml')) fail('В DOCX отсутствует основной документ.');
  if ([...archive.entries.keys()].some((name) => /vbaproject/i.test(name))) {
    fail('Документы с макросами не поддерживаются. Сохраните обычный DOCX.');
  }
  const xmlBytes = await archive.read('word/document.xml');
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) fail('XML документа содержит неподдерживаемые объявления.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) fail('Повреждён XML внутри DOCX.');

  const warnings = [
    'Анализируется основной текст и таблицы. Колонтитулы, сноски, текстовые поля и изображения требуют ручной проверки.',
  ];
  if (doc.getElementsByTagNameNS(W, 'ins').length || doc.getElementsByTagNameNS(W, 'del').length) {
    warnings.push('Есть исправления Word. Перед итоговой проверкой примите или отклоните их в Word.');
  }

  const paragraphs = [];
  const paragraphElements = doc.getElementsByTagNameNS(W, 'p');
  for (let i = 0; i < paragraphElements.length; i++) {
    const element = paragraphElements[i];
    if (hasAncestor(element, SKIP)) continue;
    paragraphs.push(paragraphText(element, doc));
  }
  const text = paragraphs.join('\n');
  if (!text.trim()) fail('В документе нет текста. Скан без текстового слоя не поддерживается.');
  return {
    text,
    filename: file.name,
    kind: 'docx',
    encoding: '',
    paragraphs: paragraphs.filter((value) => value.trim()).length,
    warnings,
  };
}

export function decodeText(bytes, encoding = 'auto') {
  let label = encoding;
  if (label === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    else label = 'utf-8';
  }
  try {
    return new TextDecoder(label, { fatal: label === 'utf-8' }).decode(bytes);
  } catch (error) {
    fail(
      label === 'utf-8'
        ? 'Не удалось прочитать TXT как UTF-8. Выберите кодировку Windows-1251 или UTF-16.'
        : 'Не удалось прочитать TXT в выбранной кодировке.'
    );
  }
}

export async function readTxt(file, encoding = 'auto') {
  if (file.size > MAX_FILE) fail('Максимальный размер файла — 10 МБ.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = decodeText(bytes, encoding);
  if (!text.trim()) fail('В документе нет текста.');
  return {
    text,
    filename: file.name,
    kind: 'txt',
    encoding: encoding === 'auto' ? 'auto' : encoding,
    paragraphs: text.split(/\r\n|\r|\n/).filter((line) => line.trim()).length,
    warnings: [],
  };
}

export async function readFile(file, encoding = 'auto') {
  const extension = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > MAX_FILE) fail('Максимальный размер файла — 10 МБ.');
  if (extension === 'docx') return readDocx(file);
  if (extension === 'doc') {
    fail('Старый .doc не поддерживается. В Word выберите «Сохранить как → Документ Word (.docx)».');
  }
  if (extension === 'txt') return readTxt(file, encoding);
  fail('Выберите файл .docx или .txt.');
}

export function textDocument(text, filename = 'Вставленный текст') {
  if (!text || !text.trim()) fail('Введите текст.');
  return {
    text,
    filename,
    kind: 'text',
    encoding: '',
    paragraphs: text.split(/\r\n|\r|\n/).filter((line) => line.trim()).length,
    warnings: [],
  };
}
