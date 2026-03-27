require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Хранилище фото по chatId
const userSessions = new Map();

function getMainKeyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
}

function getStartKeyboard() {
  return Markup.keyboard([['Начать заново']]).resize();
}

function ensureSession(chatId) {
  if (!userSessions.has(chatId)) {
    userSessions.set(chatId, {
      photos: [],
      processing: false,
    });
  }
  return userSessions.get(chatId);
}

function resetSession(chatId) {
  userSessions.set(chatId, {
    photos: [],
    processing: false,
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function telegramFileToDataUrl(fileId) {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await axios.get(fileLink.href, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const contentType = response.headers['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(response.data).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

async function analyzeProductImages(imageDataUrls) {
  const inputContent = [
    {
      type: 'input_text',
      text:
        'Ты помощник по карточкам товара для магазина. ' +
        'На входе фотографии упаковки товара. ' +
        'Текст на упаковке может быть на китайском, английском или корейском. ' +
        'Твоя задача: внимательно прочитать текст на всех изображениях, перевести важные данные на русский язык ' +
        'и собрать результат строго в 5 абзацев.\n\n' +
        'Верни ответ строго в таком формате:\n' +
        '1. Название товара: ...\n' +
        '2. Описание товара: ...\n' +
        '3. Состав, КБЖУ, срок хранения: ...\n' +
        '4. Производитель: ...\n' +
        '5. Штрих код товара: ...\n\n' +
        'Требования:\n' +
        '- Не выдумывай данные, которых нет на фото.\n' +
        '- Если какого-то поля нет, так и напиши: "не указано".\n' +
        '- В абзаце "Описание товара" напиши кратко и продающе, 1–3 предложения.\n' +
        '- Если на нескольких фото данные частично отличаются, используй наиболее полный и логичный вариант.\n' +
        '- Ответ только на русском языке.'
    }
  ];

  for (const imageUrl of imageDataUrls) {
    inputContent.push({
      type: 'input_image',
      image_url: imageUrl,
    });
  }

  const response = await openai.responses.create({
    model: 'gpt-5.2',
    input: [
      {
        role: 'user',
        content: inputContent,
      },
    ],
  });

  return response.output_text?.trim() || 'Не удалось получить ответ от модели.';
}

bot.start(async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply(
    'Подгрузи фотографии товара',
    getMainKeyboard()
  );
});

bot.hears('Начать заново', async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply(
    'Подгрузи фотографии товара',
    getMainKeyboard()
  );
});

bot.hears('Очистить', async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply(
    'Все загруженные фото удалены. Подгрузи фотографии товара заново.',
    getMainKeyboard()
  );
});

bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = ensureSession(chatId);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю предыдущую пачку фотографий.');
    return;
  }

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1]; // самое крупное фото
  session.photos.push(bestPhoto.file_id);

  await ctx.reply(
    `Фото загружено. Сейчас в наборе: ${session.photos.length}.\n` +
    'Можешь отправить еще фото или нажать "Готово".',
    getMainKeyboard()
  );
});

bot.hears('Готово', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = ensureSession(chatId);

  if (session.processing) {
    await ctx.reply('Подожди, я уже обрабатываю фото.');
    return;
  }

  if (!session.photos.length) {
    await ctx.reply('Сначала подгрузи хотя бы одну фотографию товара.');
    return;
  }

  session.processing = true;

  try {
    await ctx.reply('Обрабатываю фотографии, это может занять до минуты…');

    const imageDataUrls = [];
    for (const fileId of session.photos) {
      const dataUrl = await telegramFileToDataUrl(fileId);
      imageDataUrls.push(dataUrl);
    }

    const result = await analyzeProductImages(imageDataUrls);

    await ctx.reply(
      escapeHtml(result),
      {
        parse_mode: 'HTML',
        ...getStartKeyboard(),
      }
    );

    resetSession(chatId);
  } catch (error) {
    console.error('Ошибка обработки фото:', error);
    session.processing = false;

    await ctx.reply(
      'Не получилось обработать фотографии. Попробуй еще раз.',
      getMainKeyboard()
    );
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.photo) return;

  await ctx.reply(
    'Подгрузи фотографии товара. Когда закончишь, нажми "Готово".',
    getMainKeyboard()
  );
});

bot.launch();
console.log('Bot started...');