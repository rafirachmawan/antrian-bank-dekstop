// FILE: main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const { initDb } = require("./db");
const { createServer } = require("./server");

const DEFAULT_PORT = 3000;
const DEFAULT_BRANCH = "BANK ASTRO CABANG A";

/** mode dari env APP_MODE atau arg --mode= */
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
 * 1) userData/config.json   (untuk .exe install / produksi)  ✅
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

  // urutan paling aman:
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
      // kalau file ada tapi JSON invalid
      console.error("❌ Failed to read config.json at:", p, e);
    }
  }

  const apiBase = raw.apiBase || raw.branchServerUrl || null;
  const branchName = raw.branchName || DEFAULT_BRANCH;
  const serverPort = Number(raw.serverPort || DEFAULT_PORT);

  console.log("✅ Config used:", usedPath || "(none)");
  console.log("✅ userData:", userDataPath);
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
        <p style="color:#666;margin-top:6px;">
          Buat file <b>config.json</b> di folder itu (kalau belum ada), lalu isi seperti contoh di bawah.
        </p>

        <h3>Format baru (disarankan)</h3>
        <pre style="background:#f4f4f4; padding:12px; border-radius:8px; overflow:auto;">
{
  "apiBase": "http://192.168.4.105:3000",
  "branchName": "BANK ASTRO - CABANG A"
}
        </pre>

        <h3>Format lama (masih didukung)</h3>
        <pre style="background:#f4f4f4; padding:12px; border-radius:8px; overflow:auto;">
{
  "branchServerUrl": "http://192.168.4.105:3000",
  "branchName": "BANK ASTRO - CABANG A"
}
        </pre>

        <hr style="margin:18px 0;" />
        <p style="color:#666;">
          Tips: Pastikan server bisa diakses dari PC ini, coba buka:
          <br/>
          <code>http://IP-SERVER:3000/health</code>
        </p>
      </body>
    </html>
  `;

  errorWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return errorWin;
}

let mainWin = null;
let serverRef = null;

app.whenReady().then(() => {
  const mode = getAppMode();
  const cfg = readConfig();

  // ===== SERVER + ADMIN =====
  if (mode === "server-admin") {
    initDb();
    serverRef = createServer({ port: cfg.serverPort });

    // server-admin selalu pakai localhost
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
        openConfigErrorWindow(mode, cfg);
        return;
      }
      mainWin = createWindowByMode(mode, cfg);
    }
  }
});
