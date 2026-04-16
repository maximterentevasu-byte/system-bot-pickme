require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');
const { Readable } = require('stream');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ===== GOOGLE =====

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ],
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const SPREADSHEET_ID = '1MfHUleOrA6aV95tnBKyBywe3bSO9PmdCvX8OaMvGz1A';
const TABLE_URL =
  'https://docs.google.com/spreadsheets/d/1MfHUleOrA6aV95tnBKyBywe3bSO9PmdCvX8OaMvGz1A/edit';
const SHEET_RANGE = 'RUSIFIK!A1';
const BARCODE_COLUMN_RANGE = 'RUSIFIK!E:E';

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// ===== SESSION =====

const sessions = new Map();
const cache = new Map();

const INITIAL_MAX_PHOTOS = 5;
const RETRY_MAX_PHOTOS = 10;
const CATALOG_MAX_PHOTOS = 3;

function mainMenuKeyboard() {
  return Markup.keyboard([
    ['Добавить новый товар в таблицу'],
    ['Каталог товаров'],
    ['Открыть таблицу'],
  ]).resize();
}

function productKeyboard() {
  return Markup.keyboard([
    ['Готово'],
    ['Очистить'],
    ['Открыть таблицу'],
    ['⬅️ Главное меню'],
  ]).resize();
}

function catalogKeyboard() {
  return Markup.keyboard([
    ['Найти товар'],
    ['Очистить'],
    ['Открыть таблицу'],
    ['⬅️ Главное меню'],
  ]).resize();
}

function tableButton() {
  return Markup.inlineKeyboard([
    [Markup.button.url('Перейти в Google Sheets', TABLE_URL)],
  ]);
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      photos: [],
      processing: false,
      barcodeRetryMode: false,
      mode: 'main',
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId, mode = 'main') {
  sessions.set(chatId, {
    photos: [],
    processing: false,
    barcodeRetryMode: false,
    mode,
  });
}

function clearSessionPhotos(chatId) {
  const session = getSession(chatId);
  session.photos = [];
  session.processing = false;
  session.barcodeRetryMode = false;
  return session;
}

// ===== HELPERS =====

function normalizeBarcode(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidEan13(barcode) {
  const digitsOnly = normalizeBarcode(barcode);

  if (!/^\d{13}$/.test(digitsOnly)) {
    return false;
  }

  const digits = digitsOnly.split('').map(Number);
  const checkDigit = digits[12];

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }

  const calculated = (10 - (sum % 10)) % 10;
  return calculated === checkDigit;
}

function cleanJsonText(text) {
  if (!text) return '';

  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  return cleaned.trim();
}

function parseModelJson(rawText) {
  const cleaned = cleanJsonText(rawText);

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error('Не удалось распарсить JSON модели');
  }
}

function barcodeMatches(sheetBarcode, targetBarcode) {
  const left = normalizeBarcode(sheetBarcode);
  const right = normalizeBarcode(targetBarcode);

  if (!left || !right) return false;
  if (left === right) return true;

  // На случай, если Google Sheets ранее сохранил ШК числом и отбросил ведущий ноль.
  if (left.length === 12 && right.length === 13 && right.startsWith('0') && right.slice(1) === left) {
    return true;
  }

  if (right.length === 12 && left.length === 13 && left.startsWith('0') && left.slice(1) === right) {
    return true;
  }

  return false;
}

function columnToLetter(columnNumber) {
  let result = '';
  let n = Number(columnNumber);
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function makeSingleCellUpdate(rowNumber, columnNumber, value) {
  return {
    range: `RUSIFIK!${columnToLetter(columnNumber)}${rowNumber}`,
    values: [[value]],
  };
}

let rusifikSheetIdCache = null;

async function getRusifikSheetId() {
  if (rusifikSheetIdCache !== null) return rusifikSheetIdCache;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const targetSheet = (meta.data.sheets || []).find((sheet) => {
    return sheet.properties && sheet.properties.title === 'RUSIFIK';
  });

  if (!targetSheet || !targetSheet.properties || targetSheet.properties.sheetId === undefined) {
    throw new Error('Не найден лист RUSIFIK в Google Sheets');
  }

  rusifikSheetIdCache = targetSheet.properties.sheetId;
  return rusifikSheetIdCache;
}

async function copyIJFromPreviousRow(targetRowNumber) {
  if (targetRowNumber <= 2) return;

  const sheetId = await getRusifikSheetId();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: targetRowNumber - 2,
              endRowIndex: targetRowNumber - 1,
              startColumnIndex: 8,
              endColumnIndex: 10,
            },
            destination: {
              sheetId,
              startRowIndex: targetRowNumber - 1,
              endRowIndex: targetRowNumber,
              startColumnIndex: 8,
              endColumnIndex: 10,
            },
            pasteType: 'PASTE_NORMAL',
            pasteOrientation: 'NORMAL',
          },
        },
      ],
    },
  });
}


