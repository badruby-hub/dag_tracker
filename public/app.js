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
const freshnessEl = document.getElementById('freshnessInfo');
const pairModePickerEl = document.getElementById('pairModePicker');
const pairModePickerListEl = document.getElementById('pairModePickerList');
const pairModePickerValueEl = document.getElementById('pairModePickerValue');

// ---------- State ----------
let lastData = [];
let lastThreshold = null;
let selectedCoinSymbol = null; // set when a coin is picked from the coin-picker list
const MAX_PAIRS_PER_COIN = 8; // cap how many exchange-pairs we show for one coin

const DEFAULT_MIN_VOLUME = 100000;
let selectedVolume = Number(localStorage.getItem('minVolume')) || DEFAULT_MIN_VOLUME;

const PAIR_MODE_LABELS = {
  all: 'Все',
  'futures-futures': 'Фьючерсы ↔ фьючерсы',
  'spot-futures': 'Спот ↔ фьючерсы',
};
let selectedPairMode = localStorage.getItem('pairMode') || 'all';
if (!PAIR_MODE_LABELS[selectedPairMode]) selectedPairMode = 'all';

const AUTOREFRESH_SECONDS = 8;
let autorefreshEnabled = localStorage.getItem('autorefresh') === 'true';
let autorefreshTimer = null;
let autorefreshCountdown = AUTOREFRESH_SECONDS;

let lastFetchAt = null; // Date.now() of the last successful fetch, for the freshness ticker

// ---------- Formatting ----------
function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
}

// Chart labels/axis specifically want a fixed, compact 2-decimal look
// (0.04, 14.20) rather than fmtPrice's adaptive precision (0.042143) —
// a live chart reads better with short, stable numbers than exact ones.
function fmtChartPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(2);
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
  'HTX Spot': (rawSymbol) => `https://www.htx.com/trade/${rawSymbol.slice(0, -4).toLowerCase()}_usdt/`,
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
function computeAllPairs(tickers, pairMode = 'all') {
  const pairs = [];
  const buyAllowed = (t) => {
    if (pairMode === 'futures-futures') return t.market === 'futures';
    if (pairMode === 'spot-futures') return t.market === 'spot';
    return true;
  };

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i];
      const b = tickers[j];
      // Only a futures ticker can be the sell/short leg — spot can't be
      // sold short here (no borrowing modeled), only bought long.
      const spreadAB = b.market === 'futures' && buyAllowed(a) && a.ask && b.bid ? ((b.bid - a.ask) / a.ask) * 100 : null;
      const spreadBA = a.market === 'futures' && buyAllowed(b) && b.ask && a.bid ? ((a.bid - b.ask) / b.ask) * 100 : null;

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
  const detailBtn = node.querySelector('.coin-card__detail-btn');

  badge.textContent = `${coin.spread.spreadPct.toFixed(2)}%`;
  routeEl.textContent = `купить на ${coin.spread.buyExchange} → продать на ${coin.spread.sellExchange}`;

  detailBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    tg?.HapticFeedback?.impactOccurred('light');
    selectedCoinSymbol = coin.symbol;
    searchInput.value = '';
    render();
  });

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

  const pairs = computeAllPairs(coin.tickers, selectedPairMode).slice(0, MAX_PAIRS_PER_COIN);
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

// ---------- Featured pair (top of detail page): funding/entry/exit + two charts ----------
const featuredPairTemplate = document.getElementById('featuredPairTemplate');
const chartBlockTemplate = document.getElementById('chartBlockTemplate');
const HISTORY_MINUTES = 60; // how much real exchange history the "История спредов" chart pulls, once
const MAX_LIVE_POINTS = 300; // ~5 minutes of live 1/sec ticks kept in memory

// Two fully independent chart instances: `live` ticks every second and
// never touches history; `history` is loaded ONCE (on opening the coin
// page) from the exchanges' own candles and never auto-refreshes.
// windowSize means "pixels per point" (horizontal zoom); yZoom scales the
// vertical price range around its center (>1 = zoomed in, <1 = zoomed out).
let live = { key: null, timer: null, points: [], windowSize: 8, yZoom: 1, els: null };
let history = { key: null, points: [], windowSize: 8, yZoom: 1, els: null };

function fmtSignedPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(3)}%`;
}

// Clones the shared chart template into a container and wires up
// drag/scroll-to-zoom gestures on its price and time axes (replacing the
// old +/- buttons with the same interaction real exchange charts use).
// Returns the collected DOM refs used by drawChart()/updateStatus().
function buildChartEls(container, chart, statusText, hintText) {
  const node = chartBlockTemplate.content.cloneNode(true);
  const wrap = node.querySelector('.live-chart-wrap');

  const els = {
    entryLineEl: wrap.querySelector('.live-chart__line--entry'),
    exitLineEl: wrap.querySelector('.live-chart__line--exit'),
    entryDashEl: wrap.querySelector('.live-chart__dash--entry'),
    exitDashEl: wrap.querySelector('.live-chart__dash--exit'),
    entryBadgeEl: wrap.querySelector('.live-chart-badge--entry b'),
    exitBadgeEl: wrap.querySelector('.live-chart-badge--exit b'),
    gridEl: wrap.querySelector('.live-chart-grid'),
    yaxisEl: wrap.querySelector('.live-chart-yaxis'),
    xaxisEl: wrap.querySelector('.live-chart-xaxis'),
    xaxisStartEl: wrap.querySelector('.live-chart-xaxis__start'),
    xaxisNowEl: wrap.querySelector('.live-chart-xaxis__now'),
    statusEl: wrap.querySelector('.live-chart-status'),
  };

  els.statusEl.querySelector('.live-chart-status__text').textContent = statusText;
  wrap.querySelector('.live-chart-hint').textContent = hintText;

  // Price axis (right side): drag/scroll vertically to zoom the price scale.
  wireAxisGesture(els.yaxisEl, true, (delta) => {
    chart.yZoom = clamp(chart.yZoom * Math.exp(delta * 0.006), Y_ZOOM_MIN, Y_ZOOM_MAX);
    drawChart(chart);
  });

  // Time axis (bottom): drag/scroll horizontally to zoom the time scale —
  // this is the direct replacement for the old +/- buttons.
  wireAxisGesture(els.xaxisEl, false, (delta) => {
    chart.windowSize = clamp(chart.windowSize + delta * 0.15, PX_PER_POINT_MIN, PX_PER_POINT_MAX);
    drawChart(chart);
  });

  container.innerHTML = '';
  container.appendChild(node);
  chart.els = els;
}

function renderFeaturedPair(coin, pairSpread) {
  const node = featuredPairTemplate.content.cloneNode(true);
  const section = node.querySelector('.featured-pair');

  const fundingEl = section.querySelector('.fp-funding');
  const entryEl = section.querySelector('.fp-entry');
  const exitEl = section.querySelector('.fp-exit');
  const pairContainer = section.querySelector('.featured-pair__pair');
  const liveSlot = section.querySelector('.chart-slot--live');
  const historySlot = section.querySelector('.chart-slot--history');

  // pairSpread is the PINNED pair (fixed when the page was opened) — not
  // necessarily coin.spread, which can drift to a different "best" pair on
  // every background rescan. We still pull fresh bid/ask/last for this
  // exact pair from the latest coin.tickers, just not a different pair.
  const spread = pairSpread || coin.spread;
  const buyTicker = coin.tickers.find((t) => t.exchange === spread.buyExchange);
  const sellTicker = coin.tickers.find((t) => t.exchange === spread.sellExchange);

  const pairNode = pairCardTemplate.content.cloneNode(true);
  const pairCardEl = pairNode.querySelector('.pair-card');
  pairCardEl.querySelector('.pair-card__spread')?.remove(); // already shown as "Спред входа" above
  fillPairExchanges(pairCardEl, { buyExchange: spread.buyExchange, buyTicker, sellExchange: spread.sellExchange, sellTicker });
  pairContainer.appendChild(pairNode);

  // Entry/exit are always shown as green — they represent your potential
  // profit, and we only ever surface pairs where entry is positive.
  entryEl.textContent = `${spread.spreadPct.toFixed(2)}%`;

  // buyTicker/sellTicker can be momentarily missing if that exchange
  // failed on the latest background rescan (rate limit, timeout) — the
  // pinned pair itself is still valid, just this one refresh didn't have
  // fresh numbers for it. Don't let that crash the whole detail page.
  const exitPct = buyTicker && sellTicker && sellTicker.ask
    ? ((buyTicker.bid - sellTicker.ask) / sellTicker.ask) * 100
    : null;
  exitEl.textContent = exitPct === null ? '—' : `${exitPct.toFixed(2)}%`;

  // Funding: shown for the short/sell side, since that's the leg where you
  // either receive or pay funding while the position stays open. Green if
  // it's money coming to you, red if it's money going out.
  const fundingPct = sellTicker?.fundingRatePct;
  fundingEl.textContent = fmtSignedPct(fundingPct);
  if (fundingPct !== null && fundingPct !== undefined) {
    fundingEl.classList.add(fundingPct < 0 ? 'is-red' : 'is-green');
  }

  buildChartEls(liveSlot, live, 'Статус: Онлайн', 'Обновляется раз в секунду. Листай график пальцем влево — увидишь более раннюю часть, − / + меняют масштаб.');
  buildChartEls(historySlot, history, 'История', 'Свечи с самих бирж, загружено один раз при открытии. Не обновляется. Листай и масштабируй так же.');

  statEls = { fundingEl, entryEl, exitEl, pairCard: pairCardEl };

  return node;
}

let statEls = null; // {fundingEl, entryEl, exitEl, pairCard} — the bits of the page that live above both charts, refreshed by the live tick

const CHART_H = 110;
const CHART_PAD = 8;
const PX_PER_POINT_MIN = 4;
const PX_PER_POINT_MAX = 40;
const Y_ZOOM_MIN = 0.3;
const Y_ZOOM_MAX = 5;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Drag-or-scroll gesture on an axis strip, like a real exchange chart:
// grabbing the price labels and dragging (or scrolling over them) rescales
// vertically; grabbing the time labels does the same horizontally. Works
// with touch (pointer events) and mouse wheel alike.
function wireAxisGesture(el, isY, onZoomDelta) {
  let dragging = false;
  let lastPos = 0;
  const getPos = (e) => (isY ? e.clientY : e.clientX);

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastPos = getPos(e);
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pos = getPos(e);
    const rawDelta = pos - lastPos;
    lastPos = pos;
    if (rawDelta === 0) return;
    // Natural feel: on the price axis, dragging UP zooms in; on the time
    // axis, dragging RIGHT zooms in.
    onZoomDelta(isY ? -rawDelta : rawDelta);
  });
  const stopDrag = () => {
    dragging = false;
  };
  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
  el.addEventListener('pointerleave', stopDrag);

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      onZoomDelta(-e.deltaY);
    },
    { passive: false }
  );
}

// Builds a smooth "wave" curve through the points (quadratic Bézier
// through each segment's midpoint) instead of straight zig-zag segments —
// reads as a proper price curve rather than a jagged/pointy line.
function smoothPath(coords) {
  if (coords.length < 2) return '';
  let d = `M ${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[i + 1];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    d += ` Q ${x0.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const [lx, ly] = coords[coords.length - 1];
  d += ` L ${lx.toFixed(1)},${ly.toFixed(1)}`;
  return d;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Generic drawer used by BOTH charts — takes a { els, points, windowSize }
// object (windowSize here doubles as "pixels per point", i.e. zoom level)
// and paints it. The SVG is drawn at its full real content width inside a
// horizontally-scrollable container, so with more points than fit on
// screen the person can scroll left to see older data — zoom (+/−)
// controls how many pixels each point takes up, scrolling covers the rest.
//
// Plots the two exchanges' actual LAST prices: short exchange (red) always
// ends up drawn above long exchange (green) on a shared scale, because
// that's structurally what a spread is — the short side is the more
// expensive one. No need to force it, real prices do that on their own.
function drawChart(chart) {
  const els = chart.els;
  if (!els) return;
  const points = chart.points;
  if (points.length < 1) return;

  const pxPerPoint = chart.windowSize; // "px per point" — horizontal zoom
  const rawChartW = Math.max(1, (points.length - 1)) * pxPerPoint || 1;

  const allValues = points.flatMap((p) => [p.longPrice, p.shortPrice]);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const center = (rawMin + rawMax) / 2;
  // yZoom > 1 shrinks the effective range around the center (taller,
  // "zoomed in" candles); yZoom < 1 widens it (flatter, "zoomed out").
  // The fallback half-range keeps a perfectly flat series from collapsing
  // to a zero-height, undividable range.
  const rawHalfRange = (rawMax - rawMin) / 2 || Math.abs(center) * 0.0005 || 1;
  const halfRange = rawHalfRange / (chart.yZoom || 1);
  const min = center - halfRange;
  const max = center + halfRange;
  const range = max - min || 1;

  const yFor = (v) => CHART_H - CHART_PAD - ((v - min) / range) * (CHART_H - CHART_PAD * 2);
  const xFor = (i) => i * pxPerPoint;

  const svgEl = els.entryLineEl.ownerSVGElement;
  const scrollEl = svgEl.parentElement; // .live-chart-scroll
  // Never render narrower than the visible box — otherwise a zoomed-out
  // chart (little content) just shrinks into a small block instead of
  // filling the available width. Only once there's genuinely more content
  // than fits does it become wider than the box (and thus scrollable).
  const chartW = Math.max(rawChartW, scrollEl.clientWidth || 0);
  svgEl.setAttribute('viewBox', `0 0 ${chartW} ${CHART_H}`);
  svgEl.style.width = `${chartW}px`;

  const longCoords = points.map((p, i) => [xFor(i), yFor(p.longPrice)]);
  const shortCoords = points.map((p, i) => [xFor(i), yFor(p.shortPrice)]);

  els.entryLineEl.setAttribute('d', points.length === 1
    ? `M 0,${longCoords[0][1].toFixed(1)} L ${chartW},${longCoords[0][1].toFixed(1)}`
    : smoothPath(longCoords));
  els.exitLineEl.setAttribute('d', points.length === 1
    ? `M 0,${shortCoords[0][1].toFixed(1)} L ${chartW},${shortCoords[0][1].toFixed(1)}`
    : smoothPath(shortCoords));

  // Dashed line + value badge at the CURRENT (rightmost/latest) point of
  // each series, extending to the right edge of the full-width chart.
  const lastLong = longCoords[longCoords.length - 1];
  const lastShort = shortCoords[shortCoords.length - 1];

  els.entryDashEl.setAttribute('x1', lastLong[0]);
  els.entryDashEl.setAttribute('y1', lastLong[1]);
  els.entryDashEl.setAttribute('x2', chartW);
  els.entryDashEl.setAttribute('y2', lastLong[1]);
  els.exitDashEl.setAttribute('x1', lastShort[0]);
  els.exitDashEl.setAttribute('y1', lastShort[1]);
  els.exitDashEl.setAttribute('x2', chartW);
  els.exitDashEl.setAttribute('y2', lastShort[1]);

  els.entryBadgeEl.textContent = fmtChartPrice(points[points.length - 1].longPrice);
  els.exitBadgeEl.textContent = fmtChartPrice(points[points.length - 1].shortPrice);
  els.entryBadgeEl.parentElement.style.top = `${(lastLong[1] / CHART_H) * 100}%`;
  els.exitBadgeEl.parentElement.style.top = `${(lastShort[1] / CHART_H) * 100}%`;

  // Grid + y-axis labels: fixed to the visible viewport (not the scrolling
  // content), 3 horizontal rows spanning the current min/max.
  els.gridEl.innerHTML = '';
  els.yaxisEl.innerHTML = '';
  const GRID_ROWS = 3;
  for (let i = 0; i <= GRID_ROWS; i++) {
    const y = (i / GRID_ROWS) * CHART_H;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0);
    line.setAttribute('y1', y);
    line.setAttribute('x2', chartW);
    line.setAttribute('y2', y);
    els.gridEl.appendChild(line);

    const value = max - (i / GRID_ROWS) * range;
    const label = document.createElement('span');
    label.className = 'live-chart-yaxis__val';
    label.style.top = `${(y / CHART_H) * 100}%`;
    label.textContent = fmtChartPrice(value);
    els.yaxisEl.appendChild(label);
  }

  // Time axis: when the loaded data started, and right now.
  if (points[0].ts) els.xaxisStartEl.textContent = fmtClock(points[0].ts);
  els.xaxisNowEl.textContent = fmtClock(Date.now());

  // Keep the view snapped to the latest data (right edge) after every
  // redraw — matches how real exchange charts behave. The person can still
  // scroll left manually to look at older points between redraws.
  scrollEl.scrollLeft = scrollEl.scrollWidth;
}

async function tickLiveFeatured(spread) {
  if (!live.els || !statEls) return;
  try {
    const params = new URLSearchParams({
      buyExchange: spread.buyExchange,
      buyRawSymbol: spread.buyRawSymbol,
      sellExchange: spread.sellExchange,
      sellRawSymbol: spread.sellRawSymbol,
      _: Date.now(), // cache-buster — same query string every second would otherwise risk a cached (stale) response
    });
    const res = await fetch(`/api/pair-tick?${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'tick failed');
    if (!live.els || !statEls) return; // page was closed while the request was in flight

    statEls.entryEl.textContent = `${data.entrySpreadPct.toFixed(2)}%`;
    statEls.exitEl.textContent = `${data.exitSpreadPct.toFixed(2)}%`;

    const [buyPanel, sellPanel] = statEls.pairCard.querySelectorAll('.exchange');
    buyPanel.querySelector('.v-bid').textContent = fmtPrice(data.buyTicker.bid);
    buyPanel.querySelector('.v-ask').textContent = fmtPrice(data.buyTicker.ask);
    buyPanel.querySelector('.v-last').textContent = fmtPrice(data.buyTicker.last);
    sellPanel.querySelector('.v-bid').textContent = fmtPrice(data.sellTicker.bid);
    sellPanel.querySelector('.v-ask').textContent = fmtPrice(data.sellTicker.ask);
    sellPanel.querySelector('.v-last').textContent = fmtPrice(data.sellTicker.last);

    const fundingPct = data.sellTicker.fundingRatePct;
    statEls.fundingEl.textContent = fmtSignedPct(fundingPct);
    statEls.fundingEl.classList.remove('is-green', 'is-red');
    if (fundingPct !== null && fundingPct !== undefined) {
      statEls.fundingEl.classList.add(fundingPct < 0 ? 'is-red' : 'is-green');
    }

    live.points.push({ longPrice: data.buyTicker.last, shortPrice: data.sellTicker.last, ts: data.ts || Date.now() });
    if (live.points.length > MAX_LIVE_POINTS) live.points.shift();
    drawChart(live);

    live.els.statusEl.classList.remove('is-paused');
    live.els.statusEl.querySelector('.live-chart-status__text').textContent = 'Статус: Онлайн';
  } catch (err) {
    console.error('live tick failed', err);
    if (live.els) {
      live.els.statusEl.classList.add('is-paused');
      live.els.statusEl.querySelector('.live-chart-status__text').textContent = 'Статус: Офлайн';
    }
  }
}

