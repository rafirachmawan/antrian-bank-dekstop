// FILE: main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ✅ INI TAMBAHKAN (sesuai kode kamu)
const fixedUserData = path.join(app.getPath("appData"), "antrian-bank-desktop");
app.setPath("userData", fixedUserData);

const {
  initDb,
  getDisplayConfig,
  setDisplayConfig,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
  // ✅ dari db.js kamu (penting untuk pemanggilan via IPC)
  callNext,
  getState,
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

/**
 * ✅ Inject config ke renderer (tetap)
 * ✅ Tambahan: inject window.kioskPrinter.printTicket() (untuk silent thermal print)
 */
function injectConfig(win, { apiBase, branchName }) {
  if (!win || win.isDestroyed()) return;

  const script = `
    window.queueConfig = {
      apiBase: ${JSON.stringify(apiBase)},
      branchName: ${JSON.stringify(branchName)}
    };

    try {
      const { ipcRenderer } = require("electron");
      window.kioskPrinter = {
        printTicket: (payload) => ipcRenderer.invoke("PRINT_TICKET", payload)
      };
    } catch (e) {}
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

/* =========================================================
   ✅ Tambahan: thermal print window (hidden) + helper HTML
   ========================================================= */
let printWin = null;

function buildThermalReceiptHtml(payload) {
  const branch = (
    payload?.branch ||
    payload?.branchName ||
    DEFAULT_BRANCH
  ).toString();
  const layanan = (payload?.layanan || payload?.serviceType || "").toString();
  const ticket = (payload?.ticket || payload?.ticketCode || "").toString();
  const waktu = (payload?.waktu || "").toString();

  const safe = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Thermal Ticket</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; }
    body { width: 80mm; font-family: Arial, sans-serif; color: #000; }
    .wrap { padding: 10px 10px 12px; }
    .center { text-align: center; }
    .title { font-size: 14px; font-weight: 700; }
    .sub { font-size: 11px; margin-top: 2px; }
    .line { border-top: 1px dashed #000; margin: 10px 0; }
    .ticket { font-size: 42px; font-weight: 800; letter-spacing: 2px; margin: 6px 0; }
    .meta { font-size: 11px; line-height: 1.4; }
    .small { font-size: 10px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="center">
      <div class="title">${safe(branch)}</div>
      <div class="sub">KIOSK PENGAMBILAN NOMOR</div>
    </div>

    <div class="line"></div>

    <div class="center meta">
      <div><b>LAYANAN</b></div>
      <div>${safe(layanan)}</div>
    </div>

    <div class="center">
      <div class="sub" style="margin-top:10px;">NOMOR ANTRIAN</div>
      <div class="ticket">${safe(ticket)}</div>
    </div>

    <div class="line"></div>

    <div class="meta">
      <div><b>Waktu:</b> ${safe(waktu)}</div>
    </div>

    <div style="height:10px;"></div>

    <div class="center small">
      Simpan struk ini. Nomor dipanggil sesuai urutan pada layar.
      <br/>Terima kasih.
    </div>
  </div>
</body>
</html>
`;
}

/** helper: pastikan folder promo-images ada */
function ensurePromoImagesDir() {
  // ✅ samakan dengan server.js: userData/media/promo-images
  const dir = path.join(app.getPath("userData"), "media", "promo-images");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** helper: copy file image -> userData/promo-images, return filename */
function copyImageToPromoDir(filePath) {
  const dir = ensurePromoImagesDir();
  const ext = path.extname(filePath).toLowerCase() || ".jpg";
  const base = path
    .basename(filePath, ext)
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 40);
  const stamp = Date.now();
  const name = `${base}_${stamp}${ext}`;
  const target = path.join(dir, name);
  fs.copyFileSync(filePath, target);
  return name;
}

/** ✅ helper: normalisasi bentuk return config agar admin.html/display.html gampang */
function toRendererDisplayConfig(cfg) {
  return {
    promoText: cfg?.promoText || "",
    videoPath: cfg?.videoPath || null,
    promoImages: Array.isArray(cfg?.promoImages) ? cfg.promoImages : [],
    updatedAt: cfg?.updatedAt || null,
  };
}

/** ✅ REGISTER IPC (sekali saja) */
function registerIpcHandlers() {
  // ===== Display config (promo/video/slider) =====
  ipcMain.handle("display:getConfig", async () => {
    const cfg = await getDisplayConfig();
    return toRendererDisplayConfig(cfg);
  });

  ipcMain.handle("display:updatePromo", async (_evt, payload) => {
    const promoText = (payload?.promoText || "").toString();
    const next = await setDisplayConfig({ promo_text: promoText });
    return toRendererDisplayConfig(next);
  });

  // ✅ ini dipakai admin.html kamu (pilih video)
  ipcMain.handle("display:chooseVideo", async () => {
    const res = await dialog.showOpenDialog({
      title: "Pilih video promo (MP4)",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm"] },
      ],
    });
    if (res.canceled || !res.filePaths?.[0]) throw new Error("cancelled");

    const picked = res.filePaths[0];

    const videosDir = path.join(app.getPath("userData"), "videos");
    if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

    const target = path.join(
      videosDir,
      "promo" + path.extname(picked).toLowerCase()
    );
    fs.copyFileSync(picked, target);

    const next = await setDisplayConfig({ video_path: target });
    return toRendererDisplayConfig(next);
  });

  ipcMain.handle("display:clearVideo", async () => {
    const next = await setDisplayConfig({ video_path: null });
    return toRendererDisplayConfig(next);
  });

  // ✅✅✅ FIX: admin.html kamu memanggil "display:choosePromoImages"
  // jadi kita sediakan handler ini (alias) agar tombol gambar pasti respon.
  ipcMain.handle("display:choosePromoImages", async () => {
    const res = await dialog.showOpenDialog({
      title: "Pilih gambar slider (multiple)",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });

    // kalau cancel: tetap balikin config terbaru
    if (res.canceled || !res.filePaths?.length) {
      const cfg = await getDisplayConfig();
      return toRendererDisplayConfig(cfg);
    }

    const current = await getDisplayConfig();
    const currentList = Array.isArray(current?.promoImages)
      ? current.promoImages
      : [];

    const newNames = [];
    for (const p of res.filePaths) {
      try {
        const fname = copyImageToPromoDir(p);
        newNames.push(fname);
      } catch (e) {
        console.error("❌ copy slider image failed:", p, e);
      }
    }

    // gabung tanpa menghapus yg lama
    const merged = [...currentList, ...newNames].filter(Boolean);

    const next = await setDisplayConfig({ promo_images: merged });
    return toRendererDisplayConfig(next);
  });

  // ✅ FIX: admin.html kamu memanggil "display:updatePromoImages" saat hapus/clear
  ipcMain.handle("display:updatePromoImages", async (_evt, payload) => {
    const promoImages = payload?.promoImages;
    const next = await setDisplayConfig({ promo_images: promoImages });
    return toRendererDisplayConfig(next);
  });

  // ===== Admin =====
  ipcMain.handle("admin:getTodaySummary", async () => await getTodaySummary());
  ipcMain.handle("admin:getTodayCalls", async () => await getTodayCalls());
  ipcMain.handle("admin:clearTodayTickets", async () => {
    await clearTodayTickets();
    return true;
  });

  // ✅✅✅ FIX UTAMA: pemanggilan via IPC (fallback kalau server mati)
  ipcMain.handle("panel:callNext", async (_evt, payload) => {
    const serviceType = (payload?.serviceType || "").toString().toUpperCase();
    const counterName = (payload?.counterName || "").toString();
    const result = await callNext(serviceType, counterName);
    return result; // bisa null kalau tidak ada WAITING
  });

  // ✅ optional: ambil state via IPC
  ipcMain.handle("state:get", async () => {
    return await getState();
  });

  // =========================================================
  // ✅ PRINT TICKET (Silent Thermal Print)
  // =========================================================
  ipcMain.handle("PRINT_TICKET", async (_evt, payload) => {
    try {
      if (!printWin || printWin.isDestroyed()) {
        printWin = new BrowserWindow({
          show: false,
          width: 420,
          height: 680,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        printWin.on("closed", () => {
          printWin = null;
        });
      }

      const html = buildThermalReceiptHtml(payload);
      await printWin.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(html)
      );
      await new Promise((r) => setTimeout(r, 250));

      const deviceName =
        payload &&
        typeof payload.deviceName === "string" &&
        payload.deviceName.trim()
          ? payload.deviceName.trim()
          : "";

      return await new Promise((resolve) => {
        printWin.webContents.print(
          { silent: true, printBackground: true, deviceName },
          (success, errorType) => {
            if (!success)
              return resolve({ ok: false, error: errorType || "print_failed" });
            return resolve({ ok: true });
          }
        );
      });
    } catch (e) {
      console.error("❌ PRINT_TICKET error:", e);
      return { ok: false, error: String(e?.message || e) };
    }
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
  initDb();
  registerIpcHandlers();

  const mode = getAppMode();

  if (mode === "server-admin") {
    console.log("🌐 LAN IP:", getLocalIPv4());
  }

  const cfg = readConfig();

  // ===== SERVER + ADMIN =====
  if (mode === "server-admin") {
    // ✅ Tambahan aman: kirim userDataPath ke server agar media dir konsisten
    serverRef = createServer({
      port: cfg.serverPort,
      host: "0.0.0.0",
      userDataPath: app.getPath("userData"),
    });

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
