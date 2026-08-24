const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// ---------- DOM refs ----------
const listEl = document.getElementById('list');
const emptyStateEl = document.getElementById('emptyState');
const refreshBtn = document.getElementById('refreshBtn');
const searchInput = document.getElementById('searchInput');
const thresholdPill = document.getElementById('thresholdPill');
const scanInfoEl = document.getElementById('scanInfo');
const coinCardTemplate = document.getElementById('coinCardTemplate');
const pairCardTemplate = document.getElementById('pairCardTemplate');
const coinGroupTemplate = document.getElementById('coinGroupTemplate');
const coinPickerEl = document.getElementById('coinPicker');
const coinPickerListEl = document.getElementById('coinPickerList');
const coinPickerCountEl = document.getElementById('coinPickerCount');
const pageScanEl = document.getElementById('pageScan');
const pageSettingsEl = document.getElementById('pageSettings');
const bottomNavEl = document.querySelector('.bottom-nav');
const volumePickerEl = document.getElementById('volumePicker');
const volumePickerListEl = document.getElementById('volumePickerList');
const volumePickerValueEl = document.getElementById('volumePickerValue');
const autorefreshToggleEl = document.getElementById('autorefreshToggle');

// ---------- State ----------
let lastData = [];
let lastThreshold = null;
let selectedCoinSymbol = null; // set when a coin is picked from the coin-picker list
const MAX_PAIRS_PER_COIN = 8; // cap how many exchange-pairs we show for one coin

const DEFAULT_MIN_VOLUME = 100000;
let selectedVolume = Number(localStorage.getItem('minVolume')) || DEFAULT_MIN_VOLUME;

const AUTOREFRESH_MS = 8000;
let autorefreshEnabled = localStorage.getItem('autorefresh') === 'true';
let autorefreshTimer = null;

// ---------- Formatting ----------
function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
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

// ---------- Exchange deep links ----------
// Keep in sync with links.js on the backend (duplicated — no bundler to
// share a module between frontend and backend in this project).
const EXCHANGE_URL_BUILDERS = {
  Bybit: (rawSymbol) => `https://www.bybit.com/trade/usdt/${rawSymbol}`,
  OKX: (rawSymbol) => `https://www.okx.com/trade-swap/${rawSymbol.toLowerCase()}`,
  Binance: (rawSymbol) => `https://www.binance.com/en/futures/${rawSymbol}`,
  Bitget: (rawSymbol) => `https://www.bitget.com/futures/usdt/${rawSymbol}`,
  'Gate.io': (rawSymbol) => `https://www.gate.io/futures_trade/USDT/${rawSymbol}`,
  MEXC: (rawSymbol) => `https://www.mexc.com/futures/${rawSymbol}`,
  KuCoin: (rawSymbol) => `https://www.kucoin.com/futures/trade/${rawSymbol}`,
  HTX: (rawSymbol) => `https://www.htx.com/en-us/futures/linear_swap/exchange/#contract_code=${rawSymbol}`,
  BingX: (rawSymbol) => `https://bingx.com/en/perpetual/${rawSymbol}`,
  ASTER: (rawSymbol) => `https://www.asterdex.com/en/futures/${rawSymbol}`,
  Ourbit: (rawSymbol) => `https://futures.ourbit.com/exchange/${rawSymbol}`,
  KCEX: (rawSymbol) => `https://www.kcex.com/futures/exchange/${rawSymbol}`,
  BitMart: (rawSymbol) => `https://www.bitmart.com/ru-RU/futures/${rawSymbol}`,
  'BitMart Spot': (rawSymbol) => `https://www.bitmart.com/ru-RU/trade?symbol=${rawSymbol}`,
  'Gate.io Spot': (rawSymbol) => `https://www.gate.io/trade/${rawSymbol}`,
  'HTX Spot': (rawSymbol) => `https://www.htx.com/trade/${rawSymbol.toLowerCase()}`,
  'BingX Spot': (rawSymbol) => `https://bingx.com/en/spot/${rawSymbol.replace('-', '_')}`,
  'KuCoin Spot': (rawSymbol) => `https://www.kucoin.com/trade/${rawSymbol}`,
};

