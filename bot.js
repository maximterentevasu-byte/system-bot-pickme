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

const INITIAL_MAX_PHOTOS = 3;
const RETRY_MAX_PHOTOS = 10;

function keyboard() {
  return Markup.keyboard([
    ['Готово'],
    ['Очистить'],
    ['Открыть таблицу'],
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
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, {
    photos: [],
    processing: false,
    barcodeRetryMode: false,
  });
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

async function generateExtraFields(data) {
  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
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
  "spice": "Категория: ...\nScoville (SHU): ...\nШкала: ...",
  "acid": "Категория: ...\npH: ...\nШкала: ...",
  "k": "Вкусовые характеристики товара / описание вкуса / описание визуала / кому понравится товар / всё важное для принятия решения о покупке.",
  "l": "Как приготовить / как употреблять (готов к употреблению или нужно готовить) / самостоятельное блюдо или нет / с чем сочетается.",
  "m": "Самый популярный рецепт приготовления / ссылка на рецепт на русском языке, если есть, иначе напиши: Ссылка: не указано"
}

Правила для остроты (5 категорий):
1. Не острое
2. Слабо острое
3. Средне острое
4. Острое
5. Очень острое

Правила для кислотности (5 категорий):
1. Не кислое
2. Слабо кислое
3. Средне кислое
4. Кислое
5. Очень кислое

Если точные SHU или pH не указаны, оцени по типу продукта, вкусу и описанию, но честно пиши "не указано" в строке SHU или pH, а категорию и шкалу всё равно определи максимально разумно.

Шкалы остроты:
- Не острое: 0-500
- Слабо острое: 501-2500
- Средне острое: 2501-15000
- Острое: 15001-50000
- Очень острое: 50001+

Шкалы кислотности:
- Не кислое: 6.1-7.0
- Слабо кислое: 5.1-6.0
- Средне кислое: 4.1-5.0
- Кислое: 3.1-4.0
- Очень кислое: 0-3.0

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
  return {
    spice: String(parsed?.spice || '').trim(),
    acid: String(parsed?.acid || '').trim(),
    k: String(parsed?.k || '').trim(),
    l: String(parsed?.l || '').trim(),
    m: String(parsed?.m || '').trim(),
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

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
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
    return;
  }

  const row = rows[rowIndex] || [];
  const updated = Array.from({ length: 13 }, (_, index) => row[index] || '');

  function isEmptyCell(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  function setIfEmpty(index, value) {
    if (!isEmptyCell(value) && isEmptyCell(updated[index])) {
      updated[index] = value;
    }
  }

  setIfEmpty(0, data.name || '');
  setIfEmpty(1, data.description || '');
  setIfEmpty(2, data.details || '');
  setIfEmpty(3, data.manufacturer || '');
  setIfEmpty(4, `'${barcode}`);
  setIfEmpty(5, photoCellValue);
  setIfEmpty(6, extra.spice || '');
  setIfEmpty(7, extra.acid || '');
  setIfEmpty(10, extra.k || '');
  setIfEmpty(11, extra.l || '');
  setIfEmpty(12, extra.m || '');

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `RUSIFIK!A${rowIndex + 1}:M${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [updated],
    },
  });
}



// ===== BOT =====

bot.start(async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply('Подгрузи фотографии товара', keyboard());
});

bot.hears('Открыть таблицу', async (ctx) => {
  await ctx.reply('Открыть Google Sheets:', tableButton());
});

bot.hears('Очистить', async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply(
    'Все загруженные фото очищены. Подгрузи фотографии товара заново.',
    keyboard()
  );
});

bot.on('photo', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю текущую пачку фото.');
    return;
  }

  const currentLimit = getPhotoLimit(session);

  if (session.photos.length >= currentLimit) {
    await ctx.reply(
      `Сейчас можно загрузить максимум ${currentLimit} фото. Нажми "Готово" или "Очистить".`,
      keyboard()
    );
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  session.photos.push(photo.file_id);

  if (session.barcodeRetryMode) {
    await ctx.reply(
      `Дополнительное фото добавлено (${session.photos.length}/${currentLimit}). Когда закончишь, нажми "Готово".`,
      keyboard()
    );
  } else {
    await ctx.reply(
      `Фото добавлено (${session.photos.length}/${currentLimit}). Когда закончишь, нажми "Готово".`,
      keyboard()
    );
  }
});

bot.hears('Готово', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фото.');
    return;
  }

  if (!session.photos.length) {
    await ctx.reply('Сначала загрузи хотя бы одну фотографию товара.', keyboard());
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

      await ctx.reply(getBarcodeRetryMessage(), keyboard());
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
          keyboard()
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

    resetSession(ctx.chat.id);
    await ctx.reply('✅ Товар записан в таблицу', tableButton());
  } catch (e) {
    console.error('=== BOT ERROR START ===');
    console.error(e);
    console.error('=== BOT ERROR END ===');

    session.processing = false;
    await ctx.reply(
      'Ошибка обработки. Попробуй ещё раз или нажми "Очистить".',
      keyboard()
    );
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.photo) return;
  await ctx.reply('Подгрузи фотографии товара', keyboard());
});

bot.launch();
console.log('Bot started...');