function normalizeText(value, fallback = 'не указано') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeShu(value, rangeFallback = '0-500') {
  const raw = String(value || '').replace(/[^\d]/g, '');
  if (!raw) return 'не указано';
  return raw;
}

function normalizePh(value, fallback = 'не указано') {
  const text = String(value || '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '')
    .trim();

  if (!text) return fallback;

  const num = Number(text);
  if (!Number.isFinite(num)) return fallback;

  return num.toFixed(1);
}

function classifySpicinessByShu(shu) {
  const num = Number(shu);
  if (!Number.isFinite(num)) {
    return { label: 'Не острое', range: '0-500' };
  }

  if (num <= 500) return { label: 'Не острое', range: '0-500' };
  if (num <= 2500) return { label: 'Слабо острое', range: '501-2500' };
  if (num <= 15000) return { label: 'Средне острое', range: '2501-15000' };
  if (num <= 50000) return { label: 'Острое', range: '15001-50000' };
  return { label: 'Очень острое', range: '50001+' };
}

function classifyAcidityByPh(ph) {
  const num = Number(ph);
  if (!Number.isFinite(num)) {
    return { label: 'Слабо кислое', range: '4.1-5.0' };
  }

  if (num <= 3.0) return { label: 'Очень кислое', range: '0-3.0' };
  if (num <= 4.0) return { label: 'Кислое', range: '3.1-4.0' };
  if (num <= 5.0) return { label: 'Средне кислое', range: '4.1-5.0' };
  if (num <= 6.0) return { label: 'Слабо кислое', range: '5.1-6.0' };
  return { label: 'Не кислое', range: '6.1-7.0' };
}

function sanitizeSpiceAcidResult(result) {
  const rawShu = normalizeShu(result?.spiciness?.estimated_shu);
  const rawPh = normalizePh(result?.acidity?.estimated_ph);

  const spicinessAuto = classifySpicinessByShu(rawShu);
  const acidityAuto = classifyAcidityByPh(rawPh);

  return {
    product_type: normalizeText(result?.product_type),
    spiciness: {
      level_label: spicinessAuto.label,
      estimated_shu: rawShu,
      shu_range: spicinessAuto.range,
    },
    acidity: {
      level_label: acidityAuto.label,
      estimated_ph: rawPh,
      ph_range: acidityAuto.range,
    },
    confidence: normalizeText(result?.confidence, 'средняя'),
    warnings: normalizeText(result?.warnings, 'нет'),
    reasoning: normalizeText(result?.reasoning),
  };
}

function formatSpiceAcidFields(result) {
  return {
    spice: [
      `Категория: ${result.spiciness.level_label}`,
      `Scoville (SHU): ${result.spiciness.estimated_shu}`,
      `Шкала: ${result.spiciness.shu_range}`,
    ].join('\n'),
    acid: [
      `Категория: ${result.acidity.level_label}`,
      `pH: ${result.acidity.estimated_ph}`,
      `Шкала: ${result.acidity.ph_range}`,
    ].join('\n'),
  };
}

async function analyzeSpiceAcid(data) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: `Ты эксперт по анализу пищевых товаров.
Определи только оценочную остроту и кислотность товара по уже извлечённым данным о товаре.
Не анализируй фото напрямую, опирайся на название, описание, состав, детали, производителя и тип продукта.
Это нужно, чтобы результат для одного и того же товара был максимально стабильным.

Правила:
- Ответ только JSON, без markdown и пояснений.
- Не выдумывай экстремальные значения без явных признаков.
- Если точных данных нет, дай осторожную оценку по типу продукта, вкусу и ингредиентам.
- estimated_shu укажи числом без единиц либо "не указано".
- estimated_ph укажи числом с точкой либо "не указано".
- reasoning коротко, 1-2 предложения.

Шкала остроты:
- Не острое: 0-500
- Слабо острое: 501-2500
- Средне острое: 2501-15000
- Острое: 15001-50000
- Очень острое: 50001+

Шкала кислотности:
- Не кислое: 6.1-7.0
- Слабо кислое: 5.1-6.0
- Средне кислое: 4.1-5.0
- Кислое: 3.1-4.0
- Очень кислое: 0-3.0

Верни JSON:
{
  "product_type": "",
  "spiciness": {
    "estimated_shu": ""
  },
  "acidity": {
    "estimated_ph": ""
  },
  "confidence": "высокая | средняя | низкая",
  "warnings": "",
  "reasoning": ""
}

Данные о товаре:
Название: ${data.name || 'не указано'}
Описание: ${data.description || 'не указано'}
Детали: ${data.details || 'не указано'}
Производитель: ${data.manufacturer || 'не указано'}
Штрихкод: ${data.barcode || 'не указано'}`
      }]
    }]
  });

  const parsed = parseModelJson(response.output_text);
  return sanitizeSpiceAcidResult(parsed);
}

