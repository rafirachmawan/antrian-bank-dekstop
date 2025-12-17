// FILE: main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ✅ INI TAMBAHKAN
const fixedUserData = path.join(app.getPath("appData"), "antrian-bank-desktop");
app.setPath("userData", fixedUserData);

const {
  initDb,
  getDisplayConfig,
  setDisplayConfig,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
} = require("./db");

const { createServer } = require("./server");

const DEFAULT_PORT = 3000;
const DEFAULT_BRANCH = "BANK ASTRO CABANG A";

/** cari IP lokal (untuk info server) */
function getLocalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

/** mode dari env APP_MODE atau arg --mode= atau nama exe */
function getAppMode() {
  const envMode = (process.env.APP_MODE || "").toLowerCase().trim();
  const argMode = process.argv.find((a) => a.startsWith("--mode="));
  const cliMode = (argMode ? argMode.split("=")[1] : "").toLowerCase().trim();
  const exeName = path.basename(process.execPath).toLowerCase();

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
 * Config reader (DEV + BUILD)
 * Prioritas:
 * 1) userData/config.json
 * 2) resources/config.json (extraResources)
 * 3) project root config.json
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

  console.log("✅ App Name:", app.getName());
  console.log("✅ Mode:", getAppMode());
  console.log("✅ Config used:", usedPath || "(none)");
  console.log("✅ userData:", userDataPath);
  console.log("✅ resourcesPath:", process.resourcesPath);
  console.log("✅ __dirname:", __dirname);

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

function openConfigErrorWindow(mode, cfg) {
  const userDataPath = cfg.__userDataPath || app.getPath("userData");
  const configPath = path.join(userDataPath, "config.json");

  const errorWin = new BrowserWindow({
    width: 820,
    height: 520,
    title: "Config Error",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const html = `
    <html>
      <body style="font-family: Arial; padding: 22px; line-height: 1.5;">
        <h2 style="margin-top:0;">❌ config.json belum lengkap</h2>
        <p>Mode <b>${mode}</b> butuh alamat server cabang (<code>apiBase</code>).</p>

        <h3>📌 Lokasi config yang dipakai (disarankan)</h3>
        <div style="background:#f4f4f4;padding:12px;border-radius:8px;">
          <code>${configPath}</code>
        </div>

        <h3>Format baru (disarankan)</h3>
        <pre style="background:#f4f4f4; padding:12px; border-radius:8px; overflow:auto;">
{
  "apiBase": "http://192.168.4.106:3000",
  "branchName": "BANK ASTRO - CABANG A"
}
        </pre>

        <h3>Tips</h3>
        <p style="color:#666;">
          Coba buka: <code>http://IP-SERVER:3000/health</code>
        </p>
      </body>
    </html>
  `;

  errorWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return errorWin;
}

/** ✅ REGISTER IPC (sekali saja) */
function registerIpcHandlers() {
  // ===== Display config (promo/video) =====
  ipcMain.handle("display:getConfig", async () => {
    // db return: { promo_text, video_path }
    const cfg = await getDisplayConfig();
    // biar cocok dengan display.html yang pakai promoText/videoPath
    return {
      promoText: cfg?.promo_text || "",
      videoPath: cfg?.video_path || null,
    };
  });

  ipcMain.handle("display:updatePromo", async (_evt, payload) => {
    const promoText = (payload?.promoText || "").toString();
    const next = await setDisplayConfig({ promo_text: promoText });
    return {
      promoText: next?.promo_text || "",
      videoPath: next?.video_path || null,
    };
  });

  ipcMain.handle("display:chooseVideo", async () => {
    const res = await dialog.showOpenDialog({
      title: "Pilih video promo (MP4)",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm"] },
      ],
    });

    if (res.canceled || !res.filePaths?.[0]) {
      throw new Error("cancelled");
    }

    const picked = res.filePaths[0];

    // Copy ke folder userData biar aman (nggak tergantung path random)
    const videosDir = path.join(app.getPath("userData"), "videos");
    if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

    const target = path.join(
      videosDir,
      "promo" + path.extname(picked).toLowerCase()
    );
    fs.copyFileSync(picked, target);

    const next = await setDisplayConfig({ video_path: target });
    return {
      promoText: next?.promo_text || "",
      videoPath: next?.video_path || null,
    };
  });

  ipcMain.handle("display:clearVideo", async () => {
    const next = await setDisplayConfig({ video_path: null });
    return {
      promoText: next?.promo_text || "",
      videoPath: next?.video_path || null,
    };
  });

  // ===== Admin panel summary/calls/clear =====
  ipcMain.handle("admin:getTodaySummary", async () => {
    return await getTodaySummary();
  });

  ipcMain.handle("admin:getTodayCalls", async () => {
    return await getTodayCalls();
  });

  ipcMain.handle("admin:clearTodayTickets", async () => {
    await clearTodayTickets();
    return true;
  });
}

let mainWin = null;
let serverRef = null;

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch(
  "disk-cache-dir",
  path.join(app.getPath("userData"), "cache")
);

app.whenReady().then(() => {
  // ✅ DB siap untuk semua mode
  initDb();

  // ✅ IPC handler (sekali)
  registerIpcHandlers();

  const mode = getAppMode();

  // Optional: print ip server biar gampang config device lain
  if (mode === "server-admin") {
    console.log("🌐 LAN IP:", getLocalIPv4());
  }

  const cfg = readConfig();

  // ===== SERVER + ADMIN =====
  if (mode === "server-admin") {
    // server bind 0.0.0.0 biar bisa diakses PC lain
    serverRef = createServer({ port: cfg.serverPort, host: "0.0.0.0" });

    const ip = getLocalIPv4();
    const serverApiBase = `http://localhost:${cfg.serverPort}`;

    console.log("✅ MODE:", mode);
    console.log("✅ SERVER LOCAL:", serverApiBase);
    console.log("✅ SERVER LAN  :", `http://${ip}:${cfg.serverPort}`);

    mainWin = createWindowByMode(mode, { ...cfg, apiBase: serverApiBase });
    return;
  }

  // ===== CLIENT ONLY =====
  if (!cfg.apiBase) {
    openConfigErrorWindow(mode, cfg);
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
