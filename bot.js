require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const XLSX = require('xlsx');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const sessions = new Map();
const cache = new Map();

const MAX_PHOTOS = 3;
const FILE_PATH = './Новый файл для русификации.xlsx';

function keyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      photos: [],
      processing: false,
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, {
    photos: [],
    processing: false,
  });
}

async function telegramFileToDataUrl(fileId) {
  const fileInfo = await bot.telegram.getFile(fileId);
  const fileLink = await bot.telegram.getFileLink(fileId);

  const response = await axios.get(fileLink.href, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });

  const filePath = String(fileInfo?.file_path || '').toLowerCase();
  let mimeType = 'image/jpeg';

  if (filePath.endsWith('.png')) mimeType = 'image/png';
  if (filePath.endsWith('.webp')) mimeType = 'image/webp';

  const base64 = Buffer.from(response.data).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function generateHash(images) {
  const hash = crypto.createHash('md5');
  images.forEach((img) => hash.update(img));
  return hash.digest('hex');
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
  } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start !== -1 && end !== -1 && end > start) {
      const sliced = cleaned.slice(start, end + 1);
      return JSON.parse(sliced);
    }

    throw error;
  }
}

async function analyze(images) {
  const content = [
    {
      type: 'input_text',
      text: `
Проанализируй изображения упаковки товара и верни строго JSON БЕЗ markdown, БЕЗ \`\`\`, БЕЗ любого текста вокруг.

Формат ответа:
{
  "name": "",
  "description": "",
  "details": "",
  "manufacturer": "",
  "barcode": ""
}

Где:
- name — название товара
- description — краткое продающее описание 1–3 предложения
- details — состав, КБЖУ, срок хранения
- manufacturer — производитель
- barcode — штрихкод

Правила:
- если данных не хватает для поля, пиши "не указано"
- ответ должен быть только JSON
      `.trim(),
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
    truncation: 'auto',
    input: [{ role: 'user', content }],
  });

  return response.output_text;
}

function writeToExcel(data) {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: '',
  });

  rows.push({
    'Название товара': data.name,
    'Описание товара': data.description,
    'Состав, КБЖУ, срок хранения': data.details,
    'Производитель': data.manufacturer,
    'Штрих код товара': data.barcode,
  });

  const newSheet = XLSX.utils.json_to_sheet(rows);
  workbook.Sheets[sheetName] = newSheet;

  XLSX.writeFile(workbook, FILE_PATH);
}

bot.start(async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply('Подгрузи фотографии товара', keyboard());
});

bot.hears('Очистить', async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply('Все загруженные фото удалены.', keyboard());
});

bot.on('photo', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фотографии.');
    return;
  }

  if (session.photos.length >= MAX_PHOTOS) {
    await ctx.reply(`Можно загрузить максимум ${MAX_PHOTOS} фото.`, keyboard());
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  session.photos.push(photo.file_id);

  await ctx.reply(`Фото добавлено (${session.photos.length}/${MAX_PHOTOS})`, keyboard());
});

bot.hears('Готово', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фото.');
    return;
  }

  if (!session.photos.length) {
    await ctx.reply('Сначала загрузи хотя бы одну фотографию.');
    return;
  }

  session.processing = true;

  try {
    await ctx.reply('Обрабатываю...');

    const images = [];
    for (const fileId of session.photos) {
      const dataUrl = await telegramFileToDataUrl(fileId);
      images.push(dataUrl);
    }

    const hash = generateHash(images);

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
        await ctx.reply(`Не хватает данных для заполнение столбца - ${fields[key]}`);
        return;
      }
    }

    writeToExcel(result);

    resetSession(ctx.chat.id);
    await ctx.reply('Товар записан в файл');
  } catch (error) {
    console.error('=== ERROR START ===');
    console.error(error);
    console.error('=== ERROR END ===');

    session.processing = false;
    await ctx.reply('Ошибка обработки');
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.photo) return;
  await ctx.reply('Подгрузи фотографии товара', keyboard());
});

bot.launch();
console.log('Bot started...');