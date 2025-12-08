// FILE: main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const {
  initDb,
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
} = require("./db");

let windows = {
  display: null,
  kiosk: null,
  operator: null,
  admin: null,
};

// =============================
//  CONFIG PROMO & VIDEO
// =============================
let dataDir;
let videosDir;
let configPath;

function initConfigPaths() {
  const userData = app.getPath("userData");
  dataDir = path.join(userData, "astro-queue-data");
  videosDir = path.join(dataDir, "videos");
  configPath = path.join(dataDir, "config.json");

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
}

function loadDisplayConfig() {
  try {
    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        promoText:
          "Buka rekening baru hari ini, nikmati bebas biaya admin 6 bulan pertama.",
        videoPath: null, // default: pakai bank-promo.mp4 di display.html
      };
      fs.writeFileSync(
        configPath,
        JSON.stringify(defaultConfig, null, 2),
        "utf-8"
      );
      return defaultConfig;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Gagal load config display:", e);
    return {
      promoText:
        "Buka rekening baru hari ini, nikmati bebas biaya admin 6 bulan pertama.",
      videoPath: null,
    };
  }
}

function saveDisplayConfig(partial) {
  const current = loadDisplayConfig();
  const next = { ...current, ...partial };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

// =============================
//  WINDOW
// =============================

function createWindows() {
  // MONITOR CUSTOMER (DISPLAY)
  windows.display = new BrowserWindow({
    width: 1280,
    height: 720,
    title: "Display Antrian",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.display.loadFile("display.html");

  // KIOSK (AMBIL NOMOR)
  windows.kiosk = new BrowserWindow({
    width: 500,
    height: 700,
    title: "Kiosk Pengambilan Nomor",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.kiosk.loadFile("kiosk.html");

  // OPERATOR (TELLER & CS)
  windows.operator = new BrowserWindow({
    width: 600,
    height: 750,
    title: "Panel Teller & CS",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.operator.loadFile("operator.html");

  // ADMIN PANEL
  windows.admin = new BrowserWindow({
    width: 900,
    height: 650,
    title: "Admin Panel - Antrian Bank Astro",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.admin.loadFile("admin.html");
}

function broadcastState() {
  const state = getState();
  for (const win of Object.values(windows)) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("queue:state", state);
    }
  }
}

// =============================
//  APP READY
// =============================
app.whenReady().then(() => {
  initDb();
  initConfigPaths();
  createWindows();

  // ========= IPC ANTRIAN =========

  // Ambil nomor dari KIOSK
  ipcMain.handle("queue:takeTicket", (event, serviceType) => {
    const ticket = takeTicket(serviceType);
    broadcastState();
    return ticket;
  });

  // Panggil nomor dari OPERATOR
  ipcMain.handle("queue:callNext", (event, { serviceType, counterName }) => {
    const result = callNext(serviceType, counterName);
    broadcastState();
    return result; // bisa null kalau antrian kosong
  });

  // Dipanggil oleh DISPLAY/OPERATOR/ADMIN saat pertama kali load
  ipcMain.handle("queue:getState", () => {
    return getState();
  });

  // ========= IPC DISPLAY (PROMO & VIDEO) =========

  // Ambil config promo + video
  ipcMain.handle("display:getConfig", () => {
    return loadDisplayConfig();
  });

  // Update teks promo
  ipcMain.handle("display:updatePromo", (event, { promoText }) => {
    const next = saveDisplayConfig({ promoText: promoText || "" });
    return next;
  });

  // Pilih / upload video promo
  ipcMain.handle("display:chooseVideo", async () => {
    const result = await dialog.showOpenDialog({
      title: "Pilih Video Promo",
      filters: [
        { name: "Video Files", extensions: ["mp4", "webm", "mov", "avi"] },
      ],
      properties: ["openFile"],
    });

    if (result.canceled || !result.filePaths.length) {
      // tidak ada perubahan
      return loadDisplayConfig();
    }

    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath);
    const fileName = `promo_${Date.now()}${ext}`;
    const destPath = path.join(videosDir, fileName);

    try {
      fs.copyFileSync(srcPath, destPath);
      const next = saveDisplayConfig({ videoPath: destPath });
      return next;
    } catch (e) {
      console.error("Gagal copy video promo:", e);
      return loadDisplayConfig();
    }
  });

  // ========= IPC ADMIN PANEL =========

  // Ringkasan antrian hari ini
  ipcMain.handle("admin:getTodaySummary", () => {
    return getTodaySummary();
  });

  // Riwayat panggilan hari ini
  ipcMain.handle("admin:getTodayCalls", () => {
    return getTodayCalls();
  });

  // Reset tiket hari ini
  ipcMain.handle("admin:resetTodayTickets", () => {
    clearTodayTickets();
    // setelah reset, update state di semua window
    broadcastState();
    return { success: true };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
