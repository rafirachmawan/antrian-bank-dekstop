// FILE: server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const os = require("os");
const { spawn } = require("child_process");

const {
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
  getDisplayConfig,
  setDisplayConfig,
  getUserDataPathSafe,
} = require("./db");

function safeMkdir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sanitizeFileName(name) {
  return String(name || "file")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}
function extOf(original) {
  const e = path.extname(original || "").toLowerCase();
  return e && e.length <= 10 ? e : "";
}

// =========================================================
// ✅ SIMPLE TTS VIA PYTHON (cewek Indonesia)
// - Display.html tetap panggil: /api/tts?text=...
// - Server generate mp3 via: python tts.py "text" "output.mp3"
// - Response: audio/mpeg (BUKAN JSON)
// =========================================================
function runPythonTts({ pythonCmd, scriptPath, text, outFile }) {
  return new Promise((resolve, reject) => {
    const args = [scriptPath, text, outFile];

    const p = spawn(pythonCmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) return resolve({ ok: true, out });
      reject(new Error(`python exit ${code}. ${err || out}`));
    });
  });
}

// ==============================
// ✅ AUTO RESET HARIAN (SERVER-SIDE)
// - Simpan meta terakhir reset di file JSON kecil (tidak ganggu db.js)
// - Saat tanggal ganti: clearTodayTickets() otomatis
// ==============================
function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymdNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJsonSafe(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj || {}, null, 2), "utf8");
  } catch {}
}

