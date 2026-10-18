const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const XLSX = require('xlsx');

let mainWindow;
let viewerWindow = null;
let sseClients = [];
const SERVER_PORT = 3000;

const dbPath = path.join(app.getPath('userData'), 'database-klinik-dewi-anjadi.json');

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
      return defaultData;
    }
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    if (!parsed.settings.videoPlaylist || !Array.isArray(parsed.settings.videoPlaylist)) {
      parsed.settings.videoPlaylist = defaultData.settings.videoPlaylist;
    }
    if (!parsed.settings.clinicPhone) {
      parsed.settings.clinicPhone = defaultData.settings.clinicPhone;
    }
    return parsed;
  } catch (err) {
    return defaultData;
  }
}

function broadcastToNetworkTV(eventType, payload) {
  const message = `data: ${JSON.stringify({ type: eventType, payload })}\n\n`;
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
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses.length > 0 ? addresses : [{ name: 'Localhost', address: '127.0.0.1' }];
}

function startNetworkTVServer() {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);

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

    if (reqUrl.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify({ type: 'db-updated', payload: loadDatabase() })}\n\n`);
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
        const file = fs.createReadStream(videoPath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
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

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`Server Layar TV aktif di port ${SERVER_PORT}`);
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
  return { canceled: false, filePaths };
});

ipcMain.handle('get-network-info', () => {
  const ips = getLocalIPAddresses();
  return {
    port: SERVER_PORT,
    urls: ips.map(item => ({
      name: item.name,
      url: `http://${item.address}:${SERVER_PORT}/tv`
    }))
  };
});

ipcMain.on('broadcast-voice-call', (event, voiceData) => {
  broadcastToNetworkTV('voice-call', voiceData);
});

ipcMain.on('open-viewer-window', () => {
  createViewerWindow();
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
    { 'No': '', 'Tanggal': '@copyright iman.mn_', 'Keterangan Transaksi': `${db.settings.clinicName} - Telp: ${db.settings.clinicPhone}` }
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
    { 'No': '', 'Tanggal': '@copyright iman.mn_', 'Nama Obat': `${db.settings.clinicName} - Telp: ${db.settings.clinicPhone}` }
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

  const defaultFileName = `Laporan_${isWeekly ? 'Mingguan' : 'Bulanan'}_Klinik_Bidan_Dewi_Anjadi_${new Date().toISOString().slice(0, 10)}.xlsx`;

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: `Simpan Laporan ${isWeekly ? 'Mingguan' : 'Bulanan'} (.xlsx)`,
    defaultPath: defaultFileName,
    filters: [{ name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] }]
  });

  if (canceled || !filePath) return { success: false };
  XLSX.writeFile(wb, filePath);
  return { success: true, filePath };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
