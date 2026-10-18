const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const ExcelJS = require('exceljs');

// Izinkan autoplay media dengan suara tanpa blokir kebijakan browser
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;
let viewerWindow = null;
let sseClients = [];
const SERVER_PORT = 3000;

const dbPath = path.join(app.getPath('userData'), 'database-klinik-dewi-anjani.json');
const voiceCacheDir = path.join(app.getPath('userData'), 'voice-cache-id');

if (!fs.existsSync(voiceCacheDir)) {
  try {
    fs.mkdirSync(voiceCacheDir, { recursive: true });
  } catch (e) {}
}

const defaultData = {
  settings: {
    clinicName: 'Klinik Bidan Dewi Anjani',
    clinicAddress: 'Kavling Tanah Harapan No.D63, RT.011/RW.006, Pejuang, Medan Satria, Bekasi, West Java 17131',
    clinicPhone: '085178266540',
    runningText: 'Selamat Datang di Klinik Bidan Dewi Anjani — Layanan Poli Kandungan (Poli Obgyn) — Info & Pendaftaran Hubungi: 085178266540.',
    voiceGender: 'female',
    videoPlaylist: [
      'https://www.w3schools.com/html/mov_bbb.mp4'
    ]
  },
  queues: {
    counters: { A: 0 },
    currentCall: { number: '-', poli: 'POLI KANDUNGAN (POLI OBGYN)', code: 'A' },
    poliCurrent: { A: '-' },
    history: []
  },
  patients: [],
  finances: [],
  medicines: []
};

function loadDatabase() {
  try {
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2), 'utf-8');
      return JSON.parse(JSON.stringify(defaultData));
    }
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    if (!parsed.settings) parsed.settings = defaultData.settings;
    if (!parsed.settings.videoPlaylist || !Array.isArray(parsed.settings.videoPlaylist)) {
      parsed.settings.videoPlaylist = defaultData.settings.videoPlaylist;
    }
    if (!parsed.settings.clinicPhone) {
      parsed.settings.clinicPhone = defaultData.settings.clinicPhone;
    }
    if (!parsed.queues) parsed.queues = defaultData.queues;
    if (!parsed.patients) parsed.patients = [];
    if (!parsed.finances) parsed.finances = [];
    if (!parsed.medicines) parsed.medicines = [];
    return parsed;
  } catch (err) {
    return JSON.parse(JSON.stringify(defaultData));
  }
}

// ============================================================================
// ENGINE SUARA NEURAL BAHASA INDONESIA (MIRIP MANUSIA ASLI - CEWEK & COWOK)
// ============================================================================
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '130.0.2849.68';

function generateSecMsGec() {
  const WIN_EPOCH = 11644473600;
  const ticks = Math.floor((Date.now() / 1000) + WIN_EPOCH);
  const rounded = ticks - (ticks % 300);
  const windowsTicks = BigInt(rounded) * 10000000n;
  const strToHash = windowsTicks.toString() + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fetchEdgeNeuralTTS(text, gender) {
  return new Promise((resolve, reject) => {
    const voiceName = (gender === 'male') ? 'id-ID-ArdiNeural' : 'id-ID-GadisNeural';
    const secMsGec = generateSecMsGec();
    const wsUrl = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' +
      TRUSTED_CLIENT_TOKEN + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-' + CHROMIUM_FULL_VERSION;

    const reqId = crypto.randomBytes(16).toString('hex');
    const audioChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Edge Neural TTS timeout'));
      }
    }, 4500);

    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }

    ws.on('open', () => {
      const configMsg =
        'X-Timestamp:' + new Date().toString() + '\r\n' +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
      ws.send(configMsg);

      const ssmlMsg =
        'X-RequestId:' + reqId + '\r\n' +
        'Content-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + new Date().toString() + 'Z\r\n' +
        'Path:ssml\r\n\r\n' +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='id-ID'>" +
        "<voice name='" + voiceName + "'>" +
        "<prosody pitch='+0Hz' rate='-5%' volume='+0%'>" + escapeXml(text) + "</prosody>" +
        "</voice></speak>";
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        if (buf.length > 2) {
          const headerLen = buf.readUInt16BE(0);
          if (buf.length > 2 + headerLen) {
            const headerStr = buf.subarray(2, 2 + headerLen).toString('utf-8');
            if (headerStr.indexOf('Path:audio') !== -1) {
              audioChunks.push(buf.subarray(2 + headerLen));
            }
          }
        }
      } else {
        const str = data.toString('utf-8');
        if (str.indexOf('Path:turn.end') !== -1) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            try { ws.close(); } catch (e) {}
            const finalBuffer = Buffer.concat(audioChunks);
            if (finalBuffer.length > 100) {
              resolve(finalBuffer);
            } else {
              reject(new Error('Empty audio buffer from Edge Neural TTS'));
            }
          }
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error('WebSocket closed before audio complete'));
        }
      }
    });
  });
}