function buildExchangeUrl(exchange, rawSymbol) {
  const build = EXCHANGE_URL_BUILDERS[exchange];
  return build ? build(rawSymbol) : null;
}

function openExternal(url) {
  if (!url) return;
  if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ---------- All-pairs calculation (mirrors exchanges.js computeAllPairs) ----------
function computeAllPairs(tickers) {
  const pairs = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i];
      const b = tickers[j];
      // Only a futures ticker can be the sell/short leg — spot can't be
      // sold short here (no borrowing modeled), only bought long.
      const spreadAB = b.market === 'futures' && a.ask && b.bid ? ((b.bid - a.ask) / a.ask) * 100 : null;
      const spreadBA = a.market === 'futures' && b.ask && a.bid ? ((a.bid - b.ask) / b.ask) * 100 : null;

      if (spreadAB !== null && (spreadBA === null || spreadAB >= spreadBA)) {
        pairs.push({ buyExchange: a.exchange, buyPrice: a.ask, buyTicker: a, sellExchange: b.exchange, sellPrice: b.bid, sellTicker: b, spreadPct: spreadAB });
      } else if (spreadBA !== null) {
        pairs.push({ buyExchange: b.exchange, buyPrice: b.ask, buyTicker: b, sellExchange: a.exchange, sellPrice: a.bid, sellTicker: a, spreadPct: spreadBA });
      }
    }
  }
  pairs.sort((x, y) => y.spreadPct - x.spreadPct);
  return pairs;
}

