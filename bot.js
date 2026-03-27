require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Храним сессию по chatId
const sessions = new Map();

// Ограничим количество фото, чтобы не раздувать запрос
const MAX_PHOTOS = 3;

function getMainKeyboard() {
  return Markup.keyboard([['Готово'], ['Очистить']]).resize();
}

function getRestartKeyboard() {
  return Markup.keyboard([['Начать заново']]).resize();
}

function ensureSession(chatId) {
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
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });

  const contentType = response.headers['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(response.data).toString('base64');

  return `data:${contentType};base64,${base64}`;
}

async function analyzeProductImages(imageDataUrls) {
  const content = [
    {
      type: 'input_text',
      text: `
Ты помощник по карточкам товара для магазина.

Пользователь прислал фотографии упаковки товара.
Текст на упаковке может быть на китайском, английском или корейском языке.

Твоя задача:
1. Внимательно прочитать весь текст на всех изображениях.
2. Перевести ключевую информацию на русский язык.
3. Собрать итог строго в 5 абзацев.

Верни ответ СТРОГО в таком формате:

Название товара: ...
Описание товара: ...
Состав, КБЖУ, срок хранения: ...
Производитель: ...
Штрих код товара: ...

Правила:
- Ничего не выдумывай.
- Если данных нет на фото, пиши: не указано.
- "Описание товара" должно быть коротким, продающим, 1–3 предложения.
- Ответ только на русском языке.
      `.trim(),
    },
  ];

  for (const imageUrl of imageDataUrls) {
    content.push({
      type: 'input_image',
      image_url: imageUrl,
      detail: 'auto',
    });
  }

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    truncation: 'auto',
    input: [
      {
        role: 'user',
        content,
      },
    ],
  });

  return response.output_text?.trim() || 'Не удалось получить ответ от модели.';
}

bot.start(async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply('Подгрузи фотографии товара', getMainKeyboard());
});

bot.hears('Начать заново', async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply('Подгрузи фотографии товара', getMainKeyboard());
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

  if (session.photos.length >= MAX_PHOTOS) {
    await ctx.reply(
      `Можно загрузить максимум ${MAX_PHOTOS} фото за один раз. Нажми "Готово" или "Очистить".`,
      getMainKeyboard()
    );
    return;
  }

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];

  session.photos.push(bestPhoto.file_id);

  await ctx.reply(
    `Фото загружено. Сейчас в наборе: ${session.photos.length}.\nМожешь отправить ещё фото или нажать "Готово".`,
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
    await ctx.reply('Сначала подгрузи хотя бы одну фотографию товара.', getMainKeyboard());
    return;
  }

  session.processing = true;

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    await ctx.reply('Обрабатываю фотографии, это может занять до минуты…');

    const imageDataUrls = [];
    for (const fileId of session.photos) {
      const dataUrl = await telegramFileToDataUrl(fileId);
      imageDataUrls.push(dataUrl);
    }

    const result = await analyzeProductImages(imageDataUrls);

    await ctx.reply(escapeHtml(result), {
      parse_mode: 'HTML',
      ...getRestartKeyboard(),
    });

    resetSession(chatId);
  } catch (error) {
    console.error('=== ERROR START ===');
    console.error('message:', error?.message);
    console.error('status:', error?.status);
    console.error('name:', error?.name);
    console.error('stack:', error?.stack);
    console.error('full error:', error);
    console.error('=== ERROR END ===');

    session.processing = false;

    let userMessage = 'Не получилось обработать фотографии. Попробуй ещё раз.';

    if (error?.message?.includes('OPENAI_API_KEY')) {
      userMessage = 'Не настроен OPENAI_API_KEY в Railway.';
    } else if (error?.status === 401) {
      userMessage = 'Ошибка авторизации OpenAI API. Проверь OPENAI_API_KEY.';
    } else if (error?.status === 429) {
      userMessage = 'Превышен лимит OpenAI API или закончился баланс.';
    } else if (error?.status === 400) {
      userMessage = 'OpenAI отклонил запрос. Попробуй меньше фото или более чёткие снимки.';
    }

    await ctx.reply(userMessage, getMainKeyboard());
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