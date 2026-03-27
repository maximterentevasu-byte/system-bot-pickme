const { Telegraf, Markup } = require('telegraf');
const XLSX = require('xlsx');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_ID = 758972533;
const ADMIN_USERNAME = 'tervmax';

const EXCEL_FILE_PATH = path.join(__dirname, 'CLIENT_EXPORT.xlsx');
const REGISTRATION_URL = 'https://card.evobonus.ru/form/74e48448-1975-4bca-a455-92ec9a4bbf76';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.sst.evobonus&referrer=pass_url%3Dhttps://appcampaign.a1-systems.com/passkit/v1/passes/pass.com.ng.naviguide/fe694199-ef3e-47a4-83d1-7e622908398b%26org%3DSomeOrg';

// Нормализация телефона
function normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.slice(1);
    }
    return cleaned;
}

// Поиск карты
function findCardLinkByPhone(phone) {
    const normalizedPhone = normalizePhone(phone);

    const workbook = XLSX.readFile(EXCEL_FILE_PATH);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: ''
    });

    for (let i = 0; i < rows.length; i++) {
        const excelPhone = normalizePhone(rows[i][4]);
        const cardLink = String(rows[i][15] || '').trim();

        if (excelPhone && excelPhone === normalizedPhone) {
            return cardLink;
        }
    }

    return null;
}

// Имя пользователя
function getUserDisplayName(user) {
    if (user.username) return `@${user.username}`;
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'без имени';
}

// Главное меню (4 кнопки)
function mainMenu(ctx) {
    return ctx.reply(
        'Привет! Я бот бонусной программы Pick me. Выбери интересующий тебя пункт:',
        Markup.keyboard([
            ['Подключиться к бонусной программе'],
            ['Скачать бонусную карту на телефон'],
            ['Скачать Эвобонус для Android'],
            ['Сообщить об ошибке']
        ]).resize()
    );
}

// Регистрация
function sendRegistration(ctx) {
    return ctx.reply(
        `Для регистрации в бонусной программе заполни <a href="${REGISTRATION_URL}">анкету</a>`,
        {
            parse_mode: 'HTML',
            ...Markup.keyboard([['На главный экран']]).resize()
        }
    );
}

// START
bot.start((ctx) => mainMenu(ctx));

// Кнопка 1
bot.hears('Подключиться к бонусной программе', (ctx) => sendRegistration(ctx));

// Кнопка 2
bot.hears('Скачать бонусную карту на телефон', (ctx) => {
    return ctx.reply(
        'Нажми кнопку ниже, чтобы отправить свой контакт:',
        Markup.keyboard([
            [Markup.button.contactRequest('Отправить контакт')],
            ['На главный экран']
        ]).resize()
    );
});

// Кнопка Android
bot.hears('Скачать Эвобонус для Android', (ctx) => {
    return ctx.reply(
        'Для скачивания нажмите на кнопку:',
        Markup.inlineKeyboard([
            [Markup.button.url('Скачать приложение', ANDROID_URL)]
        ])
    ).then(() => {
        return ctx.reply(
            ' ',
            Markup.keyboard([['На главный экран']]).resize()
        );
    });
});

// Кнопка "Сообщить об ошибке"
bot.hears('Сообщить об ошибке', (ctx) => {
    return ctx.reply(
        'Напишите администратору:',
        Markup.inlineKeyboard([
            [Markup.button.url('Открыть чат с администратором', `https://t.me/${ADMIN_USERNAME}`)]
        ])
    );
});

// Обработка контакта
bot.on('contact', async (ctx) => {
    try {
        const contact = ctx.message.contact;
        const phone = contact?.phone_number;
        const userName = getUserDisplayName(ctx.from);

        if (!phone) {
            await bot.telegram.sendMessage(
                ADMIN_ID,
                `Пользователь ${userName} не смог скачать электронную карту.`
            );

            return ctx.reply(
                'Невозможно идентифицировать карту по номеру телефона, мы отправили запрос администратору.',
                Markup.keyboard([['На главный экран']]).resize()
            );
        }

        const cardLink = findCardLinkByPhone(phone);

        if (cardLink) {
            return ctx.reply(
                'Твоя бонусная карта готова 🎉\nНажми кнопку ниже:',
                Markup.inlineKeyboard([
                    [Markup.button.url('Скачать карту', cardLink)]
                ])
            );
        } else {
            return ctx.reply(
                'Карта с указанным номером телефона не существует. Выпустить новую карту?',
                Markup.keyboard([
                    ['Подключиться к бонусной программе'],
                    ['На главный экран']
                ]).resize()
            );
        }

    } catch (e) {
        console.error(e);

        await bot.telegram.sendMessage(
            ADMIN_ID,
            `Ошибка у пользователя ${getUserDisplayName(ctx.from)}`
        );

        return ctx.reply(
            'Произошла ошибка. Мы уже сообщили администратору.',
            Markup.keyboard([['На главный экран']]).resize()
        );
    }
});

// Назад
bot.hears('На главный экран', (ctx) => mainMenu(ctx));

bot.launch();
console.log('Bot started...');