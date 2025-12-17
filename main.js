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

/**
 * ✅ Inject config ke renderer (tetap)
 * ✅ Tambahan: inject window.kioskPrinter.printTicket() (untuk silent thermal print)
 *
 * Tidak mengubah logic lama, hanya menambah object baru.
 */
function injectConfig(win, { apiBase, branchName }) {
  if (!win || win.isDestroyed()) return;

  const script = `
    // ====== existing inject (tetap) ======
    window.queueConfig = {
      apiBase: ${JSON.stringify(apiBase)},
      branchName: ${JSON.stringify(branchName)}
    };

    // ====== tambahan (tanpa ubah logic lain) ======
    // Renderer bisa panggil: window.kioskPrinter.printTicket({ branch, layanan, ticket, waktu, deviceName? })
    try {
      const { ipcRenderer } = require("electron");
      window.kioskPrinter = {
        printTicket: (payload) => ipcRenderer.invoke("PRINT_TICKET", payload)
      };
    } catch (e) {
      // kalau require tidak tersedia (harusnya ada karena nodeIntegration=true)
      // tidak apa-apa, hanya berarti silent print tidak aktif
    }
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
    webPreferences: { nodeIntegration: true, contextIsolation: false }, // ✅ tetap seperti punya kamu
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
   Tidak mengubah logic lain
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

  // =========================================================
  // ✅ Tambahan: PRINT TICKET (Silent Thermal Print)
  // Channel: "PRINT_TICKET"
  // Renderer panggil: window.kioskPrinter.printTicket(payload)
  // =========================================================
  ipcMain.handle("PRINT_TICKET", async (_evt, payload) => {
    try {
      // buat window print hidden sekali, reuse
      if (!printWin || printWin.isDestroyed()) {
        printWin = new BrowserWindow({
          show: false,
          width: 420,
          height: 680,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        // optional: cegah window dibuka user
        printWin.on("closed", () => {
          printWin = null;
        });
      }

      const html = buildThermalReceiptHtml(payload);
      await printWin.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(html)
      );

      // tunggu render stabil sedikit
      await new Promise((r) => setTimeout(r, 250));

      // deviceName optional (kalau mau pilih printer tertentu)
      const deviceName =
        payload &&
        typeof payload.deviceName === "string" &&
        payload.deviceName.trim()
          ? payload.deviceName.trim()
          : "";

      return await new Promise((resolve) => {
        printWin.webContents.print(
          {
            silent: true, // ✅ TANPA dialog
            printBackground: true,
            deviceName, // "" = default printer
          },
          (success, errorType) => {
            if (!success) {
              console.error("❌ Print failed:", errorType);
              return resolve({ ok: false, error: errorType || "print_failed" });
            }
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
