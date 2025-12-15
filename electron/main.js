// FILE: electron/main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindows = [];

// baca config per PC
function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, "config.json");
    const raw = fs.readFileSync(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Gagal baca config.json, pakai default.", e);
    return {
      mode: "kiosk-display",
      branchName: "BANK ASTRO",
      branchServerUrl: "http://localhost:3000",
    };
  }
}

function createWindows() {
  const config = loadConfig();
  const mode = config.mode || "kiosk-display";

  // inject config ke global variable lewat query string sederhana
  const query =
    `?branchName=${encodeURIComponent(config.branchName)}` +
    `&api=${encodeURIComponent(config.branchServerUrl)}`;

  // ============ MODE: kiosk + display ============ //
  if (mode === "kiosk-display") {
    // KIOSK
    const kioskWin = new BrowserWindow({
      width: 480,
      height: 800,
      title: "Kiosk Pengambilan Nomor",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    kioskWin.loadFile(path.join(__dirname, "kiosk.html"), { search: query });

    // DISPLAY
    const displayWin = new BrowserWindow({
      width: 1280,
      height: 720,
      title: "Display Antrian",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    displayWin.loadFile(path.join(__dirname, "display.html"), {
      search: query,
    });

    mainWindows.push(kioskWin, displayWin);
  }

  // ============ MODE: operator (teller / CS) ============ //
  if (mode === "operator") {
    const operatorWin = new BrowserWindow({
      width: 700,
      height: 780,
      title: "Panel Teller & CS",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    operatorWin.loadFile(path.join(__dirname, "operator.html"), {
      search: query,
    });

    mainWindows.push(operatorWin);
  }

  // ============ MODE: admin ============ //
  if (mode === "admin") {
    const adminWin = new BrowserWindow({
      width: 900,
      height: 800,
      title: "Admin Panel Antrian",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });
    adminWin.loadFile(path.join(__dirname, "admin.html"), { search: query });

    mainWindows.push(adminWin);
  }
}

app.whenReady().then(() => {
  createWindows();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
