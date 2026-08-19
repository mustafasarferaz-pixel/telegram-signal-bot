const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const CRYPTO_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const INTERVAL = '5m';

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * 13 + diff) / 14;
      avgLoss = (avgLoss * 13) / 14;
    } else {
      avgGain = (avgGain * 13) / 14;
      avgLoss = (avgLoss * 13 - diff) / 14;
    }
  }
  const rs = avgGain / (avgLoss || 1);
  return 100 - (100 / (1 + rs));
}

async function analyzeOptimalCrypto(symbol) {
  try {
    // استفاده از fetch داخلی Node.js
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=100`);
    const data = await res.json();
    
    const closes = data.map(c => parseFloat(c[4]));
    const volumes = data.map(c => parseFloat(c[5]));
    
    const currentPrice = closes[closes.length - 1];
    const ema200 = calculateEMA(closes, 200 > closes.length ? closes.length : 200);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    
    const currentVolume = volumes[volumes.length - 1];
    const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const isVolumeStrong = currentVolume > (avgVolume * 1.2);

    if (currentPrice > ema200 && currentPrice > ema50 && rsi < 30 && isVolumeStrong) {
      return `🟢 **${symbol}**: CALL (خرید) | تایم‌فریم: ${INTERVAL}`;
    } 
    else if (currentPrice < ema200 && currentPrice < ema50 && rsi > 70 && isVolumeStrong) {
      return `🔴 **${symbol}**: PUT (فروش) | تایم‌فریم: ${INTERVAL}`;
    } 
    else {
      return `⏳ **${symbol}**: WAIT (صبر - شرایط مناسب نیست)`;
    }
  } catch (err) {
    return `⚠️ **${symbol}**: WAIT (خطا در اتصال)`;
  }
}

bot.on('message', async (msg) => {
  const text = msg.text ? msg.text.toLowerCase().trim() : '';

  if (text === 'signal' || text === '/signal' || text === '/start') {
    bot.sendMessage(msg.chat.id, `🔍 در حال آنالیز کندل‌های ${INTERVAL}...`);

    let results = [];
    for (const symbol of CRYPTO_PAIRS) {
      const res = await analyzeOptimalCrypto(symbol);
      results.push(res);
    }

    const responseText = `📊 **گزارش سیگنال تایم‌فریم ${INTERVAL}:**\n\n` + results.join('\n');
    bot.sendMessage(msg.chat.id, responseText, { parse_mode: 'Markdown' });
  }
});

console.log("Bot running successfully...");
