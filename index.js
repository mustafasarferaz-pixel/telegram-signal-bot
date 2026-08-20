// ======================================================
// STRICT CRYPTO TELEGRAM SIGNAL BOT
// ======================================================
// Command:
// signal
// /signal
//
// Features:
// - Crypto only
// - Automatically chooses the best crypto
// - Automatically chooses 1m / 5m / 15m
// - Strict multi-confirmation analysis
// - 90% minimum confidence
// - 95% = very strong setup
// - If confirmation is weak -> WAIT
// - No Martingale
// - No Quotex account connection
// - Uses public Kraken market data
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

const TELEGRAM_URL =
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ------------------------------------------------------
// SETTINGS
// ------------------------------------------------------

const TIMEFRAMES = [1, 5, 15];

// Crypto pairs available through Kraken public API.
// XBTUSD = BTC/USD
const COINS = [
  "XBTUSD",
  "ETHUSD",
  "SOLUSD",
  "XRPUSD",
  "ADAUSD",
  "DOGEUSD",
  "LINKUSD",
  "AVAXUSD"
];

const CANDLE_LIMIT = 250;

// STRICT FILTER
const MIN_CONFIDENCE = 90;
const STRONG_CONFIDENCE = 95;

// ------------------------------------------------------
// TELEGRAM
// ------------------------------------------------------

async function telegram(method, body = {}) {

  const response = await fetch(
    `${TELEGRAM_URL}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}`
    );
  }

  return response.json();
}

async function sendMessage(chatId, text) {

  return telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text
    }
  );
}

// ------------------------------------------------------
// MARKET DATA
// ------------------------------------------------------