async function generateExtraFields(data) {
  const [spiceAcid, contentResponse] = await Promise.all([
    analyzeSpiceAcid(data),
    openai.responses.create({
      model: OPENAI_MODEL,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: `Ты анализируешь продукт для карточки товара.
Верни только JSON без markdown и пояснений.
Все поля только на русском языке.
Не оставляй пустые поля: если точных данных нет, аккуратно укажи "не указано".

Нужно вернуть JSON строго такого формата:
{
  "k": "Вкусовые характеристики товара / описание вкуса / описание визуала / кому понравится товар / всё важное для принятия решения о покупке.",
  "l": "Как приготовить / как употреблять (готов к употреблению или нужно готовить) / самостоятельное блюдо или нет / с чем сочетается.",
  "m": "Самый популярный рецепт приготовления / ссылка на рецепт на русском языке, если есть, иначе напиши: Ссылка: не указано"
}

Требования:
- Поле k: укажи вкус, текстуру, визуал, кому понравится товар и что важно знать перед покупкой.
- Поле l: укажи как употреблять, нужно ли готовить, можно ли есть как самостоятельный продукт и с чем сочетается.
- Поле m: укажи самый популярный способ приготовления или подачи и отдельной строкой ссылку в формате: Ссылка: ...
- Если ссылка неизвестна, пиши: Ссылка: не указано

Данные о товаре:
Название: ${data.name || 'не указано'}
Описание: ${data.description || 'не указано'}
Детали: ${data.details || 'не указано'}
Производитель: ${data.manufacturer || 'не указано'}
Штрихкод: ${data.barcode || 'не указано'}`
        }]
      }]
    })
  ]);

  const contentParsed = parseModelJson(contentResponse.output_text);
  const spiceFields = formatSpiceAcidFields(spiceAcid);

  return {
    spice: spiceFields.spice,
    acid: spiceFields.acid,
    k: String(contentParsed?.k || '').trim(),
    l: String(contentParsed?.l || '').trim(),
    m: String(contentParsed?.m || '').trim(),
  };
}

function getPhotoLimit(session) {
  return session.barcodeRetryMode ? RETRY_MAX_PHOTOS : INITIAL_MAX_PHOTOS;
}

function makeImageCacheHash(imageDataUrls) {
  const hash = crypto.createHash('md5');
  for (const item of imageDataUrls) {
    hash.update(item);
  }
  return hash.digest('hex');
}

function getBarcodeRetryMessage() {
  return (
    '❌ Штрихкод не удалось распознать однозначно.\n\n' +
    'Пожалуйста, пришли ещё фото только зоны штрихкода.\n\n' +
    'Рекомендации:\n' +
    '• снимай штрихкод крупно, почти на весь кадр;\n' +
    '• без бликов и засветов;\n' +
    '• без размытия;\n' +
    '• цифры под штрихкодом должны быть видны полностью.\n\n' +
    'После этого снова нажми "Готово".'
  );
}