function fetchGoogleIndonesianTTS(text) {
  return new Promise((resolve, reject) => {
    const url = 'https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=id&q=' + encodeURIComponent(text);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 4500
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('Google TTS HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length > 100) resolve(buf);
        else reject(new Error('Empty Google TTS response'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google TTS timeout'));
    });
  });
}

async function synthesizeIndonesianVoice(text, gender) {
  const cleanGender = (gender === 'male') ? 'male' : 'female';
  const hash = crypto.createHash('md5').update(cleanGender + ':' + text).digest('hex');
  const edgeCacheFile = path.join(voiceCacheDir, 'edge_' + cleanGender + '_' + hash + '.mp3');
  const googleCacheFile = path.join(voiceCacheDir, 'google_' + hash + '.mp3');

  if (fs.existsSync(edgeCacheFile)) {
    const buf = fs.readFileSync(edgeCacheFile);
    return {
      success: true,
      engine: 'edge-neural',
      voiceName: cleanGender === 'male' ? 'Ardi (Laki-laki Indonesia)' : 'Gadis (Perempuan Indonesia)',
      audioBase64: buf.toString('base64')
    };
  }

  try {
    const edgeBuffer = await fetchEdgeNeuralTTS(text, cleanGender);
    try { fs.writeFileSync(edgeCacheFile, edgeBuffer); } catch (e) {}
    return {
      success: true,
      engine: 'edge-neural',
      voiceName: cleanGender === 'male' ? 'Ardi (Laki-laki Indonesia)' : 'Gadis (Perempuan Indonesia)',
      audioBase64: edgeBuffer.toString('base64')
    };
  } catch (edgeErr) {
    if (fs.existsSync(googleCacheFile)) {
      const gBuf = fs.readFileSync(googleCacheFile);
      return {
        success: true,
        engine: 'google-neural',
        voiceName: 'Google Bahasa Indonesia',
        audioBase64: gBuf.toString('base64')
      };
    }
    try {
      const googleBuffer = await fetchGoogleIndonesianTTS(text);
      try { fs.writeFileSync(googleCacheFile, googleBuffer); } catch (e) {}
      return {
        success: true,
        engine: 'google-neural',
        voiceName: 'Google Bahasa Indonesia',
        audioBase64: googleBuffer.toString('base64')
      };
    } catch (googleErr) {
      return {
        success: false,
        engine: 'offline-fallback',
        error: googleErr.message
      };
    }
  }
}

function broadcastToNetworkTV(eventType, payload) {
  const message = 'data: ' + JSON.stringify({ type: eventType, payload: payload }) + '\n\n';
  sseClients.forEach(clientRes => {
    try {
      clientRes.write(message);
    } catch (e) {}
  });
}

function saveDatabase(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('db-updated', data);
  }
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send('db-updated', data);
  }
  broadcastToNetworkTV('db-updated', data);
}

function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name: name, address: iface.address });
      }
    }
  }
  return addresses.length > 0 ? addresses : [{ name: 'Localhost', address: '127.0.0.1' }];
}

