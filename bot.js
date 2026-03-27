require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== GOOGLE =====

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = '1MfHUleOrA6aV95tnBKyBywe3bSO9PmdCvX8OaMvGz1A';

const TABLE_URL =
  'https://docs.google.com/spreadsheets/d/1MfHUleOrA6aV95tnBKyBywe3bSO9PmdCvX8OaMvGz1A/edit';

// ===== SESSION =====

const sessions = new Map();
const cache = new Map();

function keyboard() {
  return Markup.keyboard([
    ['Готово'],
    ['Очистить'],
    ['Открыть таблицу'],
  ]).resize();
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { photos: [], processing: false });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { photos: [], processing: false });
}

// ===== IMAGE =====

async function telegramFileToDataUrl(fileId) {
  const fileLink = await bot.telegram.getFileLink(fileId);

  const response = await axios.get(fileLink.href, {
    responseType: 'arraybuffer',
  });

  const base64 = Buffer.from(response.data).toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

// ===== JSON FIX =====

function cleanJsonText(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '');
  return cleaned.trim();
}

function parseModelJson(text) {
  const cleaned = cleanJsonText(text);
  return JSON.parse(cleaned);
}

// ===== OPENAI =====

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
СТРОГО:

- ВСЕ на русском
- ШТРИХКОД ОБЯЗАТЕЛЕН
- если штрихкод не читается → "barcode": "не найден"

JSON:

{
  "name": "",
  "description": "",
  "details": "",
  "manufacturer": "",
  "barcode": ""
}
      `,
    },
  ];

  images.forEach((img) => {
    content.push({
      type: 'input_image',
      image_url: img,
      detail: 'low',
    });
  });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [{ role: 'user', content }],
  });

  return response.output_text;
}

// ===== GOOGLE =====

async function getAllBarcodes() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!E:E',
  });

  return (res.data.values || []).flat();
}

async function writeToGoogleSheets(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        data.name,
        data.description,
        data.details,
        data.manufacturer,
        data.barcode,
      ]],
    },
  });
}

// ===== BOT =====

bot.start((ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Подгрузи фотографии товара', keyboard());
});

bot.hears('Открыть таблицу', (ctx) => {
  ctx.reply('Открыть таблицу:', Markup.inlineKeyboard([
    Markup.button.url('Перейти', TABLE_URL)
  ]));
});

bot.on('photo', (ctx) => {
  const session = getSession(ctx.chat.id);

  const photo = ctx.message.photo.pop();
  session.photos.push(photo.file_id);

  ctx.reply(`Фото добавлено (${session.photos.length})`);
});

bot.hears('Очистить', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Очищено');
});

bot.hears('Готово', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (!session.photos.length) {
    return ctx.reply('Нет фото');
  }

  try {
    ctx.reply('Обрабатываю...');

    const images = [];
    for (const id of session.photos) {
      images.push(await telegramFileToDataUrl(id));
    }

    const raw = await analyze(images);
    const result = parseModelJson(raw);

    // ===== ШТРИХКОД =====

    if (!result.barcode || result.barcode === 'не найден') {
      return ctx.reply(
        '❌ Не удалось распознать штрихкод. Сделай фото лучше (штрихкод должен быть чётким)'
      );
    }

    // ===== ДУБЛИ =====

    const existing = await getAllBarcodes();

    if (existing.includes(result.barcode)) {
      return ctx.reply('⚠️ Этот товар уже есть в базе');
    }

    // ===== ЗАПИСЬ =====

    await writeToGoogleSheets(result);

    ctx.reply('✅ Товар записан в таблицу');

    resetSession(ctx.chat.id);

  } catch (e) {
    console.error(e);
    ctx.reply('Ошибка обработки');
  }
});

bot.launch();
console.log('Bot started...');