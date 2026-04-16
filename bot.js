require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== МЕНЮ ======
const mainMenu = Markup.keyboard([
  ['➕ Добавить новый товар'],
  ['📦 Каталог товаров'],
  ['📊 Открыть таблицу']
]).resize();

const backMenu = Markup.keyboard([
  ['⬅️ Главное меню']
]).resize();

// ====== СОСТОЯНИЯ ======
let userState = {};
let userPhotos = {};

// ====== СТАРТ ======
bot.start((ctx) => {
  userState[ctx.chat.id] = 'menu';
  ctx.reply('Главное меню:', mainMenu);
});

// ====== ГЛАВНОЕ МЕНЮ ======
bot.hears('⬅️ Главное меню', (ctx) => {
  userState[ctx.chat.id] = 'menu';
  ctx.reply('Главное меню:', mainMenu);
});

// ====== ДОБАВЛЕНИЕ ТОВАРА ======
bot.hears('➕ Добавить новый товар', (ctx) => {
  userState[ctx.chat.id] = 'add';
  userPhotos[ctx.chat.id] = [];
  ctx.reply('Отправь до 5 фото товара', backMenu);
});

// ====== КАТАЛОГ ======
bot.hears('📦 Каталог товаров', (ctx) => {
  userState[ctx.chat.id] = 'catalog';
  ctx.reply('Отправь фото штрихкода', backMenu);
});

// ====== ОТКРЫТЬ ТАБЛИЦУ ======
bot.hears('📊 Открыть таблицу', (ctx) => {
  ctx.reply(process.env.SHEET_URL);
});

// ====== ОБРАБОТКА ФОТО ======
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = userState[chatId];

  const photo = ctx.message.photo.pop();

  if (state === 'add') {
    if (!userPhotos[chatId]) userPhotos[chatId] = [];
    if (userPhotos[chatId].length < 5) {
      userPhotos[chatId].push(photo.file_id);
      ctx.reply(`Фото добавлено (${userPhotos[chatId].length}/5)`);
    } else {
      ctx.reply('Максимум 5 фото');
    }
  }

  if (state === 'catalog') {
    // здесь должна быть логика распознавания ШК
    const row = await findProductByBarcode(photo.file_id);

    if (!row) {
      return ctx.reply('Товар не найден');
    }

    const message = [
      row[8],  // I
      row[6],  // G
      row[7],  // H
      row[10], // K
      row[11], // L
      row[12], // M
      row[9]   // J
    ]
      .filter(v => v && v.toString().trim() !== "")
      .join('\n\n');

    ctx.reply(message, backMenu);
  }
});

// ====== ФЕЙК ФУНКЦИЯ ПОИСКА ======
async function findProductByBarcode(fileId) {
  // здесь твоя логика поиска в Google Sheets
  return null;
}

// ====== ЗАПУСК ======
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
