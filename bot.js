require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { buildReport } = require('./report');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const MAX_LINES_IN_CHAT = 20;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Добавь его в .env (см. .env.example).');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4); // very small prices — keep significant digits instead of rounding to 0
}

function formatReport(report) {
  const { coins, failedExchanges, suspiciousCount } = report;
  const alerts = coins.filter((c) => c.alert);
  const lines = [];

  if (failedExchanges.length > 0) {
    lines.push(`⚠️ Не удалось получить данные с: ${failedExchanges.join(', ')} (пропустил их в этот раз)`, '');
  }

  if (alerts.length === 0) {
    lines.push(
      `Просканировал ${coins.length} монет, которые торгуются на 2+ биржах из списка.`,
      `Ни одна не превысила порог ${config.threshold}% — сейчас интересных расхождений нет.`
    );
    if (suspiciousCount > 0) {
      lines.push(`(ещё ${suspiciousCount} отфильтровано как подозрительные — вероятно, разные монеты под одним тикером)`);
    }
    return lines.join('\n');
  }

  lines.push(
    `🚨 Найдено ${alerts.length} монет со спредом ≥ ${config.threshold}% (из ${coins.length} просканированных):`,
    ''
  );

  for (const coin of alerts.slice(0, MAX_LINES_IN_CHAT)) {
    lines.push(
      `💠 ${coin.symbol} — ${coin.spread.spreadPct.toFixed(2)}%\n` +
        `   купить на ${coin.spread.buyExchange} за ${fmt(coin.spread.buyPrice)}, ` +
        `продать на ${coin.spread.sellExchange} за ${fmt(coin.spread.sellPrice)}`
    );
  }

  if (alerts.length > MAX_LINES_IN_CHAT) {
    lines.push('', `…и ещё ${alerts.length - MAX_LINES_IN_CHAT}. Полный список — в приложении.`);
  }
  if (suspiciousCount > 0) {
    lines.push('', `(ещё ${suspiciousCount} монет отфильтровано как подозрительные — вероятно, разные активы под одним тикером)`);
  }

  return lines.join('\n');
}

async function sendReport(ctx) {
  // Keep the "typing…" indicator alive — Telegram only shows it for ~5s per
  // call, but a 6-exchange scan can take 10-15s, so without this the
  // indicator disappears while we're still working and it looks like nothing
  // is happening.
  await ctx.sendChatAction('typing');
  const typingInterval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  // Send something immediately so there's visible progress, then edit it
  // once the scan finishes.
  const progressMsg = await ctx.reply('🔎 Сканирую 6 бирж, обычно занимает 10-15 секунд…');

  try {
    const report = await buildReport();
    const text = formatReport(report);
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text);
  } catch (err) {
    console.error('sendReport failed:', err);
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        undefined,
        '⚠️ Не удалось получить цены с бирж. Попробуй ещё раз через минуту — если повторится, посмотри логи сервера (там будет причина).'
      )
      .catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

bot.start(async (ctx) => {
  const buttons = [];

  if (PUBLIC_URL) {
    buttons.push([Markup.button.webApp('📱 Открыть приложение', PUBLIC_URL)]);
  }
  buttons.push([Markup.button.callback('🔄 Проверить сейчас', 'check')]);

  await ctx.reply(
    `Привет! Я сканирую монеты на Bybit, OKX, Binance, Bitget, Gate.io и MEXC ` +
      `и показываю те, где спред между какими-то двумя из них ≥ ${config.threshold}%.\n\n` +
      `Нажми «Проверить сейчас» или открой приложение.`,
    Markup.inlineKeyboard(buttons)
  );
});

bot.command('check', sendReport);
bot.action('check', async (ctx) => {
  await ctx.answerCbQuery();
  await sendReport(ctx);
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
