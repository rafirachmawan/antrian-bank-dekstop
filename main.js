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
const BRANCH_NAME = "BANK ASTRO CABANG A";

// ✅ MODE bisa dari env (build) atau argumen runtime
function getAppMode() {
  const envMode = process.env.APP_MODE;
  const argMode = process.argv.find((a) => a.startsWith("--mode="));
  const mode = (envMode || (argMode ? argMode.split("=")[1] : "") || "kiosk")
    .toLowerCase()
    .trim();
  return mode; // display | kiosk | operator | admin
}

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

// ✅ hanya buat 1 window sesuai mode
function createWindowByMode(mode) {
  // helper: tutup window lain (biar aman)
  for (const key of Object.keys(windows)) {
    if (windows[key] && !windows[key].isDestroyed()) {
      windows[key].close();
      windows[key] = null;
    }
  }

  if (mode === "display") {
    windows.display = new BrowserWindow({
      width: 1280,
      height: 720,
      title: "Display Antrian",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    windows.display.loadFile("display.html");
    windows.display.webContents.on("did-finish-load", () =>
      injectConfig(windows.display)
    );
    return;
  }

  if (mode === "operator") {
    windows.operator = new BrowserWindow({
      width: 650,
      height: 780,
      title: "Panel Teller & CS",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    windows.operator.loadFile("operator.html");
    windows.operator.webContents.on("did-finish-load", () =>
      injectConfig(windows.operator)
    );
    return;
  }

  if (mode === "admin") {
    windows.admin = new BrowserWindow({
      width: 1100,
      height: 750,
      title: "Admin Panel",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    windows.admin.loadFile("admin.html");
    windows.admin.webContents.on("did-finish-load", () =>
      injectConfig(windows.admin)
    );
    return;
  }

  // default: kiosk
  windows.kiosk = new BrowserWindow({
    width: 500,
    height: 700,
    title: "Kiosk Pengambilan Nomor",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  windows.kiosk.loadFile("kiosk.html");
  windows.kiosk.webContents.on("did-finish-load", () =>
    injectConfig(windows.kiosk)
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

  // ✅ server tetap jalan (kalau di PC itu memang dibutuhkan)
  createServer({ port: QUEUE_SERVER_PORT });

  const mode = getAppMode();
  createWindowByMode(mode);

  ipcMain.handle("queue:takeTicket", (event, serviceType) => {
    const ticket = takeTicket(serviceType);
    broadcastState();
    return ticket;
  });

  ipcMain.handle("queue:callNext", (event, { serviceType, counterName }) => {
    const result = callNext(serviceType, counterName);
    broadcastState();
    return result;
  });

  ipcMain.handle("queue:getState", () => getState());

  ipcMain.handle("admin:getTodaySummary", () => getTodaySummary());
  ipcMain.handle("admin:getTodayCalls", () => getTodayCalls());
  ipcMain.handle("admin:clearTodayTickets", () => {
    clearTodayTickets();
    broadcastState();
    return { ok: true };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const mode = getAppMode();
      createWindowByMode(mode);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
