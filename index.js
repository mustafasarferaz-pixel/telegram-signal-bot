"use strict";

/*
  TELEGRAM CRYPTO SIGNAL BOT

  Commands:
  /signal
  signal

  Bot:
  - فقط Crypto
  - بدون OTC
  - بررسی 1m / 5m / 15m
  - انتخاب خودکار بهترین Crypto
  - انتخاب خودکار بهترین Timeframe
  - چند تأیید تکنیکال
  - اگر شرایط کافی نباشد => WAIT
  - بدون Martingale
  - بدون اتصال به حساب Quotex
  - فقط Telegram Bot Token لازم دارد

  IMPORTANT:
  این نسخه از Binance Public API برای داده بازار استفاده می‌کند.
  بنابراین قیمت/کندل آن تضمیناً با Quotex یکسان نیست.
*/

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

// ================================
// SETTINGS
// ================================

const MIN_CONFIDENCE = 90;
const IDEAL_CONFIDENCE = 95;

const TIMEFRAMES = ["1m", "5m", "15m"];

const COINS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "LTCUSDT"
];

const CANDLE_LIMIT = 100;

// ================================
// TELEGRAM API
// ================================

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

// ================================
// SEND MESSAGE
// ================================

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: text
  });
}

// ================================
// BINANCE MARKET DATA
// ================================

