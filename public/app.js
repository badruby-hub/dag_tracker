const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const listEl = document.getElementById('list');
const emptyStateEl = document.getElementById('emptyState');
const refreshBtn = document.getElementById('refreshBtn');
const searchInput = document.getElementById('searchInput');
const thresholdPill = document.getElementById('thresholdPill');
const scanInfoEl = document.getElementById('scanInfo');
const cardTemplate = document.getElementById('coinCardTemplate');

let lastData = [];
let lastThreshold = null;

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4); // very small prices — keep significant digits instead of rounding to 0
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function findTicker(coin, exchangeName) {
  return coin.tickers.find((t) => t.exchange === exchangeName) || null;
}

// Best-effort deep links to each exchange's futures trading page for a
// symbol. Exchanges change their URL structure occasionally — if a link
// ever 404s, this is the one place to fix it.
const EXCHANGE_URL_BUILDERS = {
  Bybit: (rawSymbol) => `https://www.bybit.com/trade/usdt/${rawSymbol}`,
  OKX: (rawSymbol) => `https://www.okx.com/trade-swap/${rawSymbol.toLowerCase()}`,
  Binance: (rawSymbol) => `https://www.binance.com/en/futures/${rawSymbol}`,
  Bitget: (rawSymbol) => `https://www.bitget.com/futures/usdt/${rawSymbol}`,
  'Gate.io': (rawSymbol) => `https://www.gate.io/futures_trade/USDT/${rawSymbol}`,
  MEXC: (rawSymbol) => `https://www.mexc.com/futures/${rawSymbol}`,
};

function buildExchangeUrl(exchange, rawSymbol) {
  const build = EXCHANGE_URL_BUILDERS[exchange];
  return build ? build(rawSymbol) : null;
}

// Inside Telegram's Mini App WebView, a plain window.open() can be blocked
// or swallowed — Telegram.WebApp.openLink() is the supported way to hand a
// URL off to the system browser. Falls back to window.open() for testing
// in a regular desktop/mobile browser outside Telegram.
function openExternal(url) {
  if (!url) return;
  if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function renderCoin(coin) {
  const node = cardTemplate.content.cloneNode(true);
  const card = node.querySelector('.coin-card');

  node.querySelector('.coin-card__name').textContent = coin.symbol;

  const badge = node.querySelector('.spread-badge');
  const [buyPanel, sellPanel] = node.querySelectorAll('.exchange');
  const routeEl = node.querySelector('.coin-card__route');

  badge.textContent = `${coin.spread.spreadPct.toFixed(2)}%`;

  const otherCount = coin.tickers.length - 2;
  const alsoOn = otherCount > 0 ? ` · есть ещё на ${otherCount} бирж${plural(otherCount)}` : '';
  routeEl.textContent = `купить на ${coin.spread.buyExchange} → продать на ${coin.spread.sellExchange}${alsoOn}`;

  if (coin.alert) {
    badge.classList.add('is-alert');
    card.classList.add('is-alert');
  }

  fillExchangePanel(buyPanel, coin.spread.buyExchange, findTicker(coin, coin.spread.buyExchange));
  fillExchangePanel(sellPanel, coin.spread.sellExchange, findTicker(coin, coin.spread.sellExchange));

  return node;
}

function plural(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'е';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'ах';
  return 'ах';
}

function fillExchangePanel(panel, name, ticker) {
  const url = ticker ? buildExchangeUrl(ticker.exchange, ticker.rawSymbol) : null;
  const label = ticker ? `${name} · ${ticker.rawSymbol}` : name;
  panel.querySelector('.exchange__name').textContent = url ? `${label} ↗` : label;
  panel.querySelector('.v-bid').textContent = ticker ? fmtPrice(ticker.bid) : '—';
  panel.querySelector('.v-ask').textContent = ticker ? fmtPrice(ticker.ask) : '—';
  panel.querySelector('.v-last').textContent = ticker ? fmtPrice(ticker.last) : '—';

  if (url) {
    panel.classList.add('exchange--clickable');
    panel.addEventListener('click', () => {
      tg?.HapticFeedback?.impactOccurred('light');
      openExternal(url);
    });
  }
}

function render(coins) {
  const query = searchInput.value.trim().toLowerCase();

  // No search: only show coins that actually cleared the alert threshold —
  // that's the whole point, we don't want to dump the entire market on screen.
  // While searching: look across everything scanned, alert or not, so the
  // user can check a specific coin's spread on demand.
  const pool = query ? coins : coins.filter((c) => c.alert);
  const filtered = query ? pool.filter((c) => c.symbol.toLowerCase().includes(query)) : pool;

  listEl.innerHTML = '';

  if (filtered.length === 0) {
    emptyStateEl.textContent = coins.length === 0
      ? 'Нажми обновить, чтобы просканировать рынок'
      : query
        ? 'Ничего не найдено по этому запросу'
        : `Пока нет монет со спредом ≥ ${lastThreshold ?? '—'}%. Попробуй поиск, чтобы посмотреть конкретную монету.`;
    listEl.appendChild(emptyStateEl);
    return;
  }

  const sorted = [...filtered].sort((a, b) => b.spread.spreadPct - a.spread.spreadPct);
  for (const coin of sorted) {
    listEl.appendChild(renderCoin(coin));
  }
}

async function loadPrices() {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  scanInfoEl.textContent = 'Сканирую биржи…';
  try {
    const res = await fetch('/api/prices');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Ошибка сервера');

    lastData = data.coins;
    lastThreshold = data.threshold;
    thresholdPill.textContent = `Порог алерта: ${data.threshold}%`;

    let info = `Просканировано ${data.totalScanned} монет на ${data.exchangeCount} биржах · со спредом ≥ ${data.threshold}%: ${data.alertsCount}`;
    if (data.suspiciousCount > 0) {
      info += ` · скрыто как подозрительные (>${data.maxSaneSpreadPercent}%): ${data.suspiciousCount}`;
    }
    if (data.failedExchanges?.length) {
      info += ` · нет данных: ${data.failedExchanges.join(', ')}`;
    }
    scanInfoEl.textContent = info;

    render(lastData);

    if (data.alertsCount > 0) {
      tg?.HapticFeedback?.notificationOccurred('warning');
      toast(`🚨 Найдено монет со спредом: ${data.alertsCount}`);
    } else {
      tg?.HapticFeedback?.impactOccurred('light');
    }
  } catch (err) {
    console.error(err);
    scanInfoEl.textContent = '';
    toast('Не удалось получить цены. Попробуй ещё раз.');
  } finally {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', loadPrices);
searchInput.addEventListener('input', () => render(lastData));

// Load once on open so the screen isn't empty, then it's manual (refresh button) from here.
loadPrices();
