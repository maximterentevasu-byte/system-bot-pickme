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

// ===== SESSION =====

const sessions = new Map();
const cache = new Map();
const MAX_PHOTOS = 3;

function keyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
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
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

// ===== OPENAI =====

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
Верни строго JSON без markdown:

{
  "name": "",
  "description": "",
  "details": "",
  "manufacturer": "",
  "barcode": ""
}

Если нет данных — "не указано"
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

// ===== GOOGLE WRITE =====

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

bot.on('photo', (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.photos.length >= MAX_PHOTOS) {
    return ctx.reply('Максимум 3 фото');
  }

  const photo = ctx.message.photo.pop();
  session.photos.push(photo.file_id);

  ctx.reply(`Добавлено ${session.photos.length}/3`);
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

  session.processing = true;

  try {
    ctx.reply('Обрабатываю...');

    const images = [];
    for (const id of session.photos) {
      images.push(await telegramFileToDataUrl(id));
    }

    const hash = crypto
      .createHash('md5')
      .update(images.join(''))
      .digest('hex');

    let result;

    if (cache.has(hash)) {
      result = cache.get(hash);
    } else {
      const raw = await analyze(images);
      result = parseModelJson(raw);
      cache.set(hash, result);
    }

    const fields = {
      name: 'Название товара',
      description: 'Описание товара',
      details: 'Состав/КБЖУ/Срок',
      manufacturer: 'Производитель',
      barcode: 'Штрих код товара',
    };

    for (const key in fields) {
      if (!result[key] || result[key] === 'не указано') {
        return ctx.reply(`Не хватает данных для заполнение столбца - ${fields[key]}`);
      }
    }

    await writeToGoogleSheets(result);

    ctx.reply('Товар записан в таблицу');
    resetSession(ctx.chat.id);

  } catch (e) {
  console.error('=== GOOGLE ERROR ===');
  console.error(e.response?.data || e.message || e);
  console.error('====================');

  ctx.reply('Ошибка записи в таблицу');
}
});

bot.launch();
console.log('Bot started...');