async function extractBarcodeFromImages(images) {
  const content = [
    {
      type: 'input_text',
      text: `Ты извлекаешь только штрихкод товара с фотографии.

Правила:
- Ответ только JSON без markdown и пояснений.
- Верни поле barcode.
- Если штрихкод не виден чётко или есть сомнение хотя бы в одной цифре, верни "не найден".
- Штрихкод должен быть только из 13 цифр, без пробелов и символов.

Формат ответа:
{
  "barcode": ""
}`
    },
  ];

  for (const img of images) {
    content.push({
      type: 'input_image',
      image_url: img,
      detail: 'low',
    });
  }

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [{ role: 'user', content }],
  });

  const parsed = parseModelJson(response.output_text);
  return normalizeBarcode(parsed?.barcode);
}

async function findRowByBarcode(barcode) {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'RUSIFIK!A:M',
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const rows = res.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (barcodeMatches(rows[i][4], normalized)) {
      return { rowIndex: i, rowNumber: i + 1, row: rows[i] };
    }
  }

  return null;
}

function formatCatalogResponse(row) {
  const parts = [
    ['I', row[8]],
    ['G', row[6]],
    ['H', row[7]],
    ['K', row[10]],
    ['L', row[11]],
    ['M', row[12]],
    ['J', row[9]],
  ].map(([col, value]) => `${col}:\n${String(value || 'не указано').trim() || 'не указано'}`);

  return parts.join('\n\n');
}

// ===== TELEGRAM FILES =====

async function getTelegramFileMeta(fileId) {
  const fileInfo = await bot.telegram.getFile(fileId);
  const fileLink = await bot.telegram.getFileLink(fileId);

  const response = await axios.get(fileLink.href, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });

  const filePath = String(fileInfo?.file_path || '').toLowerCase();

  let mimeType = response.headers['content-type'] || 'image/jpeg';
  if (!mimeType.startsWith('image/')) {
    if (filePath.endsWith('.png')) mimeType = 'image/png';
    else if (filePath.endsWith('.webp')) mimeType = 'image/webp';
    else mimeType = 'image/jpeg';
  }

  let extension = 'jpg';
  if (mimeType === 'image/png') extension = 'png';
  if (mimeType === 'image/webp') extension = 'webp';

  return {
    buffer: Buffer.from(response.data),
    mimeType,
    extension,
  };
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

// ===== OPENAI =====

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
Ты эксперт по созданию карточек товаров для маркетплейсов.

СТРОГИЕ ПРАВИЛА:
- Все поля должны быть только на русском языке.
- Обязательно переводи текст с китайского, английского и корейского.
- Нельзя оставлять английский текст в name, description, details, manufacturer.
- Штрихкод нельзя угадывать.
- Если штрихкод виден нечетко, частично, с бликами, перекрыт или есть сомнения хотя бы в одной цифре — возвращай "barcode": "не найден".
- Возвращай только JSON без markdown, без пояснений и без \`\`\`.

Формат ответа:
{
  "name": "",
  "description": "",
  "details": "",
  "manufacturer": "",
  "barcode": ""
}

ТРЕБОВАНИЯ К ПОЛЯМ:

1. name
- Придумай красивое, понятное и продающее название товара на русском языке.
- Название должно формироваться по смыслу товара, по надписям на упаковке, составу, вкусу, назначению и визуалу товара.
- Не нужно дословно копировать текст с упаковки.
- Название должно выглядеть как готовое название товара для маркетплейса.
- Можно добавлять уточнение вкуса, формата, типа товара или ключевой особенности, если это видно по фото.
- Убирай мусорные слова, служебные фразы, случайные надписи и рекламные крики с упаковки.
- Не оставляй название на английском.
- Примеры хорошего стиля:
  "Кислые фруктовые конфеты ассорти"
  "Жевательный мармелад со вкусом винограда"
  "Хрустящие рисовые снеки с морской солью"
  "Молочный напиток с клубничным вкусом"

2. description
- Напиши красивое продающее описание как для маркетплейса.
- 2–3 предложения.
- Простым, понятным и привлекательным языком.
- Описание должно быстро объяснять покупателю вкус, формат товара и его преимущества.
- Не используй спам-рекламу.
- Не выдумывай свойства, которых нет на упаковке.

3. details
- Укажи состав, КБЖУ, срок хранения.
- Всё только на русском языке.
- Собери максимально полно из фото.

4. manufacturer
- Красиво переведи производителя на русский язык.
- Если это китайская или иностранная компания, сделай запись читаемой для русскоязычного пользователя.
- Пример:
  "Chaozhou Chaoan Hongtaiji Food Co. Ltd"
  →
  "Компания Hongtaiji Food, город Чаочжоу, Китай"

5. barcode
- Только цифры, 13 символов, без пробелов и знаков.
- Если нет уверенности в штрихкоде — "не найден".

ОБЩИЕ ПРАВИЛА:
- Если данных для поля нет — "не указано".
- Ответ должен быть только JSON.
      `.trim(),
    },
  ];

  for (const img of images) {
    content.push({
      type: 'input_image',
      image_url: img,
      detail: 'low',
    });
  }

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [{ role: 'user', content }],
  });

  return response.output_text;
}

