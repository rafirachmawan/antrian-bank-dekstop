// FILE: server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const {
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
  getDisplayConfig,
  setDisplayConfig,
} = require("./db");

function createServer({ port = 3000, host = "0.0.0.0" } = {}) {
  const app = express();
  app.use(cors());

  // ✅ aman kalau nanti ada payload besar
  app.use(express.json({ limit: "20mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "queue-server",
      time: new Date().toISOString(),
    });
  });

  // ===================== QUEUE =====================
  // Primary: /api/take-ticket
  app.post("/api/take-ticket", async (req, res) => {
    try {
      const { serviceType } = req.body;
      const ticketCode = await takeTicket(serviceType);
      res.json({ ok: true, ticketCode });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Alias: /api/tickets/take (biar HTML lama tetap jalan)
  app.post("/api/tickets/take", async (req, res) => {
    try {
      const { serviceType } = req.body;
      const ticketCode = await takeTicket(serviceType);
      res.json({ ok: true, ticketCode });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Primary: /api/call-next
  app.post("/api/call-next", async (req, res) => {
    try {
      const { serviceType, counterName } = req.body;
      const called = await callNext(serviceType, counterName);
      // called bisa null kalau kosong
      res.json({ ok: true, called });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Alias: /api/tickets/next (biar HTML lama tetap jalan)
  app.post("/api/tickets/next", async (req, res) => {
    try {
      const { serviceType, counterName } = req.body;
      const called = await callNext(serviceType, counterName);
      res.json({ ok: true, called });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * ✅ STATE
   * Penting: DISPLAY kamu biasanya expect object state langsung (tellerNow/csNow/queues).
   * Jadi /api/state kita balikin state langsung.
   */
  app.get("/api/state", async (_req, res) => {
    try {
      const state = await getState();
      res.json(state);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Optional: kalau kamu butuh format lama yang dibungkus
  app.get("/api/state/full", async (_req, res) => {
    try {
      res.json({ ok: true, state: await getState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===================== ADMIN =====================
  // Primary: /api/admin/summary
  app.get("/api/admin/summary", async (_req, res) => {
    try {
      res.json({ ok: true, summary: await getTodaySummary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Alias: /api/admin/today-summary
  app.get("/api/admin/today-summary", async (_req, res) => {
    try {
      res.json({ ok: true, summary: await getTodaySummary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Primary: /api/admin/calls
  app.get("/api/admin/calls", async (_req, res) => {
    try {
      res.json({ ok: true, rows: await getTodayCalls() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Alias: /api/admin/today-calls
  app.get("/api/admin/today-calls", async (_req, res) => {
    try {
      res.json({ ok: true, rows: await getTodayCalls() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/admin/clear-today", async (_req, res) => {
    try {
      await clearTodayTickets();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===================== DISPLAY CONFIG =====================
  app.get("/api/display/config", async (_req, res) => {
    try {
      res.json({ ok: true, config: await getDisplayConfig() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/api/display/config", async (req, res) => {
    try {
      const { promo_text, video_path } = req.body || {};
      res.json({
        ok: true,
        config: await setDisplayConfig({ promo_text, video_path }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * ✅ PENTING: serve video promo agar DISPLAY di PC lain bisa akses
   * - Admin menyimpan video_path berupa path file di PC server (mis: C:\...\promo.mp4)
   * - Display PC lain cukup set src ke: http://IP-SERVER:3000/media/promo
   */
  app.get("/media/promo", async (req, res) => {
    try {
      const cfg = await getDisplayConfig();

      // dukung dua kemungkinan nama field dari db.js
      const videoPath = cfg?.video_path || cfg?.videoPath;

      if (!videoPath || typeof videoPath !== "string") {
        return res.status(404).send("No promo video set");
      }

      // normalize path
      const absPath = path.isAbsolute(videoPath)
        ? videoPath
        : path.join(process.cwd(), videoPath);

      if (!fs.existsSync(absPath)) {
        return res.status(404).send("Promo video file not found");
      }

      const stat = fs.statSync(absPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      // MP4 streaming support
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
  });

  return { app, server };
}

module.exports = { createServer };