// ---------- Shared exchange-panel filler ----------
function fillExchangePanel(panel, name, ticker) {
  const url = ticker ? buildExchangeUrl(ticker.exchange, ticker.rawSymbol) : null;
  // BitMart's ticker sometimes falls back to bid=ask=last_price when it
  // wasn't (or couldn't be) checked against the real order book — flag
  // that so an unusually large spread involving BitMart doesn't get taken
  // at face value.
  const approxNote = ticker?.approximated ? ' ≈' : '';
  const label = ticker ? `${name}${approxNote}` : name;
  panel.querySelector('.exchange__name').textContent = url ? `${label} ↗` : label;
  panel.title = ticker?.approximated
    ? 'Bid/Ask не подтверждены реальным стаканом — использована последняя цена сделки'
    : '';
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

function fillPairExchanges(container, pair) {
  const [buyPanel, sellPanel] = container.querySelectorAll('.exchange');
  fillExchangePanel(buyPanel, pair.buyExchange, pair.buyTicker);
  fillExchangePanel(sellPanel, pair.sellExchange, pair.sellTicker);
}

// ---------- Default list: one card per coin, best pair only ----------
function renderCoin(coin) {
  const node = coinCardTemplate.content.cloneNode(true);
  const card = node.querySelector('.coin-card');

  node.querySelector('.coin-card__name').textContent = coin.symbol;

  const badge = node.querySelector('.spread-badge');
  const routeEl = node.querySelector('.coin-card__route');

  badge.textContent = `${coin.spread.spreadPct.toFixed(2)}%`;
  routeEl.textContent = `купить на ${coin.spread.buyExchange} → продать на ${coin.spread.sellExchange}`;

  if (coin.alert) {
    badge.classList.add('is-alert');
    card.classList.add('is-alert');
  }

  const buyTicker = coin.tickers.find((t) => t.exchange === coin.spread.buyExchange);
  const sellTicker = coin.tickers.find((t) => t.exchange === coin.spread.sellExchange);
  fillPairExchanges(card, {
    buyExchange: coin.spread.buyExchange,
    buyTicker,
    sellExchange: coin.spread.sellExchange,
    sellTicker,
  });

  return node;
}

// ---------- Selected-coin detail: every pair, sorted by spread ----------
function renderCoinGroup(coin) {
  const node = coinGroupTemplate.content.cloneNode(true);
  const group = node.querySelector('.coin-group');
  group.querySelector('.coin-group__name').textContent = coin.symbol;

  const pairs = computeAllPairs(coin.tickers).slice(0, MAX_PAIRS_PER_COIN);
  group.querySelector('.coin-group__count').textContent =
    pairs.length > 1 ? `${pairs.length} пары бирж` : `${pairs.length} пара бирж`;

  const pairsWrap = group.querySelector('.coin-group__pairs');
  for (const pair of pairs) {
    const pairNode = pairCardTemplate.content.cloneNode(true);
    const pairCard = pairNode.querySelector('.pair-card');
    const spreadEl = pairNode.querySelector('.pair-card__spread');
    spreadEl.textContent = `${pair.spreadPct.toFixed(2)}%`;
    if (lastThreshold !== null && pair.spreadPct >= lastThreshold) {
      spreadEl.classList.add('is-alert');
      pairCard.classList.add('is-alert');
    }
    fillPairExchanges(pairCard, pair);
    pairsWrap.appendChild(pairNode);
  }

  return node;
}

// ---------- Coin picker (details dropdown under the search bar) ----------
function populateCoinPicker(coins) {
  const alertCoins = coins.filter((c) => c.alert).sort((a, b) => b.spread.spreadPct - a.spread.spreadPct);
  coinPickerListEl.innerHTML = '';
  coinPickerCountEl.textContent = alertCoins.length > 0 ? String(alertCoins.length) : '';

  if (alertCoins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'coin-picker__empty';
    empty.textContent = 'Пока нет монет со спредом — сначала обнови данные';
    coinPickerListEl.appendChild(empty);
    return;
  }

  alertCoins.forEach((coin, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'coin-picker__item';
    if (i < 3) btn.classList.add('is-top');

    const rank = document.createElement('span');
    rank.className = 'coin-picker__item-rank';
    rank.textContent = `${i + 1}.`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'coin-picker__item-name';
    nameSpan.textContent = coin.symbol;

    const spreadSpan = document.createElement('span');
    spreadSpan.className = 'coin-picker__item-spread';
    spreadSpan.textContent = `${coin.spread.spreadPct.toFixed(2)}%`;

    btn.appendChild(rank);
    btn.appendChild(nameSpan);
    btn.appendChild(spreadSpan);

    btn.addEventListener('click', () => {
      tg?.HapticFeedback?.impactOccurred('light');
      selectedCoinSymbol = coin.symbol;
      coinPickerEl.open = false;
      searchInput.value = '';
      render();
    });

    coinPickerListEl.appendChild(btn);
  });
}

// ---------- Main render ----------
function render() {
  listEl.innerHTML = '';

  // A coin picked from the dropdown list takes priority: show every pair
  // for just that coin, sorted highest spread first.
  if (selectedCoinSymbol) {
    const coin = lastData.find((c) => c.symbol === selectedCoinSymbol);
    if (!coin) {
      selectedCoinSymbol = null;
      render();
      return;
    }

    const header = document.createElement('div');
    header.className = 'coin-detail__header';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'coin-detail__back';
    backBtn.textContent = '← Назад';
    backBtn.addEventListener('click', () => {
      selectedCoinSymbol = null;
      render();
    });
    const title = document.createElement('div');
    title.className = 'coin-detail__title';
    title.textContent = coin.symbol;
    header.appendChild(backBtn);
    header.appendChild(title);
    listEl.appendChild(header);

    listEl.appendChild(renderCoinGroup(coin));
    return;
  }

  const query = searchInput.value.trim().toLowerCase();
  const pool = query ? lastData : lastData.filter((c) => c.alert);
  const filtered = query ? pool.filter((c) => c.symbol.toLowerCase().includes(query)) : pool;

  if (filtered.length === 0) {
    emptyStateEl.textContent = lastData.length === 0
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

// ---------- Fetch ----------
async function loadPrices({ silent = false } = {}) {
  if (!silent) {
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    scanInfoEl.textContent = 'Сканирую биржи…';
  }
  try {
    const url = `/api/prices?minVolume=${encodeURIComponent(selectedVolume)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Ошибка сервера');

    lastData = data.coins;
    lastThreshold = data.threshold;
    thresholdPill.textContent = `Порог алерта: ${data.threshold}%`;

    let info = `Просканировано ${data.totalScanned} монет на ${data.exchangeCount} биржах · со спредом ≥ ${data.threshold}%: ${data.alertsCount}`;
    if (data.suspiciousCount > 0) info += ` · скрыто как подозрительные (>${data.maxSaneSpreadPercent}%): ${data.suspiciousCount}`;
    if (data.failedExchanges?.length) info += ` · нет данных: ${data.failedExchanges.join(', ')}`;
    scanInfoEl.textContent = info;

    populateCoinPicker(lastData);
    render();

    if (!silent) {
      if (data.alertsCount > 0) {
        tg?.HapticFeedback?.notificationOccurred('warning');
        toast(`🚨 Найдено монет со спредом: ${data.alertsCount}`);
      } else {
        tg?.HapticFeedback?.impactOccurred('light');
      }
    }
  } catch (err) {
    console.error(err);
    if (!silent) {
      scanInfoEl.textContent = '';
      toast('Не удалось получить цены. Попробуй ещё раз.');
    }
  } finally {
    if (!silent) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }
}

// ---------- Bottom nav (scan vs settings page) ----------
function setPage(page) {
  pageScanEl.hidden = page !== 'scan';
  pageSettingsEl.hidden = page !== 'settings';
  bottomNavEl.querySelectorAll('.bottom-nav__btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.page === page);
  });

  // Pause the 8s autorefresh while off the scan page — no point polling
  // in the background — and resume it on return if it was on.
  if (page !== 'scan' && autorefreshTimer) {
    clearInterval(autorefreshTimer);
    autorefreshTimer = null;
  } else if (page === 'scan' && autorefreshEnabled && !autorefreshTimer) {
    autorefreshTimer = setInterval(() => loadPrices({ silent: true }), AUTOREFRESH_MS);
  }
}

bottomNavEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.bottom-nav__btn');
  if (btn) setPage(btn.dataset.page);
});

// ---------- Settings: min-volume picker ----------
function renderVolumePickerState() {
  volumePickerValueEl.textContent = `${selectedVolume.toLocaleString('ru-RU')} $`;
  volumePickerListEl.querySelectorAll('.volume-picker__item').forEach((btn) => {
    btn.classList.toggle('is-selected', Number(btn.dataset.volume) === selectedVolume);
  });
}

volumePickerListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.volume-picker__item');
  if (!btn) return;
  selectedVolume = Number(btn.dataset.volume);
  localStorage.setItem('minVolume', String(selectedVolume));
  renderVolumePickerState();
  volumePickerEl.open = false;
  tg?.HapticFeedback?.impactOccurred('light');
  loadPrices();
});

// ---------- Autorefresh toggle (off by default, refreshes every 8s when on) ----------
function setAutorefresh(enabled) {
  autorefreshEnabled = enabled;
  localStorage.setItem('autorefresh', String(enabled));
  autorefreshToggleEl.setAttribute('aria-pressed', String(enabled));

  if (autorefreshTimer) {
    clearInterval(autorefreshTimer);
    autorefreshTimer = null;
  }
  if (enabled) {
    autorefreshTimer = setInterval(() => loadPrices({ silent: true }), AUTOREFRESH_MS);
  }
}

autorefreshToggleEl.addEventListener('click', () => {
  tg?.HapticFeedback?.impactOccurred('light');
  setAutorefresh(!autorefreshEnabled);
});

// ---------- Wiring ----------
refreshBtn.addEventListener('click', () => loadPrices());
searchInput.addEventListener('input', () => {
  selectedCoinSymbol = null;
  render();
});

renderVolumePickerState();
setAutorefresh(autorefreshEnabled); // restore saved preference, starts the timer if it was on
loadPrices();