// ===== GOOGLE SHEETS / DRIVE =====

async function getAllBarcodes() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: BARCODE_COLUMN_RANGE,
  });

  return (res.data.values || [])
    .flat()
    .map(normalizeBarcode)
    .filter(Boolean);
}

async function uploadPhotoToDrive(buffer, mimeType, fileName) {
  if (!DRIVE_FOLDER_ID) {
    return '';
  }

  const fileMetadata = {
    name: fileName,
    parents: [DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType,
    body: Readable.from(buffer),
  };

  const created = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id',
  });

  const fileId = created.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}



async function writeToGoogleSheets(data, photoUrl) {
  const photoCellValue = photoUrl ? `=IMAGE("${photoUrl}")` : '';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'RUSIFIK!A:M',
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const rows = res.data.values || [];
  const barcode = normalizeBarcode(data.barcode);

  let rowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    if (barcodeMatches(rows[i][4], barcode)) {
      rowIndex = i;
      break;
    }
  }

  const extra = await generateExtraFields(data);

  function isEmptyCell(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'RUSIFIK!A:M',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          data.name || '',
          data.description || '',
          data.details || '',
          data.manufacturer || '',
          `'${barcode}`,
          photoCellValue,
          extra.spice || '',
          extra.acid || '',
          '',
          '',
          extra.k || '',
          extra.l || '',
          extra.m || '',
        ]],
      },
    });

    const afterAppend = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'RUSIFIK!A:M',
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const afterRows = afterAppend.data.values || [];
    let newRowIndex = -1;
    for (let i = afterRows.length - 1; i >= 1; i--) {
      if (barcodeMatches(afterRows[i][4], barcode)) {
        newRowIndex = i;
        break;
      }
    }

    if (newRowIndex !== -1) {
      const newRowNumber = newRowIndex + 1;
      const previousRow = afterRows[newRowIndex - 1] || [];
      const currentRow = afterRows[newRowIndex] || [];
      const shouldCopyIJ = newRowIndex > 1 && (!isEmptyCell(previousRow[8]) || !isEmptyCell(previousRow[9]));

      if (shouldCopyIJ && isEmptyCell(currentRow[8]) && isEmptyCell(currentRow[9])) {
        await copyIJFromPreviousRow(newRowNumber);
      }
    }
    return;
  }

  const row = rows[rowIndex] || [];
  const rowNumber = rowIndex + 1;
  const cellUpdates = [];

  function queueIfEmpty(columnNumber, currentValue, nextValue) {
    if (!isEmptyCell(nextValue) && isEmptyCell(currentValue)) {
      cellUpdates.push(makeSingleCellUpdate(rowNumber, columnNumber, nextValue));
    }
  }

  queueIfEmpty(1, row[0], data.name || '');
  queueIfEmpty(2, row[1], data.description || '');
  queueIfEmpty(3, row[2], data.details || '');
  queueIfEmpty(4, row[3], data.manufacturer || '');
  queueIfEmpty(5, row[4], `'${barcode}`);
  queueIfEmpty(6, row[5], photoCellValue);
  queueIfEmpty(7, row[6], extra.spice || '');
  queueIfEmpty(8, row[7], extra.acid || '');
  queueIfEmpty(11, row[10], extra.k || '');
  queueIfEmpty(12, row[11], extra.l || '');
  queueIfEmpty(13, row[12], extra.m || '');

  if (cellUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: cellUpdates,
      },
    });
  }
}


