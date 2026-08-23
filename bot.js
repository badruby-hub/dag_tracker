require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { buildReport } = require('./report');
const { buildExchangeUrl } = require('./links');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const MAX_ALERT_CARDS_PER_SEND = 10; // cap how many rich messages we fire per /check or per timer tick

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Добавь его в .env (см. .env.example).');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// chatId -> interval handle. In-memory only: a PM2 restart clears any
// running timers, chats need to re-run /alerts after a redeploy/restart.
const activeAlertTimers = new Map();

// chatId -> true while we're waiting for the person to reply with a number
// of minutes after they sent /alerts with no argument.
const awaitingAlertsInterval = new Set();

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
}

function fmtVolume(usdt) {
  if (usdt === null || usdt === undefined || Number.isNaN(usdt)) return '—';
  if (usdt >= 1_000_000) return `$${(usdt / 1_000_000).toFixed(2)}М`;
  if (usdt >= 1_000) return `$${(usdt / 1_000).toFixed(1)}К`;
  return `$${usdt.toFixed(0)}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function exchangeLinkHtml(exchangeName, rawSymbol) {
  const url = buildExchangeUrl(exchangeName, rawSymbol);
  const name = escapeHtml(exchangeName);
  return url ? `<a href="${url}">${name}</a>` : name;
}

// One coin, formatted exactly like a funding-arb scanner card: Short side
// (sell the expensive exchange) on top, Long side (buy the cheap exchange)
// below, both exchange names as clickable links straight to that contract.
function formatCoinAlertMessage(coin) {
  const { spread } = coin;
  const shortTicker = coin.tickers.find((t) => t.exchange === spread.sellExchange);
  const longTicker = coin.tickers.find((t) => t.exchange === spread.buyExchange);

  const lines = [
    `Курсовой спред: <b>${spread.spreadPct.toFixed(2)}%</b>`,
    '',
    `Монета: <b>${escapeHtml(coin.symbol)}</b>`,
    '',
    `<b>Short:</b>`,
    `Биржа: ${exchangeLinkHtml(spread.sellExchange, spread.sellRawSymbol)}`,
    `Тип рынка: бессрочные фьючерсы`,
    `Оборот 24ч: ${fmtVolume(shortTicker?.volumeUsdt)}`,
    `Цена: ${fmtPrice(spread.sellPrice)}`,
    '',
    `<b>Long:</b>`,
    `Биржа: ${exchangeLinkHtml(spread.buyExchange, spread.buyRawSymbol)}`,
    `Тип рынка: бессрочные фьючерсы`,
    `Оборот 24ч: ${fmtVolume(longTicker?.volumeUsdt)}`,
    `Цена: ${fmtPrice(spread.buyPrice)}`,
    '',
    `Курсовой спред: <b>${spread.spreadPct.toFixed(2)}%</b>`,
  ];

  return lines.join('\n');
}

function openAppKeyboard() {
  if (!PUBLIC_URL) return undefined;
  return Markup.inlineKeyboard([[Markup.button.webApp('Открыть в приложении', PUBLIC_URL)]]);
}

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [
        { text: '🏠 Покажи все команды' },
      ],
      [
       { text: '📊 Проверить спред сейчас' },
      ],
      [
         { text: '🔔 Включить рассылку' },
         { text: '🔕 Остановить рассылку' },
      ]
    ],
    resize_keyboard: true,
  },
};


async function sendAlertCards(telegram, chatId, coins) {
  for (const coin of coins.slice(0, MAX_ALERT_CARDS_PER_SEND)) {
    await telegram.sendMessage(chatId, formatCoinAlertMessage(coin), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...openAppKeyboard(),
    });
  }
}

async function sendReport(ctx) {
  await ctx.sendChatAction('typing');
  const typingInterval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  const progressMsg = await ctx.reply('🔎 Сканирую биржи, обычно занимает 10-20 секунд…');

  try {
    const report = await buildReport();
    const alerts = report.coins.filter((c) => c.alert);
    clearInterval(typingInterval);

    if (alerts.length === 0) {
      let text =
        `Просканировал ${report.totalScanned} монет, которые торгуются на 2+ биржах из ${report.exchangeCount}.\n` +
        `Ни одна не превысила порог ${config.threshold}% — сейчас интересных расхождений нет.`;
      if (report.suspiciousCount > 0) {
        text += `\n(ещё ${report.suspiciousCount} отфильтровано как подозрительные — вероятно, разные активы под одним тикером)`;
      }
      if (report.failedExchanges.length > 0) {
        text += `\n⚠️ Нет данных с: ${report.failedExchanges.join(', ')}`;
      }
      await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text);
      return;
    }

    let intro = `🚨 Найдено ${alerts.length} монет со спредом ≥ ${config.threshold}% (из ${report.totalScanned} просканированных):`;
    if (alerts.length > MAX_ALERT_CARDS_PER_SEND) {
      intro += `\nПоказываю топ-${MAX_ALERT_CARDS_PER_SEND}, остальное — в приложении.`;
    }
    if (report.failedExchanges.length > 0) {
      intro += `\n⚠️ Нет данных с: ${report.failedExchanges.join(', ')}`;
    }
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, intro);

    await sendAlertCards(ctx.telegram, ctx.chat.id, alerts);
  } catch (err) {
    clearInterval(typingInterval);
    console.error('sendReport failed:', err);
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        undefined,
        '⚠️ Не удалось получить цены с бирж. Попробуй ещё раз через минуту — если повторится, посмотри логи сервера (там будет причина).'
      )
      .catch(() => {});
  }
}

bot.start(async (ctx) => {
  const buttons = [];
  if (PUBLIC_URL) {
    buttons.push([Markup.button.webApp('📱 Открыть приложение', PUBLIC_URL)]);
  }
  buttons.push([Markup.button.callback('🔄 Проверить сейчас', 'check')]);

  await ctx.reply(
    `Привет! Я сканирую монеты на нескольких биржах и показываю те, где спред между какими-то двумя из них ≥ ${config.threshold}%.\n`,
    Markup.inlineKeyboard(buttons)
  );

  // Reply keyboards and inline keyboards can't share one message's
  // reply_markup — Telegram allows only one kind per message. Send the
  // persistent bottom keyboard as a short follow-up instead; once sent it
  // stays visible on every later message until explicitly removed.
  await ctx.reply(`Команды доступны через кнопку, рядом со строкой ввода:\n` +
                  `/check — проверить прямо сейчас\n` +
                  `/alerts — включить автоматическую рассылку (спрошу, как часто)\n` +
                  `/alerts_off — остановить автоматическую рассылку`,
                   mainKeyboard);
});

bot.command('check', sendReport);
bot.action('check', async (ctx) => {
  await ctx.answerCbQuery();
  await sendReport(ctx);
});

// /alerts starts a short conversation instead of taking the interval as an
// argument: ask how often, then read the next plain-text message as the
// answer (handled in bot.on('text', ...) below).
bot.command('alerts', async (ctx) => {
  awaitingAlertsInterval.add(ctx.chat.id);
  await ctx.reply('Как часто присылать алерты, в минутах? Просто напиши число, например: 5');
});

bot.command('alerts_off', async (ctx) => {
  const chatId = ctx.chat.id;
  awaitingAlertsInterval.delete(chatId);
  if (activeAlertTimers.has(chatId)) {
    clearInterval(activeAlertTimers.get(chatId));
    activeAlertTimers.delete(chatId);
    await ctx.reply('🛑 Автоматическая рассылка остановлена.');
  } else {
    await ctx.reply('Автоматическая рассылка и так не запущена.');
  }
});

function startAlertTimer(chatId, minutes) {
  if (activeAlertTimers.has(chatId)) {
    clearInterval(activeAlertTimers.get(chatId));
  }

  const handle = setInterval(async () => {
    try {
      const report = await buildReport();
      const alerts = report.coins.filter((c) => c.alert);
      if (alerts.length > 0) {
        await sendAlertCards(bot.telegram, chatId, alerts);
      }
    } catch (err) {
      console.error('Scheduled alert tick failed:', err);
    }
  }, minutes * 60 * 1000);

  activeAlertTimers.set(chatId, handle);
}


// Plain-text handler — only meaningful right now for answering the
// "how many minutes?" question /alerts just asked. Anything else (or any
// text when no chat is waiting) is ignored so this doesn't interfere with
// normal command handling above.


bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  // ============================
  // Начать / показать меню
  // ============================
  if (text === '🏠 Покажи все команды') {
    await ctx.reply(
      `/start - запуск бота\n/check - ручная проверка спреда\n/alerts - авторассылка спредов\n/alerts_off - отключить авторассылку`,
    );
    return;
  }

  // ============================
  // Проверить спред сейчас
  // ============================
  if (text === '📊 Проверить спред сейчас') {
    await sendReport(ctx);
    return;
  }

  // ============================
  // Включить автоматическую рассылку
  // ============================
  if (text === '🔔 Включить рассылку') {
    awaitingAlertsInterval.add(chatId);

    await ctx.reply(
      'Как часто присылать алерты, в минутах? Просто напиши число, например: 5'
    );

    return;
  }

  // ============================
  // Остановить автоматическую рассылку
  // ============================
  if (text === '🔕 Остановить рассылку') {
    awaitingAlertsInterval.delete(chatId);

    if (activeAlertTimers.has(chatId)) {
      clearInterval(activeAlertTimers.get(chatId));
      activeAlertTimers.delete(chatId);

      await ctx.reply(
        '🛑 Автоматическая рассылка остановлена.',
        mainKeyboard
      );
    } else {
      await ctx.reply(
        'Автоматическая рассылка и так не запущена.',
        mainKeyboard
      );
    }

    return;
  }

  // ============================
  // Ответ с количеством минут
  // ============================
  if (!awaitingAlertsInterval.has(chatId)) {
    return;
  }

  const minutes = parseFloat(
    text.replace(',', '.')
  );

  if (Number.isNaN(minutes)) {
    await ctx.reply(
      'Нужно просто число минут, например: 5'
    );
    return;
  }

  if (minutes < 1 || minutes > 180) {
    await ctx.reply(
      'Интервал должен быть от 1 до 180 минут.'
    );
    return;
  }

  awaitingAlertsInterval.delete(chatId);

  startAlertTimer(chatId, minutes);

  await ctx.reply(
    `✅ Буду присылать алерты каждые ${minutes} мин.`,
    mainKeyboard
  );
});

// Catches errors from any handler above so a bug never just fails silently
// for the user — they get a message, and you get the real error in logs.
bot.catch((err, ctx) => {
  console.error(`Telegraf error for update ${ctx.updateType}:`, err);
  ctx.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => {});
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

bot.launch();
console.log('Bot started');


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
