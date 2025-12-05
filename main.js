// FILE: main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { initDb, takeTicket, callNext, getState } = require("./db");

let windows = {
  display: null,
  kiosk: null,
  operator: null,
};

function createWindows() {
  // MONITOR CUSTOMER
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
  createWindows();

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

  // Dipanggil oleh DISPLAY/OPERATOR saat pertama kali load
  ipcMain.handle("queue:getState", () => {
    return getState();
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
