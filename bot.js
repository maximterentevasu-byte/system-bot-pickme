require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const XLSX = require('xlsx');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessions = new Map();
const cache = new Map();

const MAX_PHOTOS = 3;
const FILE_PATH = './Новый файл для русификации.xlsx';

// ===== UI =====

function keyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
}

// ===== SESSION =====

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

// ===== HASH =====

function generateHash(images) {
  const hash = crypto.createHash('md5');
  images.forEach(img => hash.update(img));
  return hash.digest('hex');
}

// ===== OPENAI =====

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
Проанализируй изображения и верни строго JSON:

{
"name": "",
"description": "",
"details": "",
"manufacturer": "",
"barcode": ""
}

Если данных нет — пиши "не указано"
      `
    }
  ];

  images.forEach(img => {
    content.push({
      type: 'input_image',
      image_url: img,
      detail: 'low'
    });
  });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [{ role: 'user', content }]
  });

  return response.output_text;
}

// ===== EXCEL =====

function writeToExcel(data) {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const json = XLSX.utils.sheet_to_json(sheet);

  json.push({
    "Название товара": data.name,
    "Описание": data.description,
    "Состав/КБЖУ/Срок": data.details,
    "Производитель": data.manufacturer,
    "Штрихкод": data.barcode
  });

  const newSheet = XLSX.utils.json_to_sheet(json);
  workbook.Sheets[sheetName] = newSheet;

  XLSX.writeFile(workbook, FILE_PATH);
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

    const hash = generateHash(images);

    let result;

    if (cache.has(hash)) {
      result = cache.get(hash);
    } else {
      const raw = await analyze(images);
      result = JSON.parse(raw);
      cache.set(hash, result);
    }

    // ===== ПРОВЕРКА ДАННЫХ =====

    const fields = {
      name: 'Название товара',
      description: 'Описание',
      details: 'Состав/КБЖУ/Срок',
      manufacturer: 'Производитель',
      barcode: 'Штрихкод'
    };

    for (const key in fields) {
      if (!result[key] || result[key] === 'не указано') {
        return ctx.reply(`Не хватает данных для заполнение столбца - ${fields[key]}`);
      }
    }

    // ===== ЗАПИСЬ В EXCEL =====

    writeToExcel(result);

    await ctx.reply('Товар записан в файл');

    resetSession(ctx.chat.id);

  } catch (e) {
    console.error(e);
    ctx.reply('Ошибка обработки');
  }
});

bot.launch();
console.log('Bot started...');