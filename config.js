require('dotenv').config();

module.exports = {
  // Порог спреда в %, при котором монета считается "интересной" и попадает в алерты.
  threshold: parseFloat(process.env.THRESHOLD_PERCENT || '4'),

  // Отсекаем монеты с суточным объёмом ниже этого значения (в USDT) на любой
  // из двух бирж. Без этого в топе будут в основном мёртвые пары с почти
  // нулевой ликвидностью, где "спред" — просто старые/фейковые котировки,
  // а не реальная возможность для арбитража.
  minVolumeUsdt: parseFloat(process.env.MIN_VOLUME_USDT || '20000'),

  // Если "лучший" спред по монете превышает этот %, считаем это не реальным
  // арбитражем, а совпадением тикеров у двух разных активов (частая история
  // с мем-монетами — тикер не уникален глобально) или битыми котировками.
  // Такие монеты просто выкидываются из результатов, а не показываются.
  maxSaneSpreadPercent: parseFloat(process.env.MAX_SANE_SPREAD_PERCENT || '50'),

  autoRefresh: process.env.AUTO_REFRESH === 'true',
  autoRefreshIntervalSec: parseInt(process.env.AUTO_REFRESH_INTERVAL_SEC || '20', 10),
};
