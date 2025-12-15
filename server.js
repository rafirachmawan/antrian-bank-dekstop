// FILE: server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const {
  initDb,
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
} = require("./db");

function createServer({ port = 3000 } = {}) {
  const app = express();

  app.use(cors());
  app.use(bodyParser.json({ limit: "2mb" }));

  // Health check
  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "queue-server",
      time: new Date().toISOString(),
    });
  });

  // =========================
  // Queue APIs (untuk kiosk/operator/display client)
  // =========================
  app.get("/api/state", (req, res) => {
    try {
      const state = getState();
      res.json(state);
    } catch (e) {
      console.error("GET /api/state error:", e);
      res.status(500).json({ error: "failed_get_state" });
    }
  });

  app.post("/api/take-ticket", (req, res) => {
    try {
      const { serviceType } = req.body || {};
      const ticket = takeTicket(serviceType);
      res.json({ ticket });
    } catch (e) {
      console.error("POST /api/take-ticket error:", e);
      res.status(500).json({ error: "failed_take_ticket" });
    }
  });

  app.post("/api/call-next", (req, res) => {
    try {
      const { serviceType, counterName } = req.body || {};
      const result = callNext(serviceType, counterName); // bisa null
      res.json(result || null);
    } catch (e) {
      console.error("POST /api/call-next error:", e);
      res.status(500).json({ error: "failed_call_next" });
    }
  });

  // =========================
  // Admin APIs
  // =========================
  app.get("/api/admin/today-summary", (req, res) => {
    try {
      const summary = getTodaySummary();
      res.json(summary);
    } catch (e) {
      console.error("GET /api/admin/today-summary error:", e);
      res.status(500).json({ error: "failed_today_summary" });
    }
  });

  app.get("/api/admin/today-calls", (req, res) => {
    try {
      const rows = getTodayCalls();
      res.json(rows);
    } catch (e) {
      console.error("GET /api/admin/today-calls error:", e);
      res.status(500).json({ error: "failed_today_calls" });
    }
  });

  app.post("/api/admin/clear-today", (req, res) => {
    try {
      clearTodayTickets();
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /api/admin/clear-today error:", e);
      res.status(500).json({ error: "failed_clear_today" });
    }
  });

  const server = app.listen(port, () => {
    console.log(`✅ Queue Server running on http://localhost:${port}`);
  });

  return { app, server };
}

module.exports = { createServer };