async function getCandles(pair, interval) {

  const url =
    `https://api.kraken.com/0/public/OHLC` +
    `?pair=${encodeURIComponent(pair)}` +
    `&interval=${interval}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Market HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (
    data.error &&
    data.error.length > 0
  ) {
    throw new Error(
      data.error.join(", ")
    );
  }

  const keys =
    Object.keys(data.result || {})
      .filter(
        key => key !== "last"
      );

  if (keys.length === 0) {
    throw new Error(
      "No market data"
    );
  }

  const rows =
    data.result[keys[0]];

  if (
    !Array.isArray(rows) ||
    rows.length < 80
  ) {
    throw new Error(
      "Not enough candles"
    );
  }

  return rows
    .slice(-CANDLE_LIMIT)
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6])
    }));
}

// ------------------------------------------------------
// EMA
// ------------------------------------------------------

function EMA(values, period) {

  if (
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      (
        values[i] - result
      ) *
      multiplier +
      result;
  }

  return result;
}

// ------------------------------------------------------
// RSI
// ------------------------------------------------------

function RSI(
  values,
  period = 14
) {

  if (
    values.length <
    period + 2
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

// ------------------------------------------------------
// MACD
// ------------------------------------------------------

function MACD(values) {

  const ema12 =
    EMA(values, 12);

  const ema26 =
    EMA(values, 26);

  if (
    ema12 === null ||
    ema26 === null
  ) {
    return null;
  }

  return ema12 - ema26;
}

// ------------------------------------------------------
// ATR
// ------------------------------------------------------

function ATR(
  candles,
  period = 14
) {

  if (
    candles.length <
    period + 2
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );

    trs.push(tr);
  }

  const recent =
    trs.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) / recent.length
  );
}

// ------------------------------------------------------
// ADX
// ------------------------------------------------------

function ADX(
  candles,
  period = 14
) {

  if (
    candles.length <
    period * 2 + 5
  ) {
    return null;
  }

  let trs = [];
  let plusDM = [];
  let minusDM = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;

    plusDM.push(
      upMove > downMove &&
      upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove &&
      downMove > 0
        ? downMove
        : 0
    );

    trs.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      )
    );
  }

  const tr =
    trs.slice(-period)
      .reduce(
        (a, b) => a + b,
        0
      );

  const plus =
    plusDM
      .slice(-period)
      .reduce(
        (a, b) => a + b,
        0
      );

  const minus =
    minusDM
      .slice(-period)
      .reduce(
        (a, b) => a + b,
        0
      );

  if (tr === 0) {
    return 0;
  }

  const plusDI =
    100 * plus / tr;

  const minusDI =
    100 * minus / tr;

  const denominator =
    plusDI + minusDI;

  if (denominator === 0) {
    return 0;
  }

  return (
    100 *
    Math.abs(
      plusDI - minusDI
    ) /
    denominator
  );
}

// ------------------------------------------------------
// CANDLE STRUCTURE
// ------------------------------------------------------

function candleDirection(
  candle
) {

  if (
    candle.close >
    candle.open
  ) {
    return "UP";
  }

  if (
    candle.close <
    candle.open
  ) {
    return "DOWN";
  }

  return "FLAT";
}

// ------------------------------------------------------
// ANALYZE ONE TIMEFRAME
// ------------------------------------------------------

function analyzeTimeframe(
  candles
) {

  // IMPORTANT:
  // Last candle may still be forming.
  // Therefore we do NOT use it.
  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 80
  ) {
    return null;
  }

  const closes =
    closed.map(
      c => c.close
    );

  const last =
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const ema9 =
    EMA(closes, 9);

  const ema21 =
    EMA(closes, 21);

  const ema50 =
    EMA(closes, 50);

  const rsi =
    RSI(closes, 14);

  const macd =
    MACD(closes);

  const atr =
    ATR(closed, 14);

  const adx =
    ADX(closed, 14);

  if (
    ema9 === null ||
    ema21 === null ||
    ema50 === null ||
    rsi === null ||
    macd === null ||
    atr === null ||
    adx === null
  ) {
    return null;
  }

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  // ----------------------------------------------------
  // TREND
  // ----------------------------------------------------

  if (
    ema9 > ema21 &&
    ema21 > ema50
  ) {

    callScore += 20;

    reasons.push(
      "EMA trend bullish"
    );
  }

  if (
    ema9 < ema21 &&
    ema21 < ema50
  ) {

    putScore += 20;

    reasons.push(
      "EMA trend bearish"
    );
  }

  // ----------------------------------------------------
  // PRICE POSITION
  // ----------------------------------------------------

  if (
    last.close > ema9 &&
    last.close > ema21
  ) {

    callScore += 15;
  }

  if (
    last.close < ema9 &&
    last.close < ema21
  ) {

    putScore += 15;
  }

  // ----------------------------------------------------
  // RSI
  // ----------------------------------------------------

  if (
    rsi >= 52 &&
    rsi <= 68
  ) {

    callScore += 15;
  }

  if (
    rsi <= 48 &&
    rsi >= 32
  ) {

    putScore += 15;
  }

  // Avoid extreme RSI
  if (
    rsi > 72 ||
    rsi < 28
  ) {

    callScore -= 10;
    putScore -= 10;
  }

  // ----------------------------------------------------
  // MACD
  // ----------------------------------------------------

  if (macd > 0) {
    callScore += 15;
  }

  if (macd < 0) {
    putScore += 15;
  }

  // ----------------------------------------------------
  // ADX TREND STRENGTH
  // ----------------------------------------------------

  if (adx >= 20) {

    if (
      callScore >
      putScore
    ) {

      callScore += 15;
    }

    if (
      putScore >
      callScore
    ) {

      putScore += 15;
    }
  }

  // ----------------------------------------------------
  // CANDLE CONFIRMATION
  // ----------------------------------------------------

  const direction =
    candleDirection(last);

  if (
    direction === "UP"
  ) {

    callScore += 10;
  }

  if (
    direction === "DOWN"
  ) {

    putScore += 10;
  }

  // ----------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------

  if (
    last.close >
    previous.close
  ) {

    callScore += 10;
  }

  if (
    last.close <
    previous.close
  ) {

    putScore += 10;
  }

  // ----------------------------------------------------
  // VOLATILITY FILTER
  // ----------------------------------------------------

  const volatility =
    atr / last.close;

  // If market is almost completely dead,
  // do not force a trade.
  if (
    volatility < 0.00005
  ) {

    return {
      signal: "WAIT",
      confidence: 0,
      reason:
        "Market volatility too low"
    };
  }

  const best =
    Math.max(
      callScore,
      putScore
    );

  let signal = "WAIT";

  if (
    callScore >
      putScore &&
    callScore >=
      MIN_CONFIDENCE
  ) {

    signal = "CALL";
  }

  if (
    putScore >
      callScore &&
    putScore >=
      MIN_CONFIDENCE
  ) {

    signal = "PUT";
  }

  return {
    signal,
    confidence:
      Math.max(
        0,
        Math.min(
          100,
          best
        )
      ),
    callScore,
    putScore,
    rsi,
    adx,
    atr,
    price:
      last.close,
    candle:
      direction,
    reasons
  };
}

// ------------------------------------------------------
// MULTI-TIMEFRAME CONFIRMATION
// ------------------------------------------------------

async function analyzeCoin(
  coin
) {

  const analyses = {};

  for (
    const timeframe of TIMEFRAMES
  ) {

    try {

      const candles =
        await getCandles(
          coin,
          timeframe
        );

      analyses[timeframe] =
        analyzeTimeframe(
          candles
        );

    } catch (error) {

      console.error(
        `${coin} ${timeframe}m:`,
        error.message
      );

      analyses[timeframe] =
        null;
    }
  }

  const a1 =
    analyses[1];

  const a5 =
    analyses[5];

  const a15 =
    analyses[15];

  // ----------------------------------------------------
  // ALL THREE TIMEFRAMES MUST AGREE
  // ----------------------------------------------------

  if (
    !a1 ||
    !a5 ||
    !a15
  ) {

    return {
      coin,
      signal: "WAIT",
      confidence: 0,
      reason:
        "Not enough timeframe data"
    };
  }

  const signals = [
    a1.signal,
    a5.signal,
    a15.signal
  ];

  const callCount =
    signals.filter(
      x => x === "CALL"
    ).length;

  const putCount =
    signals.filter(
      x => x === "PUT"
    ).length;

  // STRICT:
  // At least 1m + 5m + 15m need same direction.
  if (
    callCount !== 3 &&
    putCount !== 3
  ) {

    return {
      coin,
      signal: "WAIT",
      confidence: 0,
      reason:
        "Timeframes do not fully agree"
    };
  }

  const signal =
    callCount === 3
      ? "CALL"
      : "PUT";

  // ----------------------------------------------------
  // COMBINE CONFIDENCE
  // ----------------------------------------------------

  const average =
    (
      a1.confidence +
      a5.confidence +
      a15.confidence
    ) / 3;

  // Additional bonus for complete agreement
  const agreementBonus = 5;

  const confidence =
    Math.min(
      100,
      Math.round(
        average +
        agreementBonus
      )
    );

  if (
    confidence <
    MIN_CONFIDENCE
  ) {

    return {
      coin,
      signal: "WAIT",
      confidence,
      reason:
        "Overall confidence below 90%"
    };
  }

  // ----------------------------------------------------
  // CHOOSE BEST TIMEFRAME
  // ----------------------------------------------------

  const candidates = [
    {
      timeframe: 1,
      confidence:
        a1.confidence
    },
    {
      timeframe: 5,
      confidence:
        a5.confidence
    },
    {
      timeframe: 15,
      confidence:
        a15.confidence
    }
  ];

  candidates.sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  const bestTimeframe =
    candidates[0].timeframe;

  return {
    coin,
    signal,
    confidence,
    timeframe:
      bestTimeframe,
    analyses: {
      1: a1,
      5: a5,
      15: a15
    },
    reason:
      "All 1m / 5m / 15m timeframes agree"
  };
}

// ------------------------------------------------------
// FIND BEST CRYPTO
// ------------------------------------------------------

async function findBestSignal() {

  const results = [];

  for (
    const coin of COINS
  ) {

    try {

      const result =
        await analyzeCoin(
          coin
        );

      results.push(result);

    } catch (error) {

      console.error(
        `${coin}:`,
        error.message
      );
    }
  }

  // Only real signals
  const valid =
    results.filter(
      result =>
        result.signal !==
        "WAIT" &&
        result.confidence >=
        MIN_CONFIDENCE
    );

  if (
    valid.length === 0
  ) {

    return {
      signal: "WAIT",
      confidence: 0,
      reason:
        "No crypto has enough confirmation"
    };
  }

  valid.sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  return valid[0];
}

// ------------------------------------------------------
// FORMAT SIGNAL
// ------------------------------------------------------

function formatSignal(
  result
) {

  if (
    result.signal ===
    "WAIT"
  ) {

    return (
      "🟡 WAIT — NO TRADE\n\n" +

      "Crypto: ALL\n" +

      "Timeframes checked:\n" +
      "1m • 5m • 15m\n\n" +

      "Confidence: " +
      `${result.confidence || 0}%\n\n` +

      "❌ " +
      `${result.reason}\n\n` +

      "هی