function startNetworkTVServer() {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/tv') {
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, 'utf-8', (err, html) => {
        if (err) {
          res.writeHead(500);
          return res.end('Gagal memuat halaman TV');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    if (reqUrl.pathname === '/api/db') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify(loadDatabase()));
    }

    if (reqUrl.pathname === '/api/tts') {
      const text = reqUrl.searchParams.get('text') || '';
      const gender = reqUrl.searchParams.get('gender') || 'female';
      const result = await synthesizeIndonesianVoice(text, gender);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify(result));
    }

    if (reqUrl.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('data: ' + JSON.stringify({ type: 'db-updated', payload: loadDatabase() }) + '\n\n');
      sseClients.push(res);

      req.on('close', () => {
        sseClients = sseClients.filter(client => client !== res);
      });
      return;
    }

    if (reqUrl.pathname === '/video') {
      const db = loadDatabase();
      const idx = parseInt(reqUrl.searchParams.get('idx') || '0', 10);
      const playlist = db.settings.videoPlaylist || [];
      const videoPath = playlist[idx] || playlist[0];

      if (!videoPath) {
        res.writeHead(404);
        return res.end('Playlist video kosong');
      }

      if (videoPath.startsWith('http://') || videoPath.startsWith('https://')) {
        res.writeHead(302, { Location: videoPath });
        return res.end();
      }

      if (!fs.existsSync(videoPath)) {
        res.writeHead(404);
        return res.end('File video lokal tidak ditemukan');
      }

      const stat = fs.statSync(videoPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start: start, end: end });
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4'
        });
        fs.createReadStream(videoPath).pipe(res);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('error', (err) => {
    console.error('Server TV error:', err.message);
  });

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log('Server Layar TV aktif di port ' + SERVER_PORT);
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 650,
    title: 'SistemAntrianKlinik - Klinik Bidan Dewi Anjani (@copyright iman.mn_)',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

function createViewerWindow() {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.focus();
    return;
  }
  viewerWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Monitor TV Antrian - Klinik Bidan Dewi Anjani',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  viewerWindow.loadFile('index.html', { query: { mode: 'viewer' } });
}

app.whenReady().then(() => {
  loadDatabase();
  startNetworkTVServer();
  createMainWindow();
});

ipcMain.handle('get-db', () => loadDatabase());

ipcMain.handle('save-db', (event, newData) => {
  saveDatabase(newData);
  return { success: true };
});

ipcMain.handle('synthesize-voice', async (event, { text, gender }) => {
  return await synthesizeIndonesianVoice(text, gender);
});

ipcMain.handle('select-local-videos', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih File Video Edukasi untuk Playlist (Bisa Pilih Banyak File)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'File Video (MP4, WebM, MKV, OGG)', extensions: ['mp4', 'webm', 'ogg', 'mkv', 'mov'] }
    ]
  });
  if (canceled || !filePaths || filePaths.length === 0) {
    return { canceled: true, filePaths: [] };
  }
  return { canceled: false, filePaths: filePaths };
});

ipcMain.handle('get-network-info', () => {
  const ips = getLocalIPAddresses();
  return {
    port: SERVER_PORT,
    urls: ips.map(item => ({
      name: item.name,
      url: 'http://' + item.address + ':' + SERVER_PORT + '/tv'
    }))
  };
});

ipcMain.on('broadcast-voice-call', (event, voiceData) => {
  broadcastToNetworkTV('voice-call', voiceData);
});

ipcMain.on('voice-ducking-state', (event, isSpeaking) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('apply-video-ducking', isSpeaking);
  }
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send('apply-video-ducking', isSpeaking);
  }
  broadcastToNetworkTV('video-ducking', { isSpeaking: isSpeaking });
});

ipcMain.on('open-viewer-window', () => {
  createViewerWindow();
});

ipcMain.handle('print-ticket', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  return new Promise((resolve) => {
    mainWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
      resolve({ success: success, reason: failureReason });
    });
  });
});

// ============================================================================
// EKSPOR LAPORAN EXCEL (.XLSX) BERGAYA DASHBOARD DENGAN TABEL & GRAFIK VISUAL
// ============================================================================
function buildVisualBar(value, maxValue) {
  if (!maxValue || maxValue <= 0) return '░░░░░░░░░░   0%';
  const ratio = Math.max(0, Math.min(1, value / maxValue));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const pct = Math.round(ratio * 100);
  return '█'.repeat(filled) + '░'.repeat(empty) + ' ' + String(pct).padStart(3, ' ') + '%';
}

function applyBannerHeader(ws, title, subtitle, totalCols) {
  ws.mergeCells(1, 1, 1, totalCols);
  ws.mergeCells(2, 1, 2, totalCols);
  ws.getRow(1).height = 30;
  ws.getRow(2).height = 20;

  const c1 = ws.getCell(1, 1);
  c1.value = title;
  c1.font = { name: 'Segoe UI', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
  c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  const c2 = ws.getCell(2, 1);
  c2.value = subtitle;
  c2.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: 'FFD1FAE5' } };
  c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
}

const thinBorder = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
};