function startLiveTick(spread) {
  const key = `${spread.buyExchange}|${spread.buyRawSymbol}|${spread.sellExchange}|${spread.sellRawSymbol}`;
  if (live.key === key && live.timer) return; // already tracking this exact pair — don't reset the chart
  if (live.timer) clearInterval(live.timer);
  live.key = key;
  live.points = [];
  const tick = () => tickLiveFeatured(spread);
  tick();
  live.timer = setInterval(tick, 1000);
}

function stopLiveTick() {
  if (live.timer) clearInterval(live.timer);
  live = { key: null, timer: null, points: [], windowSize: live.windowSize, yZoom: live.yZoom, els: null };
}

// Loads the "История спредов" chart exactly ONCE per opened pair — no
// polling, no auto-refresh, just whatever the exchanges' own candles say.
async function loadHistoryChart(spread) {
  const key = `${spread.buyExchange}|${spread.buyRawSymbol}|${spread.sellExchange}|${spread.sellRawSymbol}`;
  if (history.key === key) {
    if (history.els) drawChart(history); // already loaded — just repaint onto the (possibly rebuilt) DOM
    return;
  }
  history.key = key;
  history.points = [];

  try {
    const params = new URLSearchParams({
      buyExchange: spread.buyExchange,
      buyRawSymbol: spread.buyRawSymbol,
      sellExchange: spread.sellExchange,
      sellRawSymbol: spread.sellRawSymbol,
      minutes: HISTORY_MINUTES,
    });
    const res = await fetch(`/api/pair-history?${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (history.key !== key) return; // page moved on while this was loading

    if (!data.ok || !data.history?.length) {
      if (history.els) {
        history.els.statusEl.classList.add('is-paused');
        history.els.statusEl.querySelector('.live-chart-status__text').textContent = 'История недоступна для этой пары';
      }
      return;
    }

    history.points = data.history;
    if (history.els) drawChart(history);
  } catch (err) {
    console.error('pair-history failed', err);
    if (history.key === key && history.els) {
      history.els.statusEl.classList.add('is-paused');
      history.els.statusEl.querySelector('.live-chart-status__text').textContent = 'Не удалось загрузить историю';
    }
  }
}

function stopCharts() {
  stopLiveTick();
  history = { key: null, points: [], windowSize: history.windowSize, yZoom: history.yZoom, els: null };
}

let pinnedSpread = null; // the exchange pair "locked in" for the live chart when a coin detail page is opened
let pinnedSymbol = null;

// ---------- Main render ----------
function render() {
  listEl.innerHTML = '';

  // A coin picked from the dropdown list takes priority: show every pair
  // for just that coin, sorted highest spread first.
  if (selectedCoinSymbol) {
    const coin = lastData.find((c) => c.symbol === selectedCoinSymbol);
    if (!coin) {
      stopCharts();
      selectedCoinSymbol = null;
      pinnedSymbol = null;
      pinnedSpread = null;
      render();
      return;
    }

    // Pin the pair being tracked ONLY when first opening this coin's page.
    // Background rescans (autorefresh) can find a marginally different
    // "best" pair for the same coin — without this, that would silently
    // swap which two exchanges the charts follow and reset them, exactly
    // the "resets on autorefresh" bug.
    const isNewCoin = pinnedSymbol !== selectedCoinSymbol;
    if (isNewCoin) {
      pinnedSymbol = selectedCoinSymbol;
      pinnedSpread = coin.spread;
    }

    const header = document.createElement('div');
    header.className = 'coin-detail__header';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'coin-detail__back';
    backBtn.textContent = '← Назад';
    backBtn.addEventListener('click', () => {
      stopCharts();
      selectedCoinSymbol = null;
      pinnedSymbol = null;
      pinnedSpread = null;
      render();
    });
    const title = document.createElement('div');
    title.className = 'coin-detail__title';
    title.textContent = coin.symbol;
    header.appendChild(backBtn);
    header.appendChild(title);
    listEl.appendChild(header);

    try {
      listEl.appendChild(renderFeaturedPair(coin, pinnedSpread));
      startLiveTick(pinnedSpread);
      // Fires the one-time history fetch on first open; on later re-renders
      // (autorefresh rebuilding the DOM) it just repaints already-loaded
      // history onto the fresh SVG node instead of re-fetching.
      loadHistoryChart(pinnedSpread);
    } catch (err) {
      // Anything unexpected here (e.g. a ticker briefly missing after a
      // rescan) should show up as a visible, debuggable message — not a
      // silently blank chart.
      console.error('Failed to render coin detail page:', err);
      const errorBox = document.createElement('div');
      errorBox.className = 'empty-state';
      errorBox.textContent = 'Не удалось отрисовать графики для этой монеты. Попробуй обновить.';
      listEl.appendChild(errorBox);
    }

    listEl.appendChild(renderCoinGroup(coin));
    return;
  }

  stopCharts();

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
    const url = `/api/prices?minVolume=${encodeURIComponent(selectedVolume)}&pairMode=${encodeURIComponent(selectedPairMode)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Ошибка сервера');

    lastData = data.coins;
    lastThreshold = data.threshold;
    thresholdPill.textContent = `Порог алерта: ${data.threshold}%`;

    lastFetchAt = Date.now();
    updateFreshness();

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

  // Leaving the scan page also means leaving any open coin detail view —
  // stop both charts, no point ticking (or keeping stale history) in the background.
  if (page !== 'scan') stopCharts();

  // Pause the 8s autorefresh while off the scan page — no point polling
  // in the background — and resume (with a fresh countdown) on return.
  if (page !== 'scan' && autorefreshTimer) {
    clearInterval(autorefreshTimer);
    autorefreshTimer = null;
  } else if (page === 'scan' && autorefreshEnabled && !autorefreshTimer) {
    setAutorefresh(true);
  }

  // Returning to Scan: rebuild whatever should be showing (the coin detail
  // page if one was open, otherwise the normal list) with fresh chart
  // wiring — stopCharts() above nulls out the DOM refs, so the old nodes
  // left on screen would otherwise just sit there frozen.
  if (page === 'scan') render();
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

// ---------- Settings: pair-mode picker (all / futures-futures / spot-futures) ----------
function renderPairModePickerState() {
  pairModePickerValueEl.textContent = PAIR_MODE_LABELS[selectedPairMode];
  pairModePickerListEl.querySelectorAll('.pairmode-picker__item').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.mode === selectedPairMode);
  });
}

pairModePickerListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.pairmode-picker__item');
  if (!btn) return;
  selectedPairMode = btn.dataset.mode;
  localStorage.setItem('pairMode', selectedPairMode);
  renderPairModePickerState();
  pairModePickerEl.open = false;
  tg?.HapticFeedback?.impactOccurred('light');
  loadPrices();
});