async function getCandles(symbol, interval) {
  const url =
    "https://api.binance.com/api/v3/klines" +
    `?symbol=${symbol}` +
    `&interval=${interval}` +
    `&limit=${CANDLE_LIMIT}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Market data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Invalid market data.");
  }

  return data.map(c => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

// ================================
// EMA
// ================================

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = 0;

  for (let i = 0; i < period; i++) {
    result += values[i];
  }

  result /= period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

// ================================
// RSI
// ================================

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) / period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

// ================================
// ATR
// ================================

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  if (trs.length < period) return null;

  let atr = 0;

  for (let i = 0; i < period; i++) {
    atr += trs[i];
  }

  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr =
      ((atr * (period - 1)) + trs[i]) / period;
  }

  return atr;
}

// ================================
// PRICE TREND
// ================================

function getTrend(candles) {
  const closes = candles.map(c => c.close);

  const fast = ema(closes, 9);
  const slow = ema(closes, 21);

  if (fast === null || slow === null) {
    return "NEUTRAL";
  }

  if (fast > slow) {
    return "UP";
  }

  if (fast < slow) {
    return "DOWN";
  }

  return "NEUTRAL";
}

// ================================
// MOMENTUM
// ================================

function getMomentum(candles) {
  if (candles.length < 10) {
    return "NEUTRAL";
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 6];

  if (last.close > previous.close) {
    return "UP";
  }

  if (last.close < previous.close) {
    return "DOWN";
  }

  return "NEUTRAL";
}

// ================================
// CANDLE DIRECTION
// ================================

function getCandleDirection(candles) {
  const last = candles[candles.length - 1];

  if (!last) return "NEUTRAL";

  if (last.close > last.open) {
    return "UP";
  }

  if (last.close < last.open) {
    return "DOWN";
  }

  return "NEUTRAL";
}

// ================================
// VOLUME CONFIRMATION
// ================================

function getVolumeConfirmation(candles) {
  if (candles.length < 21) {
    return false;
  }

  const last = candles[candles.length - 1];

  let average = 0;

  for (let i = candles.length - 21; i < candles.length - 1; i++) {
    average += candles[i].volume;
  }

  average /= 20;

  return last.volume >= average;
}

// ================================
// ANALYZE ONE COIN
// ================================

async function analyzeCoin(symbol) {
  const results = [];

  for (const timeframe of TIMEFRAMES) {
    try {
      const candles = await getCandles(symbol, timeframe);

      if (candles.length < 50) {
        results.push({
          coin: symbol,
          timeframe,
          signal: "WAIT",
          confidence: 0,
          reason: "Not enough market data."
        });

        continue;
      }

      const closes = candles.map(c => c.close);

      const currentPrice =
        closes[closes.length - 1];

      const rsi =
        calculateRSI(closes, 14);

      const atr =
        calculateATR(candles, 14);

      const trend =
        getTrend(candles);

      const momentum =
        getMomentum(candles);

      const candle =
        getCandleDirection(candles);

      const volume =
        getVolumeConfirmation(candles);

      let upPoints = 0;
      let downPoints = 0;

      const reasons = [];

      // EMA TREND
      if (trend === "UP") {
        upPoints += 25;
        reasons.push("EMA trend UP");
      }

      if (trend === "DOWN") {
        downPoints += 25;
        reasons.push("EMA trend DOWN");
      }

      // RSI
      if (rsi !== null) {
        if (rsi >= 50 && rsi <= 68) {
          upPoints += 20;
          reasons.push("RSI bullish");
        }

        if (rsi <= 50 && rsi >= 32) {
          downPoints += 20;
          reasons.push("RSI bearish");
        }
      }

      // MOMENTUM
      if (momentum === "UP") {
        upPoints += 20;
        reasons.push("Momentum UP");
      }

      if (momentum === "DOWN") {
        downPoints += 20;
        reasons.push("Momentum DOWN");
      }

      // CANDLE
      if (candle === "UP") {
        upPoints += 15;
        reasons.push("Bullish candle");
      }

      if (candle === "DOWN") {
        downPoints += 15;
        reasons.push("Bearish candle");
      }

      // VOLUME
      if (volume) {
        if (upPoints > downPoints) {
          upPoints += 10;
        } else if (downPoints > upPoints) {
          downPoints += 10;
        }

        reasons.push("Volume confirmation");
      }

      // VOLATILITY
      if (atr !== null && currentPrice > 0) {
        const volatility =
          atr / currentPrice;

        // Avoid extremely quiet markets.
        if (volatility > 0.0001) {
          if (upPoints > downPoints) {
            upPoints += 10;
          } else if (downPoints > upPoints) {
            downPoints += 10;
          }

          reasons.push("Sufficient volatility");
        }
      }

      const total =
        upPoints + downPoints;

      let signal = "WAIT";
      let confidence = 0;

      if (total > 0) {
        if (upPoints > downPoints) {
          confidence =
            Math.round((upPoints / 100) * 100);

          if (confidence >= MIN_CONFIDENCE) {
            signal = "CALL";
          }
        }

        if (downPoints > upPoints) {
          confidence =
            Math.round((downPoints / 100) * 100);

          if (confidence >= MIN_CONFIDENCE) {
            signal = "PUT";
          }
        }
      }

      // HARD FILTER
      if (confidence < MIN_CONFIDENCE) {
        signal = "WAIT";
      }

      results.push({
        coin: symbol,
        timeframe,
        signal,
        confidence,
        price: currentPrice,
        rsi: rsi ? Number(rsi.toFixed(2)) : null,
        trend,
        momentum,
        candle,
        reason:
          signal === "WAIT"
            ? "Not enough independent confirmations."
            : reasons.join(" • ")
      });

    } catch (error) {
      console.error(
        `${symbol} ${timeframe}:`,
        error.message
      );

      results.push({
        coin: symbol,
        timeframe,
        signal: "WAIT",
        confidence: 0,
        reason: error.message
      });
    }
  }

  return results;
}

// ================================
// FIND BEST SIGNAL
// ================================

async function findBestSignal() {
  const allResults = [];

  for (const coin of COINS) {
    const results =
      await analyzeCoin(coin);

    allResults.push(...results);
  }

  const valid =
    allResults.filter(result =>
      result.signal !== "WAIT" &&
      result.confidence >= MIN_CONFIDENCE
    );

  if (valid.length === 0) {
    return {
      signal: "WAIT",
      confidence: 0,
      reason:
        "No crypto has enough confirmation."
    };
  }

  valid.sort(
    (a, b) =>
      b.confidence - a.confidence
  );

  return valid[0];
}

// ================================
// FORMAT SIGNAL
// ================================

function formatSignal(result) {
  if (result.signal === "WAIT") {
    return (
      "🟡 WAIT — NO TRADE\n\n" +
      "Crypto: ALL\n" +
      "Timeframes checked:\n" +
      "1m • 5m • 15m\n\n" +
      "Confidence: " +
      (result.confidence || 0) +
      "%\n\n" +
      "Reason:\n" +
      (result.reason ||
        "No strong confirmation.")
    );
  }

  return (
    "🚨 CRYPTO SIGNAL\n\n" +
    "Asset: " +
    result.coin +
    "\n" +
    "Signal: " +
    result.signal +
    "\n" +
    "Timeframe: " +
    result.timeframe +
    "\n" +
    "Confidence: " +
    result.confidence +
    "%\n\n" +
    "Price: " +
    result.price +
    "\n\n" +
    "RSI: " +
    (result.rsi ?? "N/A") +
    "\n" +
    "Trend: " +
    result.trend +
    "\n" +
    "Momentum: " +
    result.momentum +
    "\n\n" +
    "Reason:\n" +
    (result.reason ||
      "Multiple confirmations detected.")
  );
}

// ================================
// HANDLE MESSAGE
// ================================

async function handleMessage(message) {
  if (!message || !message.chat) {
    return;
  }

  const chatId =
    message.chat.id;

  const text =
    (message.text || "")
      .trim()
      .toLowerCase();

  // ONLY signal command
  if (
    text !== "/signal" &&
    text !== "signal"
  ) {
    return;
  }

  await sendMessage(
    chatId,
    "🔎 Analyzing crypto markets...\n\n" +
    "Checking:\n" +
    "• BTC\n" +
    "• ETH\n" +
    "• SOL\n" +
    "• XRP\n" +
    "• BNB\n" +
    "• ADA\n" +
    "• DOGE\n" +
    "• AVAX\n" +
    "• LINK\n" +
    "• LTC\n\n" +
    "Timeframes: 1m • 5m • 15m\n\n" +
    "Please wait..."
  );

  try {
    const result =
      await findBestSignal();

    const text =
      formatSignal(result);

    await sendMessage(
      chatId,
      text
    );

  } catch (error) {
    console.error(
      "Signal error:",
      error
    );

    await sendMessage(
      chatId,
      "🟡 WAIT — NO TRADE\n\n" +
      "The market data could not be verified.\n\n" +
      "No signal was sent."
    );
  }
}

// ================================
// TELEGRAM POLLING
// ================================

let telegramOffset = 0;

async function pollTelegram() {
  try {
    const result =
      await telegram("getUpdates", {
        offset: telegramOffset,
        timeout: 25,
        allowed_updates: ["message"]
      });

    if (
      result.ok &&
      Array.isArray(result.result)
    ) {
      for (const update of result.result) {
        telegramOffset =
          update.update_id + 1;

        try {
          await handleMessage(
            update.message
          );
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

// ================================
// START
// ================================

async function main() {
  console.log(
    "================================"
  );

  console.log(
    "Telegram Crypto Signal Bot"
  );

  console.log(
    "Starting..."
  );

  console.log(
    "Minimum confidence:",
    MIN_CONFIDENCE + "%"
  );

  console.log(
    "Ideal confidence:",
    IDEAL_CONFIDENCE + "%"
  );

  console.log(
    "Crypto only: YES"
  );

  console.log(
    "OTC: NO"
  );

  console.log(
    "Martingale: NO"
  );

  console.log(
    "Quotex account connection: NO"
  );

  console.log(
    "================================"
  );

  await pollTelegram();
}

main().catch(error => {
  console.error(
    "Fatal error:",
    error
  );

  process.exit(1);
});
