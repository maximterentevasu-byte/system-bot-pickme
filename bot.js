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
const SHEET_RANGE = 'Sheet1!A1';
const BARCODE_COLUMN_RANGE = 'Sheet1!E:E';

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

Требования:
- name — короткое и понятное название товара на русском.
- description — красивое продающее описание, как для маркетплейса, 2–3 предложения.
- details — состав, КБЖУ, срок хранения на русском.
- manufacturer — красивый перевод производителя на русский.
- barcode — только цифры, 13 символов, без пробелов и знаков.

Если данных для поля нет — "не указано".
Если штрихкод не читается однозначно — "не найден".
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

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        data.name,
        data.description,
        data.details,
        data.manufacturer,
        data.barcode,
        photoCellValue,
      ]],
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

    const existingBarcodes = await getAllBarcodes();
    if (existingBarcodes.includes(result.barcode)) {
      resetSession(ctx.chat.id);
      await ctx.reply(
        '⚠️ Товар с таким штрихкодом уже есть в таблице. Повторно добавлять его не нужно.',
        tableButton()
      );
      return;
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