// ---------- Freshness ticker (independent of autorefresh — shows how old the data is even when not auto-refreshing) ----------
const STALE_AFTER_SECONDS = 60;

function updateFreshness() {
  if (!lastFetchAt) {
    freshnessEl.textContent = '';
    freshnessEl.classList.remove('is-stale');
    return;
  }
  const seconds = Math.floor((Date.now() - lastFetchAt) / 1000);
  let label;
  if (seconds < 3) label = '🕒 обновлено только что';
  else if (seconds < 60) label = `🕒 обновлено ${seconds}с назад`;
  else {
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    label = `🕒 обновлено ${minutes}м ${rem}с назад`;
  }
  freshnessEl.textContent = label;
  freshnessEl.classList.toggle('is-stale', seconds >= STALE_AFTER_SECONDS);
}

// Runs always, on a 1s tick, independent of the autorefresh toggle — the
// point is to warn when data is going stale precisely BECAUSE autorefresh
// might be off.
setInterval(updateFreshness, 1000);

// ---------- Autorefresh toggle (off by default, refreshes every 8s when on) ----------
const autorefreshLabelEl = autorefreshToggleEl.querySelector('.autorefresh-toggle__label');

function updateAutorefreshLabel() {
  autorefreshLabelEl.textContent = autorefreshEnabled ? `Авто · ${autorefreshCountdown}с` : 'Авто 8с';
}