// ===== BOT =====

bot.start(async (ctx) => {
  resetSession(ctx.chat.id, 'main');
  await ctx.reply('Главное меню:', mainMenuKeyboard());
});

bot.hears('Открыть таблицу', async (ctx) => {
  await ctx.reply('Открыть Google Sheets:', tableButton());
});

bot.hears('Добавить новый товар в таблицу', async (ctx) => {
  resetSession(ctx.chat.id, 'add');
  await ctx.reply('Подгрузи фотографии товара. Можно добавить до 5 фото, затем нажми "Готово".', productKeyboard());
});

bot.hears('Каталог товаров', async (ctx) => {
  resetSession(ctx.chat.id, 'catalog');
  await ctx.reply('Пришли фото штрихкода товара. Можно добавить до 3 фото, затем нажми "Найти товар".', catalogKeyboard());
});

bot.hears('⬅️ Главное меню', async (ctx) => {
  resetSession(ctx.chat.id, 'main');
  await ctx.reply('Главное меню:', mainMenuKeyboard());
});

bot.hears('Очистить', async (ctx) => {
  const session = clearSessionPhotos(ctx.chat.id);

  if (session.mode === 'catalog') {
    await ctx.reply('Фото очищены. Пришли фото штрихкода заново.', catalogKeyboard());
    return;
  }

  if (session.mode === 'add') {
    await ctx.reply('Все загруженные фото очищены. Подгрузи фотографии товара заново.', productKeyboard());
    return;
  }

  await ctx.reply('Главное меню:', mainMenuKeyboard());
});

bot.on('photo', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю текущую пачку фото.');
    return;
  }

  if (session.mode !== 'add' && session.mode !== 'catalog') {
    await ctx.reply('Сначала выбери раздел в главном меню.', mainMenuKeyboard());
    return;
  }

  const currentLimit = session.mode === 'catalog' ? CATALOG_MAX_PHOTOS : getPhotoLimit(session);

  if (session.photos.length >= currentLimit) {
    await ctx.reply(
      `Сейчас можно загрузить максимум ${currentLimit} фото. Нажми "${session.mode === 'catalog' ? 'Найти товар' : 'Готово'}" или "Очистить".`,
      session.mode === 'catalog' ? catalogKeyboard() : productKeyboard()
    );
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  session.photos.push(photo.file_id);

  if (session.mode === 'catalog') {
    await ctx.reply(
      `Фото штрихкода добавлено (${session.photos.length}/${currentLimit}). Когда закончишь, нажми "Найти товар".`,
      catalogKeyboard()
    );
    return;
  }

  if (session.barcodeRetryMode) {
    await ctx.reply(
      `Дополнительное фото добавлено (${session.photos.length}/${currentLimit}). Когда закончишь, нажми "Готово".`,
      productKeyboard()
    );
  } else {
    await ctx.reply(
      `Фото добавлено (${session.photos.length}/${currentLimit}). Когда закончишь, нажми "Готово".`,
      productKeyboard()
    );
  }
});

bot.hears('Найти товар', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.mode !== 'catalog') {
    await ctx.reply('Сначала выбери раздел "Каталог товаров".', mainMenuKeyboard());
    return;
  }

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фото.');
    return;
  }

  if (!session.photos.length) {
    await ctx.reply('Сначала загрузи хотя бы одно фото штрихкода.', catalogKeyboard());
    return;
  }

  session.processing = true;

  try {
    await ctx.reply('Ищу товар по штрихкоду...');

    const imageDataUrls = [];
    for (const fileId of session.photos) {
      const meta = await getTelegramFileMeta(fileId);
      imageDataUrls.push(bufferToDataUrl(meta.buffer, meta.mimeType));
    }

    const barcode = await extractBarcodeFromImages(imageDataUrls);

    if (!barcode || !isValidEan13(barcode)) {
      session.processing = false;
      await ctx.reply(getBarcodeRetryMessage(), catalogKeyboard());
      return;
    }

    const found = await findRowByBarcode(barcode);

    session.processing = false;
    session.photos = [];

    if (!found) {
      await ctx.reply(`Товар со штрихкодом ${barcode} в таблице не найден.`, catalogKeyboard());
      return;
    }

    await ctx.reply(`Штрихкод: ${barcode}\n\n${formatCatalogResponse(found.row)}`, catalogKeyboard());
  } catch (e) {
    console.error('=== CATALOG ERROR START ===');
    console.error(e);
    console.error('=== CATALOG ERROR END ===');

    session.processing = false;
    await ctx.reply('Ошибка поиска товара. Попробуй ещё раз или нажми "Очистить".', catalogKeyboard());
  }
});