// ==============================
// ✅ BUNDLE AUDIO -> COPY KE userData (sekali saja)
// - Kamu taruh audio di: projectRoot/assets/audio/*.wav
// - Saat server start: auto copy ke: <userData>/media/audio/
// - PC lain install: audio ikut karena dari assets
// ==============================
function copyAudioIfMissing(srcDir, destDir) {
  try {
    if (!fs.existsSync(srcDir)) return;
    safeMkdir(destDir);

    const files = fs.readdirSync(srcDir);
    for (const f of files) {
      const src = path.join(srcDir, f);
      const dst = path.join(destDir, f);

      try {
        const st = fs.statSync(src);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }

      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
  } catch {}
}

/**
 * createServer({ port, host, userDataPath })
 * ✅ userDataPath dipakai supaya folder media selalu konsisten dengan Electron (app.getPath('userData'))
 */
function createServer({ port = 3000, host = "0.0.0.0", userDataPath } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "20mb" }));

  // ✅ media folders di PC SERVER (konsisten)
  const baseDir =
    (userDataPath && String(userDataPath)) ||
    (getUserDataPathSafe ? getUserDataPathSafe() : process.cwd());

  const mediaRoot = path.join(baseDir, "media");
  const videoDir = path.join(mediaRoot, "promo-video");
  const imagesDir = path.join(mediaRoot, "promo-images");
  safeMkdir(videoDir);
  safeMkdir(imagesDir);

  // ✅ AUDIO (bundled -> userData)
  const audioDir = path.join(mediaRoot, "audio");
  safeMkdir(audioDir);

  // sumber audio bundling (taruh file wav kamu di sini)
  const bundledAudioDir = path.join(__dirname, "assets", "audio");
  copyAudioIfMissing(bundledAudioDir, audioDir);

  // serve audio agar bisa dipakai display/admin/kiosk
  app.use(
    "/media/audio",
    express.static(audioDir, {
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    })
  );

  // ✅ folder cache untuk hasil mp3 tts (biar rapi)
  const ttsDir = path.join(mediaRoot, "tts-cache");
  safeMkdir(ttsDir);

  // ✅ file meta reset harian (disimpan di baseDir biar konsisten)
  const dailyResetMetaPath = path.join(baseDir, "daily-reset-meta.json");

  // ✅ lock biar tidak dobel reset kalau request barengan
  let resetInFlight = null;

  async function ensureDailyReset() {
    if (resetInFlight) return resetInFlight;

    const today = ymdNow();
    const meta = readJsonSafe(dailyResetMetaPath) || {};
    const last = String(meta.lastResetYMD || "");

    if (last === today) return;

    resetInFlight = (async () => {
      try {
        await clearTodayTickets();
        writeJsonSafe(dailyResetMetaPath, {
          lastResetYMD: today,
          resetAt: new Date().toISOString(),
        });
      } finally {
        resetInFlight = null;
      }
    })();

    return resetInFlight;
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        if (req.path.includes("upload-video")) return cb(null, videoDir);
        return cb(null, imagesDir);
      },
      filename: (req, file, cb) => {
        const base = sanitizeFileName(
          path.basename(file.originalname, path.extname(file.originalname))
        );
        const ext = extOf(file.originalname) || ".bin";
        cb(null, `${base}__${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  });

  // =========================
  // ✅ HEALTH CHECK
  // =========================
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "queue-server",
      time: new Date().toISOString(),
    });
  });

  /* =========================================================
     ✅ TTS ENDPOINT (buat display.html)
     - GET /api/tts?text=...&voice=...&format=mp3
     - alias: /tts
     - Output: AUDIO (audio/mpeg)
  ========================================================= */
  app.get(["/api/tts", "/tts"], async (req, res) => {
    try {
      const text = String(req.query.text || "").trim();
      if (!text)
        return res.status(400).json({ ok: false, error: "Missing text" });

      const format = String(req.query.format || "mp3").toLowerCase();
      if (format !== "mp3") {
        return res.status(400).json({ ok: false, error: "Only mp3 supported" });
      }

      // ✅ path ke tts.py (root project)
      const scriptPath = path.join(__dirname, "tts.py");
      if (!fs.existsSync(scriptPath)) {
        return res.status(500).json({
          ok: false,
          error: "tts.py not found. Pastikan file tts.py ada di root project.",
        });
      }

      // ✅ pilih command python (windows biasanya python)
      const pythonCmd = process.env.PYTHON_CMD || "python";

      // ✅ file output unik per request (biar gak tabrakan)
      const outFile = path.join(
        ttsDir,
        `tts_${Date.now()}_${Math.random().toString(16).slice(2)}.mp3`
      );

      await runPythonTts({
        pythonCmd,
        scriptPath,
        text,
        outFile,
      });

      if (!fs.existsSync(outFile)) {
        return res
          .status(500)
          .json({ ok: false, error: "TTS output mp3 tidak terbentuk." });
      }

      const audioBuf = fs.readFileSync(outFile);

      // bersihin file cache (biar gak numpuk)
      try {
        fs.unlinkSync(outFile);
      } catch {}

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", String(audioBuf.length));
      res.status(200).end(audioBuf);
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: String(e?.message || e),
        hint: "Pastikan: pip install edge-tts && python ada di PATH",
      });
    }
  });

  // ===================== QUEUE =====================
  app.post("/api/take-ticket", async (req, res) => {
    try {
      await ensureDailyReset();
      const { serviceType } = req.body;
      const ticketCode = await takeTicket(serviceType);
      res.json({ ok: true, ticketCode });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/tickets/take", async (req, res) => {
    try {
      await ensureDailyReset();
      const { serviceType } = req.body;
      const ticketCode = await takeTicket(serviceType);
      res.json({ ok: true, ticketCode });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/call-next", async (req, res) => {
    try {
      await ensureDailyReset();
      const { serviceType, counterName } = req.body;
      const called = await callNext(serviceType, counterName);
      res.json({ ok: true, called });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/tickets/next", async (req, res) => {
    try {
      await ensureDailyReset();
      const { serviceType, counterName } = req.body;
      const called = await callNext(serviceType, counterName);
      res.json({ ok: true, called });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/state", async (_req, res) => {
    try {
      await ensureDailyReset();
      const state = await getState();
      res.json(state);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/state/full", async (_req, res) => {
    try {
      await ensureDailyReset();
      res.json({ ok: true, state: await getState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===================== ADMIN =====================
  app.get("/api/admin/summary", async (_req, res) => {
    try {
      await ensureDailyReset();
      res.json({ ok: true, summary: await getTodaySummary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/today-summary", async (_req, res) => {
    try {
      await ensureDailyReset();
      res.json({ ok: true, summary: await getTodaySummary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/calls", async (_req, res) => {
    try {
      await ensureDailyReset();
      res.json({ ok: true, rows: await getTodayCalls() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/today-calls", async (_req, res) => {
    try {
      await ensureDailyReset();
      res.json({ ok: true, rows: await getTodayCalls() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/clear-today", async (_req, res) => {
    try {
      await clearTodayTickets();
      writeJsonSafe(dailyResetMetaPath, {
        lastResetYMD: ymdNow(),
        resetAt: new Date().toISOString(),
        manual: true,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===================== DISPLAY CONFIG =====================
  app.get("/api/display/config", async (_req, res) => {
    try {
      const cfg = await getDisplayConfig();
      res.json({
        ok: true,
        config: {
          promo_text: cfg.promoText,
          video_path: cfg.videoPath,
          promo_images: cfg.promoImages || [],
          updated_at: cfg.updatedAt,
          // legacy
          promoText: cfg.promoText,
          videoPath: cfg.videoPath,
          promoImages: cfg.promoImages || [],
          updatedAt: cfg.updatedAt,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/display/config", async (req, res) => {
    try {
      const body = req.body || {};
      const promo_text = body.promo_text;
      const video_path = body.video_path;
      const promo_images = body.promo_images;

      const cfg = await setDisplayConfig({
        promo_text,
        video_path,
        promo_images,
      });

      res.json({
        ok: true,
        config: {
          promo_text: cfg.promoText,
          video_path: cfg.videoPath,
          promo_images: cfg.promoImages || [],
          updated_at: cfg.updatedAt,
          promoText: cfg.promoText,
          videoPath: cfg.videoPath,
          promoImages: cfg.promoImages || [],
          updatedAt: cfg.updatedAt,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ✅ Upload VIDEO ke server (Admin pakai ini) + simpan ke DB
  app.post(
    "/api/display/upload-video",
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file)
          return res.status(400).json({ ok: false, error: "No file" });
        const abs = req.file.path; // path absolute di server
        const cfg = await setDisplayConfig({ video_path: abs });
        res.json({ ok: true, config: cfg });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
  );

  // ✅ Upload IMAGES ke server (multiple) + ✅ simpan ke DB (merge, tidak hilang)
  app.post(
    "/api/display/upload-images",
    upload.array("files", 20),
    async (req, res) => {
      try {
        const files = req.files || [];
        if (!files.length)
          return res.status(400).json({ ok: false, error: "No files" });

        const current = await getDisplayConfig();
        const currentList = Array.isArray(current?.promoImages)
          ? current.promoImages
          : [];

        const newPaths = files.map(
          (f) =>
            `/media/promo-images/${encodeURIComponent(path.basename(f.path))}`
        );

        const merged = [...currentList, ...newPaths].filter(Boolean);
        const cfg = await setDisplayConfig({ promo_images: merged });

        res.json({
          ok: true,
          config: {
            promo_text: cfg.promoText,
            video_path: cfg.videoPath,
            promo_images: cfg.promoImages || [],
            updated_at: cfg.updatedAt,
            promoText: cfg.promoText,
            videoPath: cfg.videoPath,
            promoImages: cfg.promoImages || [],
            updatedAt: cfg.updatedAt,
          },
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
  );

  // ✅ Serve images slider
  app.get("/media/promo-images/:name", (req, res) => {
    try {
      const file = String(req.params.name || "");
      const safe = decodeURIComponent(file);
      const abs = path.join(imagesDir, safe);

      if (!abs.startsWith(imagesDir)) return res.status(400).send("Bad path");
      if (!fs.existsSync(abs)) return res.status(404).send("Not found");

      res.setHeader("Cache-Control", "no-store");
      res.sendFile(abs);
    } catch (e) {
      res.status(500).send(String(e?.message || e));
    }
  });

  /**
   * ✅ STREAM VIDEO promo dari path yang disimpan di DB server
   * Display PC lain pakai: http://IP-SERVER:3000/media/promo
   */
  app.get("/media/promo", async (req, res) => {
    try {
      const cfg = await getDisplayConfig();
      const videoPath = cfg?.videoPath;

      if (!videoPath || typeof videoPath !== "string") {
        return res.status(404).send("No promo video set");
      }

      const absPath = path.isAbsolute(videoPath)
        ? videoPath
        : path.join(process.cwd(), videoPath);
      if (!fs.existsSync(absPath))
        return res.status(404).send("Promo video file not found");

      const stat = fs.statSync(absPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const file = fs.createReadStream(absPath, { start, end });

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4",
          "Cache-Control": "no-store",
        });

        file.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });

        fs.createReadStream(absPath).pipe(res);
      }
    } catch (e) {
      res.status(500).send(String(e?.message || e));
    }
  });

  const server = app.listen(port, host, () => {
    console.log(`✅ Queue Server running on http://${host}:${port}`);
    console.log("✅ Media root:", mediaRoot);
    console.log("✅ Audio dir:", audioDir);
    console.log("✅ Bundled audio dir:", bundledAudioDir);
    console.log("✅ TTS cache:", ttsDir);
    console.log("✅ Daily reset meta:", dailyResetMetaPath);
  });

  return { app, server };
}

module.exports = { createServer };
