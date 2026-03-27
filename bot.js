require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessions = new Map();
const cache = new Map();

const MAX_PHOTOS = 3;

// ================= UI =================

function keyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
}

function restartKeyboard() {
  return Markup.keyboard([['Начать заново']]).resize();
}

// ================= SESSION =================

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { photos: [], processing: false });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { photos: [], processing: false });
}

// ================= IMAGE =================

// 🔥 Сжатие изображения
async function compressImage(buffer) {
  return await sharp(buffer)
    .resize({ width: 800 }) // уменьшаем
    .jpeg({ quality: 70 })  // сжатие
    .toBuffer();
}

// 🔥 Получение dataURL
async function getImageDataUrl(fileId) {
  const link = await bot.telegram.getFileLink(fileId);

  const response = await axios.get(link.href, {
    responseType: 'arraybuffer'
  });

  const compressed = await compressImage(response.data);

  const base64 = Buffer.from(compressed).toString('base64');

  return `data:image/jpeg;base64,${base64}`;
}

// ================= HASH (для кеша) =================

function generateHash(images) {
  const hash = crypto.createHash('md5');

  for (const img of images) {
    hash.update(img);
  }

  return hash.digest('hex');
}

// ================= OPENAI =================

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
Ты помощник по карточкам товара.

Проанализируй изображения упаковки товара и выдай:

Название товара:
Описание товара:
Состав, КБЖУ, срок хранения:
Производитель:
Штрих код товара:

Правила:
- Не выдумывай
- Если нет данных — пиши "не указано"
- Описание 1–3 предложения
- Ответ на русском
      `
    }
  ];

  for (const img of images) {
    content.push({
      type: 'input_image',
      image_url: img,
      detail: 'low' // 🔥 дешевле
    });
  }

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    truncation: 'auto',
    input: [{ role: 'user', content }]
  });

  return response.output_text;
}

// ================= BOT =================

bot.start((ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Подгрузи фотографии товара', keyboard());
});

// Фото
bot.on('photo', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    return ctx.reply('Я уже обрабатываю фото...');
  }

  if (session.photos.length >= MAX_PHOTOS) {
    return ctx.reply('Можно загрузить максимум 3 фото', keyboard());
  }

  const photo = ctx.message.photo.pop();
  session.photos.push(photo.file_id);

  ctx.reply(`Фото добавлено (${session.photos.length}/3)`, keyboard());
});

// Очистка
bot.hears('Очистить', (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply('Фото очищены', keyboard());
});

// Готово
bot.hears('Готово', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (!session.photos.length) {
    return ctx.reply('Сначала загрузи фото');
  }

  if (session.processing) {
    return ctx.reply('Подожди...');
  }

  session.processing = true;

  try {
    ctx.reply('Обрабатываю...');

    // 🔥 получаем изображения
    const images = [];

    for (const fileId of session.photos) {
      const img = await getImageDataUrl(fileId);
      images.push(img);
    }

    // 🔥 проверка кеша
    const hash = generateHash(images);

    if (cache.has(hash)) {
      await ctx.reply(cache.get(hash), restartKeyboard());
      resetSession(ctx.chat.id);
      return;
    }

    // 🔥 запрос в OpenAI
    const result = await analyze(images);

    // 🔥 сохраняем в кеш
    cache.set(hash, result);

    await ctx.reply(result, restartKeyboard());

    resetSession(ctx.chat.id);

  } catch (e) {
    console.error(e);
    session.processing = false;
    ctx.reply('Ошибка обработки');
  }
});

// fallback
bot.on('message', (ctx) => {
  if (ctx.message.photo) return;
  ctx.reply('Отправь фото товара');
});

bot.launch();
console.log('Bot started...');