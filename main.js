// FILE: main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const {
  initDb,
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
} = require("./db");
const { createServer } = require("./server");

let windows = {
  display: null,
  kiosk: null,
  operator: null,
  admin: null,
};

const QUEUE_SERVER_PORT = 3000;
// kalau mau dipasang nama cabang
const BRANCH_NAME = "BANK ASTRO CABANG A";

function injectConfig(win) {
  if (!win || win.isDestroyed()) return;
  const apiBase = `http://localhost:${QUEUE_SERVER_PORT}`;
  const script = `
    window.queueConfig = {
      apiBase: ${JSON.stringify(apiBase)},
      branchName: ${JSON.stringify(BRANCH_NAME)}
    };
  `;
  win.webContents.executeJavaScript(script).catch(() => {});
}

function createWindows() {
  // DISPLAY (monitor ruang tunggu)
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
  windows.display.webContents.on("did-finish-load", () =>
    injectConfig(windows.display)
  );

  // KIOSK (ambil nomor) - PC kiosk
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
  windows.kiosk.webContents.on("did-finish-load", () =>
    injectConfig(windows.kiosk)
  );

  // OPERATOR (teller/cs) - PC teller/cs
  windows.operator = new BrowserWindow({
    width: 650,
    height: 780,
    title: "Panel Teller & CS",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.operator.loadFile("operator.html");
  windows.operator.webContents.on("did-finish-load", () =>
    injectConfig(windows.operator)
  );

  // ADMIN PANEL (opsional: komputer supervisor)
  windows.admin = new BrowserWindow({
    width: 1100,
    height: 750,
    title: "Admin Panel",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  windows.admin.loadFile("admin.html");
  windows.admin.webContents.on("did-finish-load", () =>
    injectConfig(windows.admin)
  );
}

function broadcastState() {
  const state = getState();
  for (const win of Object.values(windows)) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("queue:state", state);
    }
  }
}

app.whenReady().then(() => {
  initDb();

  // ✅ start server cabang (untuk admin/client pc lain)
  createServer({ port: QUEUE_SERVER_PORT });

  createWindows();

  // Ambil nomor dari KIOSK (IPC mode)
  ipcMain.handle("queue:takeTicket", (event, serviceType) => {
    const ticket = takeTicket(serviceType);
    broadcastState();
    return ticket;
  });

  // Panggil nomor dari OPERATOR (IPC mode)
  ipcMain.handle("queue:callNext", (event, { serviceType, counterName }) => {
    const result = callNext(serviceType, counterName);
    broadcastState();
    return result; // bisa null kalau antrian kosong
  });

  // Dipanggil oleh DISPLAY/OPERATOR saat pertama kali load
  ipcMain.handle("queue:getState", () => {
    return getState();
  });

  // ====== ADMIN IPC (fallback) ======
  ipcMain.handle("admin:getTodaySummary", () => {
    return getTodaySummary();
  });

  ipcMain.handle("admin:getTodayCalls", () => {
    return getTodayCalls();
  });

  ipcMain.handle("admin:clearTodayTickets", () => {
    clearTodayTickets();
    broadcastState();
    return { ok: true };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
