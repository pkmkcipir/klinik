const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const XLSX = require('xlsx');

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
// 1. Primary: Microsoft Edge Neural TTS (id-ID-GadisNeural & id-ID-ArdiNeural)
// 2. Fallback: Google Indonesian Neural TTS (tl=id)
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

  // 1. Cek cache lokal Edge Neural terlebih dahulu (instan & bisa offline)
  if (fs.existsSync(edgeCacheFile)) {
    const buf = fs.readFileSync(edgeCacheFile);
    return {
      success: true,
      engine: 'edge-neural',
      voiceName: cleanGender === 'male' ? 'Ardi (Laki-laki Indonesia)' : 'Gadis (Perempuan Indonesia)',
      audioBase64: buf.toString('base64')
    };
  }

  // 2. Coba ambil suara manusia asli dari Microsoft Edge Neural TTS (id-ID-GadisNeural / id-ID-ArdiNeural)
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
    // 3. Fallback otomatis ke Google Indonesian Neural TTS (tl=id)
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

    // Endpoint TTS Bahasa Indonesia untuk Smart TV via Wi-Fi / LAN
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

ipcMain.handle('export-excel', async (event, { period }) => {
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
  const sheetKeuanganData = filteredFinances.map((f, idx) => {
    if (f.tipe === 'MASUK') totalMasuk += Number(f.nominal);
    else totalKeluar += Number(f.nominal);
    return {
      'No': idx + 1,
      'Tanggal': new Date(f.date).toLocaleDateString('id-ID'),
      'Keterangan Transaksi': f.ket,
      'Tipe': f.tipe,
      'Periode': labelPeriode,
      'Nominal (Rp)': Number(f.nominal)
    };
  });

  sheetKeuanganData.push(
    {},
    { 'No': '', 'Tanggal': '', 'Keterangan Transaksi': 'TOTAL PEMASUKAN (MASUK)', 'Tipe': 'MASUK', 'Periode': labelPeriode, 'Nominal (Rp)': totalMasuk },
    { 'No': '', 'Tanggal': '', 'Keterangan Transaksi': 'TOTAL PENGELUARAN (KELUAR)', 'Tipe': 'KELUAR', 'Periode': labelPeriode, 'Nominal (Rp)': totalKeluar },
    { 'No': '', 'Tanggal': '', 'Keterangan Transaksi': 'SALDO BERSIH (SURPLUS/DEFISIT)', 'Tipe': 'NET', 'Periode': labelPeriode, 'Nominal (Rp)': totalMasuk - totalKeluar },
    { 'No': '', 'Tanggal': '@copyright iman.mn_', 'Keterangan Transaksi': db.settings.clinicName + ' - Telp: ' + db.settings.clinicPhone }
  );

  let totalObatMasuk = 0, totalObatKeluar = 0;
  const sheetObatData = filteredMedicines.map((m, idx) => {
    if (m.status === 'MASUK') totalObatMasuk += Number(m.jumlah);
    else totalObatKeluar += Number(m.jumlah);
    return {
      'No': idx + 1,
      'Tanggal': new Date(m.date).toLocaleDateString('id-ID'),
      'Nama Obat': m.nama,
      'Status Mutasi': m.status,
      'Periode': labelPeriode,
      'Jumlah (Unit)': Number(m.jumlah)
    };
  });

  sheetObatData.push(
    {},
    { 'No': '', 'Tanggal': '', 'Nama Obat': 'TOTAL OBAT MASUK', 'Status Mutasi': 'MASUK', 'Periode': labelPeriode, 'Jumlah (Unit)': totalObatMasuk },
    { 'No': '', 'Tanggal': '', 'Nama Obat': 'TOTAL OBAT KELUAR (RESEP)', 'Status Mutasi': 'KELUAR', 'Periode': labelPeriode, 'Jumlah (Unit)': totalObatKeluar },
    { 'No': '', 'Tanggal': '@copyright iman.mn_', 'Nama Obat': db.settings.clinicName + ' - Telp: ' + db.settings.clinicPhone }
  );

  const sheetPasienData = filteredPatients.map((p, idx) => ({
    'No': idx + 1,
    'Tanggal Kunjungan': new Date(p.date).toLocaleDateString('id-ID'),
    'NIK / No. BPJS': p.nik,
    'Nama Pasien': p.nama,
    'Usia (Tahun)': Number(p.umur),
    'Poli Tujuan': p.poli,
    'Keluhan / Diagnosa': p.keluhan
  }));

  const wb = XLSX.utils.book_new();
  const wsRingkasan = XLSX.utils.json_to_sheet([
    { 'Indikator Laporan': 'Nama Klinik', 'Nilai': db.settings.clinicName },
    { 'Indikator Laporan': 'Alamat Klinik', 'Nilai': db.settings.clinicAddress },
    { 'Indikator Laporan': 'No. Telepon', 'Nilai': db.settings.clinicPhone },
    { 'Indikator Laporan': 'Poli Layanan', 'Nilai': 'POLI KANDUNGAN (POLI OBGYN)' },
    { 'Indikator Laporan': 'Periode Laporan', 'Nilai': labelPeriode },
    { 'Indikator Laporan': 'Tanggal Cetak', 'Nilai': new Date().toLocaleString('id-ID') },
    { 'Indikator Laporan': 'Total Pemasukan (Rp)', 'Nilai': totalMasuk },
    { 'Indikator Laporan': 'Total Pengeluaran (Rp)', 'Nilai': totalKeluar },
    { 'Indikator Laporan': 'Saldo Kas Bersih (Rp)', 'Nilai': totalMasuk - totalKeluar },
    { 'Indikator Laporan': 'Total Obat Masuk (Unit)', 'Nilai': totalObatMasuk },
    { 'Indikator Laporan': 'Total Obat Keluar (Unit)', 'Nilai': totalObatKeluar },
    { 'Indikator Laporan': 'Total Kunjungan Pasien', 'Nilai': filteredPatients.length },
    { 'Indikator Laporan': 'Watermark Lisensi', 'Nilai': '@copyright iman.mn_' }
  ]);

  XLSX.utils.book_append_sheet(wb, wsRingkasan, 'Ringkasan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetKeuanganData), 'Laporan Keuangan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetObatData), 'Laporan Obat');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetPasienData), 'Data Pasien');

  const defaultFileName = 'Laporan_' + (isWeekly ? 'Mingguan' : 'Bulanan') + '_Klinik_Bidan_Dewi_Anjani_' + new Date().toISOString().slice(0, 10) + '.xlsx';

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Simpan Laporan ' + (isWeekly ? 'Mingguan' : 'Bulanan') + ' (.xlsx)',
    defaultPath: defaultFileName,
    filters: [{ name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] }]
  });

  if (canceled || !filePath) return { success: false };
  XLSX.writeFile(wb, filePath);
  return { success: true, filePath: filePath };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