const totalBorder = {
  top: { style: 'thin', color: { argb: 'FF065F46' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'double', color: { argb: 'FF065F46' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
};

ipcMain.handle('export-excel', async (event, { period, charts }) => {
  const db = loadDatabase();
  const isWeekly = period === 'weekly';
  const daysLimit = isWeekly ? 7 : 30;
  const labelPeriode = isWeekly ? 'Mingguan (7 Hari Terakhir)' : 'Bulanan (30 Hari Terakhir)';

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysLimit);

  const filteredFinances = db.finances.filter(f => new Date(f.date) >= cutoff);
  const filteredMedicines = db.medicines.filter(m => new Date(m.date) >= cutoff);
  const filteredPatients = db.patients.filter(p => new Date(p.date) >= cutoff);

  let totalMasuk = 0, totalKeluar = 0;
  filteredFinances.forEach(f => {
    if (f.tipe === 'MASUK') totalMasuk += Number(f.nominal);
    else totalKeluar += Number(f.nominal);
  });
  const saldoBersih = totalMasuk - totalKeluar;
  const maxFinNominal = Math.max(1, ...filteredFinances.map(f => Number(f.nominal) || 0));

  let totalObatMasuk = 0, totalObatKeluar = 0;
  filteredMedicines.forEach(m => {
    if (m.status === 'MASUK') totalObatMasuk += Number(m.jumlah);
    else totalObatKeluar += Number(m.jumlah);
  });
  const maxMedJumlah = Math.max(1, ...filteredMedicines.map(m => Number(m.jumlah) || 0));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SistemAntrianKlinik - @copyright iman.mn_';
  workbook.created = new Date();

  const subtitleText = db.settings.clinicName + ' | ' + db.settings.clinicAddress + ' | Telp: ' + db.settings.clinicPhone + ' | Periode: ' + labelPeriode + ' | @copyright iman.mn_';

  // ==================== SHEET 1: DASHBOARD LAPORAN ====================
  const wsDash = workbook.addWorksheet('Dashboard Laporan', {
    views: [{ showGridLines: true }]
  });

  applyBannerHeader(
    wsDash,
    'DASHBOARD EKSEKUTIF — ' + db.settings.clinicName.toUpperCase(),
    subtitleText,
    12
  );

  // 6 KPI Cards di Baris 4 & 5
  const kpiCards = [
    { start: 1, end: 2, title: 'TOTAL PEMASUKAN', val: totalMasuk, fmt: '"Rp "#,##0', bg: 'FFDCFCE7', fg: 'FF166534' },
    { start: 3, end: 4, title: 'TOTAL PENGELUARAN', val: totalKeluar, fmt: '"Rp "#,##0', bg: 'FFFEE2E2', fg: 'FF991B1B' },
    { start: 5, end: 6, title: 'SALDO KAS BERSIH', val: saldoBersih, fmt: '"Rp "#,##0;("Rp "#,##0);"-"', bg: 'FFECFDF5', fg: 'FF065F46' },
    { start: 7, end: 8, title: 'TOTAL OBAT MASUK', val: totalObatMasuk, fmt: '#,##0" Unit"', bg: 'FFDBEAFE', fg: 'FF1E40AF' },
    { start: 9, end: 10, title: 'TOTAL OBAT KELUAR', val: totalObatKeluar, fmt: '#,##0" Unit"', bg: 'FFFEF3C7', fg: 'FF92400E' },
    { start: 11, end: 12, title: 'KUNJUNGAN PASIEN', val: filteredPatients.length, fmt: '#,##0" Pasien"', bg: 'FFFCE7F3', fg: 'FF9D174D' }
  ];

  wsDash.getRow(4).height = 16;
  wsDash.getRow(5).height = 26;

  kpiCards.forEach(card => {
    wsDash.mergeCells(4, card.start, 4, card.end);
    wsDash.mergeCells(5, card.start, 5, card.end);
    for (let r = 4; r <= 5; r++) {
      for (let c = card.start; c <= card.end; c++) {
        const cell = wsDash.getCell(r, c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: card.bg } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: c === card.start ? 'medium' : 'thin', color: { argb: c === card.start ? card.fg : 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
      }
    }
    const lblCell = wsDash.getCell(4, card.start);
    lblCell.value = card.title;
    lblCell.font = { name: 'Segoe UI', size: 8, bold: true, color: { argb: card.fg } };
    lblCell.alignment = { horizontal: 'center', vertical: 'middle' };

    const valCell = wsDash.getCell(5, card.start);
    valCell.value = card.val;
    valCell.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: card.fg } };
    valCell.alignment = { horizontal: 'center', vertical: 'middle' };
    valCell.numFmt = card.fmt;
  });

  // Tabel Ringkasan Eksekutif di Kolom A-E (Baris 7 ke bawah)
  wsDash.getCell(7, 1).value = '1. TABEL RINGKASAN EKSEKUTIF KEUANGAN & FARMASI';
  wsDash.getCell(7, 1).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  const dashHeaders1 = ['Indikator Laporan', 'Status / Kategori', 'Nilai / Nominal', 'Proporsi Visual', 'Keterangan'];
  wsDash.getRow(8).height = 24;
  dashHeaders1.forEach((h, i) => {
    const c = wsDash.getCell(8, i + 1);
    c.value = h;
    c.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });

  const maxTotalFin = Math.max(1, totalMasuk + totalKeluar);
  const maxTotalMed = Math.max(1, totalObatMasuk + totalObatKeluar);

  const summaryTableRows = [
    ['Total Pemasukan Klinik', 'MASUK', totalMasuk, buildVisualBar(totalMasuk, maxTotalFin), 'Pemeriksaan Obgyn, USG & Resep', '"Rp "#,##0'],
    ['Total Pengeluaran Operasional', 'KELUAR', totalKeluar, buildVisualBar(totalKeluar, maxTotalFin), 'Pengadaan Obat & Operasional', '"Rp "#,##0'],
    ['Surplus / Saldo Kas Bersih', 'NET', saldoBersih, buildVisualBar(Math.max(0, saldoBersih), Math.max(1, totalMasuk)), 'Selisih Pemasukan - Pengeluaran', '"Rp "#,##0;("Rp "#,##0);"-"'],
    ['Total Stok Obat Masuk', 'MASUK', totalObatMasuk, buildVisualBar(totalObatMasuk, maxTotalMed), 'Restock Gudang Obat & Vitamin', '#,##0" Unit"'],
    ['Total Pemakaian Obat (Resep)', 'KELUAR', totalObatKeluar, buildVisualBar(totalObatKeluar, maxTotalMed), 'Distribusi Obat ke Pasien', '#,##0" Unit"'],
    ['Total Kunjungan Pasien Obgyn', 'PASIEN', filteredPatients.length, '██████████ 100%', 'Poli Kandungan (Poli Obgyn)', '#,##0" Pasien"']
  ];

  summaryTableRows.forEach((rData, idx) => {
    const rNum = 9 + idx;
    wsDash.getRow(rNum).height = 21;
    const isNet = rData[1] === 'NET';
    rData.slice(0, 5).forEach((val, cIdx) => {
      const cell = wsDash.getCell(rNum, cIdx + 1);
      cell.value = val;
      cell.border = isNet ? totalBorder : thinBorder;
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: isNet ? 'FFECFDF5' : (idx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF') }
      };
      cell.font = { name: 'Segoe UI', size: 10, bold: isNet || cIdx === 2, color: { argb: 'FF0F172A' } };

      if (cIdx === 1) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (val === 'MASUK') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF166534' } };
        } else if (val === 'KELUAR') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF991B1B' } };
        }
      } else if (cIdx === 2) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.numFmt = rData[5];
      } else if (cIdx === 3) {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
        cell.font = { name: 'Consolas', size: 9, bold: true, color: { argb: 'FF0F766E' } };
      } else {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });
  });

  // Tabel 2 di Dashboard: 8 Transaksi & Mutasi Obat Terbaru (Baris 17 ke bawah)
  wsDash.getCell(17, 1).value = '2. TABEL AKTIVITAS KEUANGAN & OBAT TERBARU';
  wsDash.getCell(17, 1).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  const dashHeaders2 = ['Tanggal', 'Uraian / Nama Item', 'Kategori', 'Nilai / Unit', 'Proporsi Visual'];
  wsDash.getRow(18).height = 24;
  dashHeaders2.forEach((h, i) => {
    const c = wsDash.getCell(18, i + 1);
    c.value = h;
    c.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });

  const combinedRecent = [
    ...filteredFinances.slice(-5).map(f => ({
      date: new Date(f.date).toLocaleDateString('id-ID'),
      label: f.ket,
      badge: 'KEUANGAN (' + f.tipe + ')',
      isPositive: f.tipe === 'MASUK',
      val: Number(f.nominal),
      fmt: '"Rp "#,##0',
      bar: buildVisualBar(Number(f.nominal), maxFinNominal)
    })),
    ...filteredMedicines.slice(-5).map(m => ({
      date: new Date(m.date).toLocaleDateString('id-ID'),
      label: m.nama,
      badge: 'OBAT (' + m.status + ')',
      isPositive: m.status === 'MASUK',
      val: Number(m.jumlah),
      fmt: '#,##0" Unit"',
      bar: buildVisualBar(Number(m.jumlah), maxMedJumlah)
    }))
  ];

  if (combinedRecent.length === 0) {
    wsDash.mergeCells(19, 1, 19, 5);
    const emptyCell = wsDash.getCell(19, 1);
    emptyCell.value = 'Belum ada transaksi pada periode ini.';
    emptyCell.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF64748B' } };
    emptyCell.alignment = { horizontal: 'center', vertical: 'middle' };
    emptyCell.border = thinBorder;
  } else {
    combinedRecent.forEach((item, idx) => {
      const rNum = 19 + idx;
      wsDash.getRow(rNum).height = 20;
      const vals = [item.date, item.label, item.badge, item.val, item.bar];
      vals.forEach((v, cIdx) => {
        const cell = wsDash.getCell(rNum, cIdx + 1);
        cell.value = v;
        cell.border = thinBorder;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF' } };
        cell.font = { name: 'Segoe UI', size: 9.5, color: { argb: 'FF0F172A' } };
        if (cIdx === 0) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (cIdx === 2) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.isPositive ? 'FFDCFCE7' : 'FFFEF3C7' } };
          cell.font = { name: 'Segoe UI', size: 8.5, bold: true, color: { argb: item.isPositive ? 'FF166534' : 'FF92400E' } };
        } else if (cIdx === 3) {
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
          cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF0F172A' } };
          cell.numFmt = item.fmt;
        } else if (cIdx === 4) {
          cell.font = { name: 'Consolas', size: 9, color: { argb: 'FF0F766E' } };
        }
      });
    });
  }

  // Sematkan 2 Grafik Visual (PNG Base64 dari Canvas UI) di Sebelah Kanan Dashboard (Kolom G-L)
  wsDash.getCell(7, 7).value = '3. GRAFIK VISUAL KEUANGAN & MUTASI OBAT';
  wsDash.getCell(7, 7).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  if (charts && charts.financeChart) {
    try {
      const finImgId = workbook.addImage({
        base64: charts.financeChart,
        extension: 'png'
      });
      wsDash.addImage(finImgId, {
        tl: { col: 6, row: 7 },
        ext: { width: 540, height: 250 }
      });
    } catch (e) {
      console.error('Gagal menyematkan grafik keuangan:', e);
    }
  }

  if (charts && charts.medicineChart) {
    try {
      const medImgId = workbook.addImage({
        base64: charts.medicineChart,
        extension: 'png'
      });
      wsDash.addImage(medImgId, {
        tl: { col: 6, row: 19 },
        ext: { width: 540, height: 250 }
      });
    } catch (e) {
      console.error('Gagal menyematkan grafik obat:', e);
    }
  }

  // ==================== SHEET 2: LAPORAN KEUANGAN ====================
  const wsFin = workbook.addWorksheet('Laporan Keuangan', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: true }]
  });
  applyBannerHeader(wsFin, 'LAPORAN KEUANGAN — ' + db.settings.clinicName.toUpperCase(), subtitleText, 6);

  wsFin.getCell(4, 1).value = 'RINCIAN TRANSAKSI KEUANGAN (' + labelPeriode.toUpperCase() + ')';
  wsFin.getCell(4, 1).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  const finCols = ['No', 'Tanggal', 'Keterangan Transaksi', 'Tipe', 'Nominal (Rp)', 'Proporsi Visual'];
  wsFin.getRow(5).height = 24;
  finCols.forEach((h, i) => {
    const c = wsFin.getCell(5, i + 1);
    c.value = h;
    c.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });

  filteredFinances.forEach((f, idx) => {
    const rNum = 6 + idx;
    wsFin.getRow(rNum).height = 20;
    const isMasuk = f.tipe === 'MASUK';
    const rowVals = [
      idx + 1,
      new Date(f.date).toLocaleDateString('id-ID'),
      f.ket,
      f.tipe,
      Number(f.nominal),
      buildVisualBar(Number(f.nominal), maxFinNominal)
    ];
    rowVals.forEach((val, cIdx) => {
      const cell = wsFin.getCell(rNum, cIdx + 1);
      cell.value = val;
      cell.border = thinBorder;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF' } };
      cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF0F172A' } };
      if (cIdx === 0 || cIdx === 1) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (cIdx === 3) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isMasuk ? 'FFDCFCE7' : 'FFFEE2E2' } };
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: isMasuk ? 'FF166534' : 'FF991B1B' } };
      } else if (cIdx === 4) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF0F172A' } };
        cell.numFmt = '"Rp "#,##0';
      } else if (cIdx === 5) {
        cell.font = { name: 'Consolas', size: 9, bold: true, color: { argb: isMasuk ? 'FF0F766E' : 'FF991B1B' } };
      }
    });
  });

  const finEndRow = Math.max(6, 5 + filteredFinances.length);
  const finTotals = [
    ['TOTAL PEMASUKAN (MASUK)', totalMasuk],
    ['TOTAL PENGELUARAN (KELUAR)', totalKeluar],
    ['SALDO KAS BERSIH (SURPLUS / DEFISIT)', saldoBersih]
  ];
  finTotals.forEach((item, offset) => {
    const rNum = finEndRow + 1 + offset;
    wsFin.getRow(rNum).height = 22;
    wsFin.mergeCells(rNum, 1, rNum, 4);
    for (let c = 1; c <= 6; c++) {
      const cell = wsFin.getCell(rNum, c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };
      cell.border = totalBorder;
      cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF065F46' } };
    }
    wsFin.getCell(rNum, 1).value = item[0];
    wsFin.getCell(rNum, 1).alignment = { horizontal: 'right', vertical: 'middle' };
    wsFin.getCell(rNum, 5).value = item[1];
    wsFin.getCell(rNum, 5).alignment = { horizontal: 'right', vertical: 'middle' };
    wsFin.getCell(rNum, 5).numFmt = '"Rp "#,##0;("Rp "#,##0);"-"';
  });

  // ==================== SHEET 3: LAPORAN OBAT ====================
  const wsMed = workbook.addWorksheet('Laporan Obat', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: true }]
  });
  applyBannerHeader(wsMed, 'LAPORAN STOK & PEMAKAIAN OBAT — ' + db.settings.clinicName.toUpperCase(), subtitleText, 6);

  wsMed.getCell(4, 1).value = 'RINCIAN MUTASI OBAT & VITAMIN (' + labelPeriode.toUpperCase() + ')';
  wsMed.getCell(4, 1).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  const medCols = ['No', 'Tanggal', 'Nama Obat / Vitamin', 'Status Mutasi', 'Jumlah (Unit)', 'Proporsi Visual'];
  wsMed.getRow(5).height = 24;
  medCols.forEach((h, i) => {
    const c = wsMed.getCell(5, i + 1);
    c.value = h;
    c.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });

  filteredMedicines.forEach((m, idx) => {
    const rNum = 6 + idx;
    wsMed.getRow(rNum).height = 20;
    const isMasuk = m.status === 'MASUK';
    const rowVals = [
      idx + 1,
      new Date(m.date).toLocaleDateString('id-ID'),
      m.nama,
      m.status,
      Number(m.jumlah),
      buildVisualBar(Number(m.jumlah), maxMedJumlah)
    ];
    rowVals.forEach((val, cIdx) => {
      const cell = wsMed.getCell(rNum, cIdx + 1);
      cell.value = val;
      cell.border = thinBorder;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF' } };
      cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF0F172A' } };
      if (cIdx === 0 || cIdx === 1) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (cIdx === 3) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isMasuk ? 'FFDBEAFE' : 'FFFEF3C7' } };
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: isMasuk ? 'FF1E40AF' : 'FF92400E' } };
      } else if (cIdx === 4) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF0F172A' } };
        cell.numFmt = '#,##0" Unit"';
      } else if (cIdx === 5) {
        cell.font = { name: 'Consolas', size: 9, bold: true, color: { argb: isMasuk ? 'FF1E40AF' : 'FF92400E' } };
      }
    });
  });

  const medEndRow = Math.max(6, 5 + filteredMedicines.length);
  const medTotals = [
    ['TOTAL OBAT MASUK (RESTOCK)', totalObatMasuk],
    ['TOTAL OBAT KELUAR (RESEP PASIEN)', totalObatKeluar]
  ];
  medTotals.forEach((item, offset) => {
    const rNum = medEndRow + 1 + offset;
    wsMed.getRow(rNum).height = 22;
    wsMed.mergeCells(rNum, 1, rNum, 4);
    for (let c = 1; c <= 6; c++) {
      const cell = wsMed.getCell(rNum, c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };
      cell.border = totalBorder;
      cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF065F46' } };
    }
    wsMed.getCell(rNum, 1).value = item[0];
    wsMed.getCell(rNum, 1).alignment = { horizontal: 'right', vertical: 'middle' };
    wsMed.getCell(rNum, 5).value = item[1];
    wsMed.getCell(rNum, 5).alignment = { horizontal: 'right', vertical: 'middle' };
    wsMed.getCell(rNum, 5).numFmt = '#,##0" Unit"';
  });

  // ==================== SHEET 4: DATA PASIEN ====================
  const wsPat = workbook.addWorksheet('Data Pasien', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: true }]
  });
  applyBannerHeader(wsPat, 'DATA KUNJUNGAN PASIEN — ' + db.settings.clinicName.toUpperCase(), subtitleText, 6);

  wsPat.getCell(4, 1).value = 'DAFTAR PASIEN TERDAFTAR POLI KANDUNGAN (POLI OBGYN)';
  wsPat.getCell(4, 1).font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF065F46' } };

  const patCols = ['No', 'Tanggal Kunjungan', 'NIK / Kontak', 'Nama Lengkap Pasien', 'Usia (Thn)', 'Poli & Catatan Pemeriksaan'];
  wsPat.getRow(5).height = 24;
  patCols.forEach((h, i) => {
    const c = wsPat.getCell(5, i + 1);
    c.value = h;
    c.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });

  filteredPatients.forEach((p, idx) => {
    const rNum = 6 + idx;
    wsPat.getRow(rNum).height = 20;
    const rowVals = [
      idx + 1,
      new Date(p.date).toLocaleDateString('id-ID'),
      p.nik,
      p.nama,
      Number(p.umur),
      (p.poli || 'POLI KANDUNGAN (POLI OBGYN)') + ' — ' + (p.keluhan || '-')
    ];
    rowVals.forEach((val, cIdx) => {
      const cell = wsPat.getCell(rNum, cIdx + 1);
      cell.value = val;
      cell.border = thinBorder;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF' } };
      cell.font = { name: 'Segoe UI', size: 10, bold: cIdx === 3, color: { argb: 'FF0F172A' } };
      cell.alignment = { horizontal: (cIdx === 0 || cIdx === 1 || cIdx === 2 || cIdx === 4) ? 'center' : 'left', vertical: 'middle' };
    });
  });

  // Atur lebar kolom agar rapi dan tidak terpotong
  wsDash.columns = [
    { width: 30 }, { width: 18 }, { width: 20 }, { width: 20 }, { width: 28 },
    { width: 4 },  { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }
  ];
  wsFin.columns = [
    { width: 8 }, { width: 16 }, { width: 42 }, { width: 14 }, { width: 20 }, { width: 22 }
  ];
  wsMed.columns = [
    { width: 8 }, { width: 16 }, { width: 38 }, { width: 16 }, { width: 18 }, { width: 22 }
  ];
  wsPat.columns = [
    { width: 8 }, { width: 18 }, { width: 22 }, { width: 28 }, { width: 14 }, { width: 48 }
  ];

  const defaultFileName = 'Dashboard_Laporan_' + (isWeekly ? 'Mingguan' : 'Bulanan') + '_Klinik_Bidan_Dewi_Anjani_' + new Date().toISOString().slice(0, 10) + '.xlsx';

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Simpan Dashboard Laporan ' + (isWeekly ? 'Mingguan' : 'Bulanan') + ' (.xlsx)',
    defaultPath: defaultFileName,
    filters: [{ name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] }]
  });

  if (canceled || !filePath) return { success: false };
  await workbook.xlsx.writeFile(filePath);
  return { success: true, filePath: filePath };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
