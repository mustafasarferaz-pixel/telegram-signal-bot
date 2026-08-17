// ============================================================
// QUOTEX-STYLE TELEGRAM SIGNAL ENGINE
// CALL = UP
// PUT  = DOWN
// WAIT = NO TRADE
//
// IMPORTANT:
// - Analysis uses public Binance OHLC data.
// - No real-money trading.
// - No Martingale.
// - No connection to Quotex account.
// - Closed candles only.
// - If data/confirmation is unreliable -> WAIT.
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

const BINANCE_URL = "https://api.binance.com/api/v3/klines";

const DEFAULT_THRESHOLD = 90;
const MIN_THRESHOLD = 85;
const MAX_THRESHOLD = 95;

const userSettings = new Map();
const signalHistory = [];
const lastSignals = new Map();

let telegramOffset = 0;

// ------------------------------------------------------------
// TELEGRAM
// ------------------------------------------------------------

async function telegram(method, body = {}) {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }

  return response.json();
}

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

// ------------------------------------------------------------
// MARKET DATA
// ------------------------------------------------------------

const TIMEFRAMES = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h"
};

async function getCandles(symbol, interval, limit = 220) {
  if (!TIMEFRAMES[interval]) {
    throw new Error("Unsupported timeframe");
  }

  const url =
    `${BINANCE_URL}?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&limit=${limit}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Market data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length < 100) {
    throw new Error("Insufficient market data");
  }

  const now = Date.now();

  const candles = data.map((c) => ({
    openTime: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
    closeTime: Number(c[6])
  }));

  for (const c of candles) {
    if (
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low ||
      c.open <= 0 ||
      c.close <= 0
    ) {
      throw new Error("Malformed market data");
    }
  }

  // Remove the currently forming candle.
  const closed = candles.filter((c) => c.closeTime < now);

  if (closed.length < 100) {
    throw new Error("Not enough closed candles");
  }

  const latest = closed[closed.length - 1];

  // Data must be reasonably fresh.
  const age = now - latest.closeTime;

  if (age > 10 * 60 * 1000) {
    throw new Error("Market data is stale");
  }

  return closed;
}

// ------------------------------------------------------------
// INDICATORS
// ------------------------------------------------------------

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result = 0;

  for (let i = 0; i < period; i++) {
    result += values[i];
  }

  result /= period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const result = [];

  let current = 0;

  for (let i = 0; i < period; i++) {
    current += values[i];
  }

  current /= period;
  result.push(current);

  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    result.push(current);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );

    trs.push(tr);
  }

  let value = 0;

  for (let i = 0; i < period; i++) {
    value += trs[i];
  }

  value /= period;

  for (let i = period; i < trs.length; i++) {
    value = ((value * (period - 1)) + trs[i]) / period;
  }

  return value;
}

function bollinger(candles, period = 20, multiplier = 2) {
  if (candles.length < period) return null;

  const closes = candles
    .slice(-period)
    .map(c => c.close);

  const mean =
    closes.reduce((a, b) => a + b, 0) / period;

  let variance = 0;

  for (const value of closes) {
    variance += Math.pow(value - mean, 2);
  }

  variance /= period;

  const std = Math.sqrt(variance);

  return {
    middle: mean,
    upper: mean + multiplier * std,
    lower: mean - multiplier * std,
    width: (multiplier * 2 * std) / mean
  };
}

// ------------------------------------------------------------
// MARKET STRUCTURE
// ------------------------------------------------------------

function candleStructure(candles) {
  const c = candles[candles.length - 1];

  const range = c.high - c.low;

  if (range <= 0) {
    return {
      bullish: false,
      bearish: false,
      strong: false,
      reason: "Invalid candle range"
    };
  }

  const body = Math.abs(c.close - c.open);
  const bodyRatio = body / range;

  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  const closePosition =
    (c.close - c.low) / range;

  const bullish =
    c.close > c.open &&
    bodyRatio >= 0.55 &&
    closePosition >= 0.70;

  const bearish =
    c.close < c.open &&
    bodyRatio >= 0.55 &&
    closePosition <= 0.30;

  const indecision = bodyRatio < 0.35;

  return {
    bullish,
    bearish,
    strong: !indecision,
    indecision,
    bodyRatio,
    upperWick,
    lowerWick,
    reason: bullish
      ? "Strong bullish candle structure"
      : bearish
        ? "Strong bearish candle structure"
        : "Weak/indecisive candle structure"
  };
}

function supportResistance(candles) {
  const recent = candles.slice(-40);

  let support = Infinity;
  let resistance = -Infinity;

  for (const c of recent) {
    if (c.low < support) support = c.low;
    if (c.high > resistance) resistance = c.high;
  }

  const price = candles[candles.length - 1].close;
  const range = resistance - support;

  if (!Number.isFinite(range) || range <= 0) {
    return null;
  }

  const distanceToResistance =
    (resistance - price) / price;

  const distanceToSupport =
    (price - support) / price;

  return {
    support,
    resistance,
    distanceToResistance,
    distanceToSupport,
    range
  };
}

// ------------------------------------------------------------
// MARKET REGIME
// ------------------------------------------------------------

function detectRegime(candles) {
  const closes = candles.map(c => c.close);

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e9 || !e21 || !e50) {
    return "unknown";
  }

  const spread =
    Math.abs(e9 - e21) / e21;

  const longSpread =
    Math.abs(e21 - e50) / e50;

  if (spread < 0.0003 && longSpread < 0.0007) {
    return "choppy";
  }

  if (e9 > e21 && e21 > e50) {
    return "trending_bullish";
  }

  if (e9 < e21 && e21 < e50) {
    return "trending_bearish";
  }

  return "ranging";
}

// ------------------------------------------------------------
// ANALYSIS
// ------------------------------------------------------------

async function analyze(symbol, timeframe, threshold) {
  try {
    const entry = await getCandles(symbol, timeframe);
    const higher = await getCandles(
      symbol,
      higherTimeframe(timeframe)
    );

    const closes = entry.map(c => c.close);
    const higherCloses = higher.map(c => c.close);

    const price = closes[closes.length - 1];

    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);

    const he9 = ema(higherCloses, 9);
    const he21 = ema(higherCloses, 21);
    const he50 = ema(higherCloses, 50);

    const currentRsi = rsi(closes, 14);
    const currentAtr = atr(entry, 14);
    const bb = bollinger(entry, 20, 2);

    const structure = candleStructure(entry);
    const sr = supportResistance(entry);

    const regime = detectRegime(entry);

    if (
      !e9 ||
      !e21 ||
      !e50 ||
      !he9 ||
      !he21 ||
      !he50 ||
      currentRsi === null ||
      !currentAtr ||
      !bb ||
      !sr
    ) {
      return waitResult(
        symbol,
        timeframe,
        "Insufficient indicator data"
      );
    }

    // --------------------------------------------------------
    // TREND
    // --------------------------------------------------------

    const bullishTrend =
      e9 > e21 &&
      e21 > e50 &&
      price > e9;

    const bearishTrend =
      e9 < e21 &&
      e21 < e50 &&
      price < e9;

    // --------------------------------------------------------
    // HIGHER TIMEFRAME
    // --------------------------------------------------------

    const higherBullish =
      he9 > he21 &&
      he21 > he50;

    const higherBearish =
      he9 < he21 &&
      he21 < he50;

    // --------------------------------------------------------
    // MOMENTUM
    // --------------------------------------------------------

    const bullishMomentum =
      currentRsi >= 55 &&
      currentRsi <= 72;

    const bearishMomentum =
      currentRsi <= 45 &&
      currentRsi >= 28;

    // Avoid extreme RSI chasing.
    const overextended =
      currentRsi > 75 ||
      currentRsi < 25;

    // --------------------------------------------------------
    // VOLATILITY
    // --------------------------------------------------------

    const atrPercent =
      currentAtr / price;

    const volatilityOK =
      atrPercent >= 0.0005 &&
      atrPercent <= 0.05 &&
      bb.width >= 0.001 &&
      bb.width <= 0.20;

    // --------------------------------------------------------
    // SUPPORT / RESISTANCE
    // --------------------------------------------------------

    const nearResistance =
      sr.distanceToResistance < 0.0025;

    const nearSupport =
      sr.distanceToSupport < 0.0025;

    const bullishLevelOK = !nearResistance;
    const bearishLevelOK = !nearSupport;

    // --------------------------------------------------------
    // CANDLE
    // --------------------------------------------------------

    const bullishCandle =
      structure.bullish &&
      !structure.indecision;

    const bearishCandle =
      structure.bearish &&
      !structure.indecision;

    // --------------------------------------------------------
    // REGIME
    // --------------------------------------------------------

    const bullishRegime =
      regime === "trending_bullish";

    const bearishRegime =
      regime === "trending_bearish";

    // --------------------------------------------------------
    // CONFIRMATION COUNTS
    // --------------------------------------------------------

    const bullishChecks = [
      bullishTrend,
      bullishMomentum,
      volatilityOK,
      bullishLevelOK,
      bullishCandle,
      bullishRegime,
      higherBullish,
      !overextended
    ];

    const bearishChecks = [
      bearishTrend,
      bearishMomentum,
      volatilityOK,
      bearishLevelOK,
      bearishCandle,
      bearishRegime,
      higherBearish,
      !overextended
    ];

    const bullScore =
      bullishChecks.filter(Boolean).length;

    const bearScore =
      bearishChecks.filter(Boolean).length;

    const confidenceBull =
      Math.round((bullScore / bullishChecks.length) * 100);

    const confidenceBear =
      Math.round((bearScore / bearishChecks.length) * 100);

    // --------------------------------------------------------
    // VERY STRICT FINAL RULE
    // --------------------------------------------------------

    let direction = "WAIT";
    let confidence = Math.max(
      confidenceBull,
      confidenceBear
    );

    let reason =
      "Critical confirmation is missing or conflicting.";

    // ALL 8 conditions must agree.
    if (
      bullScore === bullishChecks.length &&
      confidenceBull >= threshold
    ) {
      direction = "CALL";
      confidence = Math.min(confidenceBull, 95);

      reason =
        "Strong bullish trend + momentum + volatility + " +
        "market structure + candle + higher timeframe confirmation.";
    } else if (
      bearScore === bearishChecks.length &&
      confidenceBear >= threshold
    ) {
      direction = "PUT";
      confidence = Math.min(confidenceBear, 95);

      reason =
        "Strong bearish trend + momentum + volatility + " +
        "market structure + candle + higher timeframe confirmation.";
    } else {
      direction = "WAIT";

      confidence = Math.min(confidence, 89);

      const conflicts = [];

      if (!volatilityOK) {
        conflicts.push("unsuitable volatility");
      }

      if (nearResistance) {
        conflicts.push("price near resistance");
      }

      if (nearSupport) {
        conflicts.push("price near support");
      }

      if (!bullishTrend && !bearishTrend) {
        conflicts.push("unclear trend");
      }

      if (!higherBullish && !higherBearish) {
        conflicts.push("higher timeframe unclear");
      }

      if (!bullishCandle && !bearishCandle) {
        conflicts.push("weak candle structure");
      }

      if (regime === "choppy" || regime === "ranging") {
        conflicts.push("market not trending");
      }

      if (conflicts.length > 0) {
        reason = conflicts.join(", ");
      }
    }

    // --------------------------------------------------------
    // DUPLICATE PROTECTION
    // --------------------------------------------------------

    const candleId =
      entry[entry.length - 1].openTime;

    const duplicateKey =
      `${symbol}:${timeframe}:${candleId}`;

    if (
      lastSignals.has(duplicateKey)
    ) {
      return waitResult(
        symbol,
        timeframe,
        "Duplicate signal blocked for this closed candle"
      );
    }

    // Only record CALL/PUT as signal.
    // WAIT does not block future candles.
    if (direction !== "WAIT") {
      lastSignals.set(
        duplicateKey,
        Date.now()
      );
    }

    // --------------------------------------------------------
    // HISTORY
    // --------------------------------------------------------

    signalHistory.push({
      asset: symbol,
      timeframe,
      direction,
      confidence,
      entryPrice: price,
      timestamp: new Date().toISOString(),
      expiry: suggestedExpiry(timeframe),
      result: direction === "WAIT" ? "WAIT" : "PENDING"
    });

    return {
      asset: symbol,
      timeframe,
      direction,
      confidence,
      price,
      signalTime: new Date().toISOString(),
      expiry: suggestedExpiry(timeframe),
      reason,
      regime,
      rsi: Number(currentRsi.toFixed(2))
    };

  } catch (error) {
    console.error("Analysis error:", error.message);

    return waitResult(
      symbol,
      timeframe,
      `Reliable market data unavailable: ${error.message}`
    );
  }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function higherTimeframe(tf) {
  const map = {
    "1m": "5m",
    "3m": "15m",
    "5m": "15m",
    "15m": "1h",
    "30m": "4h",
    "1h": "4h",
    "4h": "4h"
  };

  return map[tf] || "15m";
}

function suggestedExpiry(tf) {
  const map = {
    "1m": "1–2 minutes",
    "3m": "3–5 minutes",
    "5m": "5–10 minutes",
    "15m": "15–30 minutes",
    "30m": "30–60 minutes",
    "1h": "1–2 hours",
    "4h": "4–8 hours"
  };

  return map[tf] || "Use the selected timeframe";
}

function waitResult(asset, timeframe, reason) {
  return {
    asset,
    timeframe,
    direction: "WAIT",
    confidence: 0,
    price: null,
    signalTime: new Date().toISOString(),
    expiry: "NO TRADE",
    reason,
    regime: "unknown"
  };
}

function formatSignal(result) {
  if (result.direction === "WAIT") {
    return (
      `🟡 <b>WAIT — NO TRADE</b>\n\n` +
      `Asset: <b>${result.asset}</b>\n` +
      `Timeframe: <b>${result.timeframe}</b>\n` +
      `Confidence: <b>${result.confidence}%</b>\n\n` +
      `Reason:\n${result.reason}\n\n` +
      `⛔ شرایط تأیید کامل نیست.\n` +
      `هیچ معامله‌ای انجام نده.`
    );
  }

  const emoji =
    result.direction === "CALL" ? "🟢" : "🔴";

  const word =
    result.direction === "CALL"
      ? "UP / CALL"
      : "DOWN / PUT";

  return (
    `${emoji} <b>${word}</b>\n\n` +
    `Asset: <b>${result.asset}</b>\n` +
    `Timeframe: <b>${result.timeframe}</b>\n` +
    `Direction: <b>${result.direction}</b>\n` +
    `Confidence: <b>${result.confidence}%</b>\n` +
    `Entry price: <b>${result.price}</b>\n` +
    `Suggested expiry: <b>${result.expiry}</b>\n` +
    `Signal time: <b>${result.signalTime}</b>\n\n` +
    `Reason:\n${result.reason}\n\n` +
    `⚠️ Demo/Paper analysis only.\n` +
    `No guaranteed win. No Martingale.`
  );
}

// ------------------------------------------------------------
// COMMANDS
// ------------------------------------------------------------

async function handleMessage(message) {
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text === "/start") {
    await sendMessage(
      chatId,
      `🤖 <b>Quotex-Style Signal Engine</b>\n\n` +
      `CALL = UP\n` +
      `PUT = DOWN\n` +
      `WAIT = NO TRADE\n\n` +
      `این ربات فقط تحلیل و سیگنال می‌دهد.\n` +
      `به حساب واقعی Quotex وصل نمی‌شود.\n\n` +
      `Minimum confidence: <b>${getThreshold(chatId)}%</b>\n\n` +
      `برای شروع:\n` +
      `<code>/signal BTCUSDT 5m</code>`
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      `<b>Commands</b>\n\n` +
      `/signal BTCUSDT 5m\n` +
      `/threshold 90\n` +
      `/settings\n` +
      `/quality\n` +
      `/stats\n` +
      `/history\n` +
      `/help`
    );
    return;
  }

  if (text === "/settings") {
    await sendMessage(
      chatId,
      `⚙️ <b>Settings</b>\n\n` +
      `Minimum confidence: <b>${getThreshold(chatId)}%</b>\n` +
      `Allowed range: 85–95%\n\n` +
      `Example:\n` +
      `<code>/threshold 95</code>`
    );
    return;
  }

  if (text.startsWith("/threshold")) {
    const parts = text.split(/\s+/);
    const value = Number(parts[1]);

    if (
      !Number.isFinite(value) ||
      value < MIN_THRESHOLD ||
      value > MAX_THRESHOLD
    ) {
      await sendMessage(
        chatId,
        `❌ Threshold باید بین <b>85</b> تا <b>95</b> باشد.\n\n` +
        `مثال:\n<code>/threshold 90</code>`
      );
      return;
    }

    userSettings.set(chatId, value);

    await sendMessage(
      chatId,
      `✅ Minimum confidence روی <b>${value}%</b> تنظیم شد.\n\n` +
      `سیگنال کمتر می‌شود، اما فیلتر سخت‌گیرتر خواهد بود.`
    );

    return;
  }

  if (text === "/quality") {
    await sendMessage(
      chatId,
      `🛡️ <b>ACTIVE QUALITY FILTERS</b>\n\n` +
      `✅ Closed candles only\n` +
      `✅ EMA 9 / 21 / 50\n` +
      `✅ Market structure\n` +
      `✅ RSI momentum\n` +
      `✅ ATR volatility\n` +
      `✅ Bollinger Bands\n` +
      `✅ Support / Resistance\n` +
      `✅ Candle structure\n` +
      `✅ Market regime\n` +
      `✅ Higher timeframe confirmation\n` +
      `✅ Duplicate protection\n` +
      `✅ Stale-data protection\n` +
      `✅ Confidence threshold\n` +
      `❌ Martingale: OFF\n` +
      `❌ Real-money trading: OFF\n\n` +
      `Current threshold: <b>${getThreshold(chatId)}%</b>\n\n` +
      `⚠️ If one critical confirmation fails → WAIT`
    );
    return;
  }

  if (text === "/stats") {
    const total = signalHistory.length;

    const calls =
      signalHistory.filter(x => x.direction === "CALL").length;

    const puts =
      signalHistory.filter(x => x.direction === "PUT").length;

    const waits =
      signalHistory.filter(x => x.direction === "WAIT").length;

    const wins =
      signalHistory.filter(x => x.result === "WIN").length;

    const losses =
      signalHistory.filter(x => x.result === "LOSS").length;

    await sendMessage(
      chatId,
      `📊 <b>Paper Signal Stats</b>\n\n` +
      `Total: ${total}\n` +
      `CALL: ${calls}\n` +
      `PUT: ${puts}\n` +
      `WAIT: ${waits}\n` +
      `WIN: ${wins}\n` +
      `LOSS: ${losses}`
    );

    return;
  }

  if (text === "/history") {
    const recent = signalHistory.slice(-10);

    if (recent.length === 0) {
      await sendMessage(
        chatId,
        `📭 هنوز سیگنالی ثبت نشده است.`
      );
      return;
    }

    let output = `📜 <b>Recent History</b>\n\n`;

    for (const item of recent) {
      output +=
        `${item.asset} ${item.timeframe} → ` +
        `${item.direction} ` +
        `(${item.confidence}%)\n`;
    }

    await sendMessage(chatId, output);
    return;
  }

  if (text.startsWith("/signal")) {
    const parts = text.split(/\s+/);

    if (parts.length < 3) {
      await sendMessage(
        chatId,
        `❌ فرمت درست:\n\n` +
        `<code>/signal BTCUSDT 5m</code>`
      );
      return;
    }

    const symbol = parts[1].toUpperCase();
    const timeframe = parts[2];

    if (!TIMEFRAMES[timeframe]) {
      await sendMessage(
        chatId,
        `❌ Timeframe نامعتبر است.\n\n` +
        `استفاده کن از:\n` +
        `1m, 3m, 5m, 15m, 30m, 1h, 4h`
      );
      return;
    }

    await sendMessage(
      chatId,
      `🔎 <b>Analyzing...</b>\n\n` +
      `${symbol} • ${timeframe}\n\n` +
      `چند تأیید همزمان بررسی می‌شود...`
    );

    const threshold = getThreshold(chatId);

    const result =
      await analyze(symbol, timeframe, threshold);

    await sendMessage(
      chatId,
      formatSignal(result)
    );

    return;
  }
}

function getThreshold(chatId) {
  return userSettings.get(chatId) || DEFAULT_THRESHOLD;
}

// ------------------------------------------------------------
// POLLING LOOP
// ------------------------------------------------------------

async function pollTelegram() {
  try {
    const result = await telegram("getUpdates", {
      offset: telegramOffset,
      timeout: 25,
      allowed_updates: ["message"]
    });

    if (result.ok && Array.isArray(result.result)) {
      for (const update of result.result) {
        telegramOffset = update.update_id + 1;

        try {
          await handleMessage(update.message);
        } catch (error) {
          console.error(
            "Message error:",
            error.message
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "Telegram polling error:",
      error.message
    );

    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    );
  }

  setImmediate(pollTelegram);
}

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function main() {
  console.log(
    "=========================================="
  );

  console.log(
    "QUOTEX-STYLE SIGNAL ENGINE STARTED"
  );

  console.log(
    "CALL = UP | PUT = DOWN | WAIT = NO TRADE"
  );

  console.log(
    "Confidence threshold: 90%"
  );

  console.log(
    "Real-money trading: OFF"
  );

  console.log(
    "Martingale: OFF"
  );

  console.log(
    "=========================================="
  );

  try {
    const me = await telegram("getMe");

    if (me.ok) {
      console.log(
        `Telegram bot connected: @${me.result.username}`
      );
    }
  } catch (error) {
    console.error(
      "Telegram connection failed:",
      error.message
    );
  }

  pollTelegram();
}

main();