bot.hears('Готово', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.mode !== 'add') {
    await ctx.reply('Сначала выбери раздел "Добавить новый товар в таблицу".', mainMenuKeyboard());
    return;
  }

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фото.');
    return;
  }

  if (!session.photos.length) {
    await ctx.reply('Сначала загрузи хотя бы одну фотографию товара.', productKeyboard());
    return;
  }

  session.processing = true;

  try {
    await ctx.reply('Обрабатываю фотографии...');

    const imageMetaList = [];
    const imageDataUrls = [];

    for (const fileId of session.photos) {
      const meta = await getTelegramFileMeta(fileId);
      imageMetaList.push(meta);
      imageDataUrls.push(bufferToDataUrl(meta.buffer, meta.mimeType));
    }

    const hash = makeImageCacheHash(imageDataUrls);

    let result;
    if (cache.has(hash)) {
      result = cache.get(hash);
    } else {
      const raw = await analyze(imageDataUrls);
      result = parseModelJson(raw);
      cache.set(hash, result);
    }

    const barcode = normalizeBarcode(result.barcode);

    if (!barcode || result.barcode === 'не найден' || !isValidEan13(barcode)) {
      session.processing = false;
      session.barcodeRetryMode = true;

      await ctx.reply(getBarcodeRetryMessage(), productKeyboard());
      return;
    }

    result.barcode = barcode;

    const fields = {
      name: 'Название товара',
      description: 'Описание товара',
      details: 'Состав, КБЖУ, срок хранения',
      manufacturer: 'Производитель',
      barcode: 'Штрих код товара',
    };

    for (const key of Object.keys(fields)) {
      if (
        !result[key] ||
        String(result[key]).trim() === '' ||
        String(result[key]).trim().toLowerCase() === 'не указано'
      ) {
        session.processing = false;
        await ctx.reply(
          `Не хватает данных для заполнения столбца - ${fields[key]}. Пришли дополнительные фото и снова нажми "Готово".`,
          productKeyboard()
        );
        return;
      }
    }

    let photoUrl = '';

    try {
      const firstPhoto = imageMetaList[0];
      const safeFileName = `${result.barcode}_${Date.now()}.${firstPhoto.extension}`;
      photoUrl = await uploadPhotoToDrive(
        firstPhoto.buffer,
        firstPhoto.mimeType,
        safeFileName
      );
    } catch (driveError) {
      console.error('=== DRIVE UPLOAD ERROR START ===');
      console.error(driveError);
      console.error('=== DRIVE UPLOAD ERROR END ===');
    }

    await writeToGoogleSheets(result, photoUrl);

    resetSession(ctx.chat.id, 'main');
    await ctx.reply('✅ Товар записан в таблицу', tableButton());
    await ctx.reply('Главное меню:', mainMenuKeyboard());
  } catch (e) {
    console.error('=== BOT ERROR START ===');
    console.error(e);
    console.error('=== BOT ERROR END ===');

    session.processing = false;
    await ctx.reply(
      'Ошибка обработки. Попробуй ещё раз или нажми "Очистить".',
      productKeyboard()
    );
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.photo) return;

  const session = getSession(ctx.chat.id);

  if (session.mode === 'add') {
    await ctx.reply('Подгрузи фотографии товара или вернись в главное меню.', productKeyboard());
    return;
  }

  if (session.mode === 'catalog') {
    await ctx.reply('Пришли фото штрихкода товара или вернись в главное меню.', catalogKeyboard());
    return;
  }

  await ctx.reply('Главное меню:', mainMenuKeyboard());
});

bot.launch();
console.log('Bot started...');