function tickAutorefresh() {
  autorefreshCountdown -= 1;
  if (autorefreshCountdown <= 0) {
    autorefreshCountdown = AUTOREFRESH_SECONDS;
    loadPrices({ silent: true });
  }
  updateAutorefreshLabel();
}

function setAutorefresh(enabled) {
  autorefreshEnabled = enabled;
  localStorage.setItem('autorefresh', String(enabled));
  autorefreshToggleEl.setAttribute('aria-pressed', String(enabled));

  if (autorefreshTimer) {
    clearInterval(autorefreshTimer);
    autorefreshTimer = null;
  }
  if (enabled) {
    autorefreshCountdown = AUTOREFRESH_SECONDS;
    autorefreshTimer = setInterval(tickAutorefresh, 1000);
  }
  updateAutorefreshLabel();
}

autorefreshToggleEl.addEventListener('click', () => {
  tg?.HapticFeedback?.impactOccurred('light');
  setAutorefresh(!autorefreshEnabled);
});

// ---------- Wiring ----------
refreshBtn.addEventListener('click', () => {
  // A manual refresh restarts the countdown too, so the next auto tick is
  // always a full 8s away from whatever the person just did — not a
  // leftover fraction of the previous cycle.
  if (autorefreshEnabled) {
    autorefreshCountdown = AUTOREFRESH_SECONDS;
    updateAutorefreshLabel();
  }
  loadPrices();
});
searchInput.addEventListener('input', () => {
  selectedCoinSymbol = null;
  render();
});

renderVolumePickerState();
renderPairModePickerState();
setAutorefresh(autorefreshEnabled); // restore saved preference, starts the timer if it was on
loadPrices();
