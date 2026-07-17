const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'sbwhook-9aj18gsxqtubed5vpliorcwh';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8267105370:AAH00rC8w2BmEzYZME91zS70Q-VMNd02YY';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1004361307911';
let goalAmount = 5000000;
let collectedAmount = 0;

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    collectedAmount = Number(parsed.collectedAmount) || 0;
    goalAmount = Number(parsed.goalAmount) || goalAmount;
  } catch (error) {
    console.warn('Gagal memuat data.json, gunakan nilai default.');
  }
}

function saveData() {
  const json = JSON.stringify({ collectedAmount, goalAmount }, null, 2);
  fs.writeFileSync(DATA_FILE, json, 'utf8');
}

function getHeaderValue(req, name) {
  const header = req.headers[name.toLowerCase()];
  if (!header) return '';
  return Array.isArray(header) ? header[0] : header;
}

function validateWebhook(req) {
  if (!WEBHOOK_TOKEN) return true;

  const tokenHeader = getHeaderValue(req, 'x-sociabuzz-webhook-token')
    || getHeaderValue(req, 'x-trakteer-webhook-token')
    || getHeaderValue(req, 'x-webhook-token')
    || getHeaderValue(req, 'authorization')
    || getHeaderValue(req, 'x-api-key');

  const urlToken = req.url && req.url.includes('token=')
    ? req.url.split('token=')[1].split('&')[0]
    : '';

  const bodyToken = req.body && (req.body.webhook_token || req.body.token || req.body.api_key)
    ? (req.body.webhook_token || req.body.token || req.body.api_key)
    : '';

  return tokenHeader === WEBHOOK_TOKEN || urlToken === WEBHOOK_TOKEN || bodyToken === WEBHOOK_TOKEN;
}

function formatRupiah(number) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(number);
}

function escapeTelegramText(text) {
  return String(text || '')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function sendTelegramMessage(text, callback) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    callback(new Error('TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diatur'));
    return;
  }

  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2'
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => responseBody += chunk);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        callback(null, responseBody);
      } else {
        callback(new Error(`Telegram API error: ${res.statusCode} ${responseBody}`));
      }
    });
  });

  req.on('error', callback);
  req.write(payload);
  req.end();
}

function sendJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.js': return 'application/javascript';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/donasi' && req.method === 'GET') {
    sendJson(res, { collectedAmount, goalAmount });
    return;
  }

  if (pathname === '/webhook/donasi' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        req.body = payload;

        if (!validateWebhook(req)) {
          sendJson(res, { error: 'Webhook token tidak valid' }, 403);
          return;
        }

        const newAmount = Number(payload.amount);
        if (!newAmount || newAmount <= 0) {
          sendJson(res, { error: 'Nominal donasi tidak valid' }, 400);
          return;
        }

        collectedAmount += newAmount;
        saveData();

        const donor = escapeTelegramText(payload.donor || payload.name || 'Anonim');
        const message = `*Donasi baru masuk!*
Nominal: *${escapeTelegramText(formatRupiah(newAmount))}*
Donatur: *${donor}*
Total terkumpul: *${escapeTelegramText(formatRupiah(collectedAmount))}*`;

        sendTelegramMessage(message, (err) => {
          if (err) {
            console.warn('Gagal kirim Telegram:', err.message);
          }
          sendJson(res, { collectedAmount, goalAmount, telegram: err ? 'failed' : 'sent' });
        });
      } catch (error) {
        sendJson(res, { error: 'Payload tidak valid' }, 400);
      }
    });
    return;
  }

  let filePath = path.join(__dirname, 'index.html');
  if (pathname !== '/' && pathname !== '/index.html') {
    filePath = path.join(__dirname, pathname);
  }

  const contentType = getContentType(filePath);
  sendFile(res, filePath, contentType);
});

loadData();

server.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log('Gunakan endpoint POST /webhook/donasi untuk menerima donasi.');
  console.log('Pastikan TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID sudah diatur jika ingin notifikasi Telegram.');
});