// FILE: main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { initDb } = require("./db");
const { createServer } = require("./server");

const DEFAULT_PORT = 3000;
const DEFAULT_BRANCH = "BANK ASTRO CABANG A";

/** mode dari env APP_MODE atau arg --mode= atau auto dari nama exe */
function getAppMode() {
  // 1) prioritas env
  const envMode = (process.env.APP_MODE || "").toLowerCase().trim();

  // 2) prioritas arg --mode=
  const argMode = process.argv.find((a) => a.startsWith("--mode="));
  const cliMode = (argMode ? argMode.split("=")[1] : "").toLowerCase().trim();

  // 3) auto dari nama exe (untuk hasil build dist)
  const exeName = path.basename(process.execPath).toLowerCase(); // contoh: antrian-server.exe

  let autoMode = "";
  if (exeName.includes("server")) autoMode = "server-admin";
  else if (exeName.includes("kiosk")) autoMode = "kiosk";
  else if (exeName.includes("operator")) autoMode = "operator";
  else if (exeName.includes("display")) autoMode = "display";
  else if (exeName.includes("admin")) autoMode = "admin";

  const mode = envMode || cliMode || autoMode || "kiosk";

  const allowed = ["server-admin", "kiosk", "operator", "display", "admin"];
  return allowed.includes(mode) ? mode : "kiosk";
}

/**
 * ✅ Config reader (DEV + BUILD) + Backward compatible
 *
 * Prioritas baca:
 * 1) userData/config.json   (untuk .exe install / produksi) ✅
 * 2) resources/config.json  (kalau kamu pakai extraResources) ✅
 * 3) root project config.json (untuk dev) ✅
 *
 * Format baru:
 * { apiBase, branchName, serverPort }
 *
 * Format lama:
 * { branchServerUrl, branchName, mode }
 */
function readConfig() {
  const userDataPath = app.getPath("userData");
  const pUserData = path.join(userDataPath, "config.json");

  const pResources = path.join(process.resourcesPath || "", "config.json");
  const pProject = path.join(__dirname, "config.json");

  const candidates = [pUserData, pResources, pProject];

  let raw = {};
  let usedPath = null;

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        usedPath = p;
        break;
      }
    } catch (e) {
      console.error("❌ Failed to read config.json at:", p, e);
    }
  }

  const apiBase = raw.apiBase || raw.branchServerUrl || null;
  const branchName = raw.branchName || DEFAULT_BRANCH;
  const serverPort = Number(raw.serverPort || DEFAULT_PORT);

  console.log("====================================================");
  console.log("✅ App Name:", app.getName());
  console.log("✅ Mode:", getAppMode());
  console.log("✅ Config used:", usedPath || "(none)");
  console.log("✅ userData:", userDataPath);
  console.log("✅ resourcesPath:", process.resourcesPath);
  console.log("✅ __dirname:", __dirname);
  console.log("====================================================");

  return {
    apiBase,
    branchName,
    serverPort,
    __usedPath: usedPath,
    __userDataPath: userDataPath,
  };
}

function injectConfig(win, { apiBase, branchName }) {
  if (!win || win.isDestroyed()) return;
  const script = `
    window.queueConfig = {
      apiBase: ${JSON.stringify(apiBase)},
      branchName: ${JSON.stringify(branchName)}
    };
  `;
  win.webContents.executeJavaScript(script).catch(() => {});
}

function createWindowByMode(mode, cfg) {
  let title = "Antrian";
  let file = "kiosk.html";
  let width = 500;
  let height = 700;

  if (mode === "server-admin") {
    title = "Server + Admin Panel";
    file = "admin.html";
    width = 1100;
    height = 750;
  } else if (mode === "admin") {
    title = "Admin Panel";
    file = "admin.html";
    width = 1100;
    height = 750;
  } else if (mode === "operator") {
    title = "Panel Teller & CS";
    file = "operator.html";
    width = 650;
    height = 780;
  } else if (mode === "display") {
    title = "Display Antrian";
    file = "display.html";
    width = 1280;
    height = 720;
  } else {
    title = "Kiosk Pengambilan Nomor";
    file = "kiosk.html";
    width = 500;
    height = 700;
  }

  const win = new BrowserWindow({
    width,
    height,
    title,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadFile(file);
  win.webContents.on("did-finish-load", () => injectConfig(win, cfg));
  return win;
}

function openSetupWindow(mode) {
  const win = new BrowserWindow({
    width: 880,
    height: 660,
    title: "Setup Cabang",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // kirim mode & appName via querystring
  win.loadFile("setup.html", {
    search: `?mode=${encodeURIComponent(mode)}&appName=${encodeURIComponent(
      app.getName()
    )}`,
  });

  return win;
}

/* =========================
   IPC: save config + relaunch
   ========================= */
ipcMain.handle("config:save", async (event, payload) => {
  try {
    const userDataPath = app.getPath("userData");
    const configPath = path.join(userDataPath, "config.json");

    if (!fs.existsSync(userDataPath))
      fs.mkdirSync(userDataPath, { recursive: true });

    // validasi minimal
    if (!payload?.branchName) throw new Error("branchName wajib");
    if (!payload?.serverPort) payload.serverPort = DEFAULT_PORT;

    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf-8");

    console.log("✅ Saved config:", configPath);
    return { ok: true, path: configPath };
  } catch (e) {
    console.error("❌ config:save error:", e);
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.on("app:reload", () => {
  try {
    app.relaunch();
    app.exit(0);
  } catch (e) {
    console.error("❌ reload error:", e);
  }
});

ipcMain.handle("config:test", async (event, { apiBase } = {}) => {
  // test koneksi server /health
  try {
    if (!apiBase) throw new Error("apiBase kosong");
    // Node 18+ ada fetch global, tapi untuk aman kita pakai dynamic import jika perlu
    const url = apiBase.replace(/\/$/, "") + "/health";

    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    if (!res.ok) throw new Error("HTTP " + res.status + " " + text);

    return { ok: true, status: res.status, body: text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* =========================
   App lifecycle
   ========================= */

let mainWin = null;
let serverRef = null;

app.whenReady().then(() => {
  const mode = getAppMode();
  const cfg = readConfig();

  // ===== SERVER + ADMIN =====
  if (mode === "server-admin") {
    initDb();
    serverRef = createServer({ port: cfg.serverPort });

    // server-admin selalu pakai localhost untuk UI admin di PC server
    const serverApiBase = `http://localhost:${cfg.serverPort}`;

    mainWin = createWindowByMode(mode, {
      ...cfg,
      apiBase: serverApiBase,
    });

    console.log("✅ MODE:", mode);
    console.log("✅ SERVER:", serverApiBase);
    return;
  }

  // ===== CLIENT ONLY (kiosk/operator/display/admin) =====
  if (!cfg.apiBase) {
    openSetupWindow(mode);
    return;
  }

  console.log("✅ MODE:", mode);
  console.log("✅ API BASE:", cfg.apiBase);

  mainWin = createWindowByMode(mode, cfg);
});

app.on("window-all-closed", () => {
  try {
    if (serverRef?.server) serverRef.server.close();
  } catch {}
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const mode = getAppMode();
    const cfg = readConfig();

    if (mode === "server-admin") {
      initDb();
      serverRef = createServer({ port: cfg.serverPort });
      const serverApiBase = `http://localhost:${cfg.serverPort}`;
      mainWin = createWindowByMode(mode, { ...cfg, apiBase: serverApiBase });
    } else {
      if (!cfg.apiBase) {
        openSetupWindow(mode);
        return;
      }
      mainWin = createWindowByMode(mode, cfg);
    }
  }
});
