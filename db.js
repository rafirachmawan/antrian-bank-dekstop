// FILE: db.js
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

// ✅ aman untuk app Electron build
function getUserDataPathSafe() {
  try {
    const { app } = require("electron");
    return app.getPath("userData");
  } catch (e) {
    return process.cwd();
  }
}

let db = null;

function getDbPath() {
  const baseDir = getUserDataPathSafe();
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, "queue.sqlite");
}

function openDb() {
  if (db) return db;

  const dbPath = getDbPath();
  const exists = fs.existsSync(dbPath);

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("❌ SQLite open error:", err);
      console.error("❌ DB Path:", dbPath);
      return;
    }
    console.log(
      exists ? "📦 SQLite DB dipakai:" : "📦 SQLite DB dibuat:",
      dbPath
    );
  });

  return db;
}

// helper promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ============= INIT =============
async function initDb() {
  openDb();

  const sqlTickets = `
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,         -- TELLER / CS
      ticket_code TEXT NOT NULL,          -- A001 / B015 (atau format lain)
      status TEXT NOT NULL DEFAULT 'WAITING', -- WAITING / CALLED
      counter_name TEXT NULL,             -- Teller 1 / CS 2
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      called_at TEXT NULL
    );
  `;

  // ✅ tambah promo_images untuk slider
  const sqlConfig = `
    CREATE TABLE IF NOT EXISTS display_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      promo_text TEXT DEFAULT '',
      video_path TEXT DEFAULT NULL,
      promo_images TEXT DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `;

  await run(sqlTickets);
  await run(sqlConfig);

  // ✅ kalau DB lama: pastikan kolom promo_images ada
  try {
    await run(
      `ALTER TABLE display_config ADD COLUMN promo_images TEXT DEFAULT '[]'`
    );
  } catch {}

  await run(
    `INSERT OR IGNORE INTO display_config (id, promo_text, video_path, promo_images) VALUES (1,'',NULL,'[]');`
  );
}

// ============= UTILS =============
function todayKeySQL() {
  return "date('now','localtime')";
}
function pad3(n) {
  return String(n).padStart(3, "0");
}
function normalizeService(serviceType) {
  if (serviceType === "TELLER") return "TELLER";
  if (serviceType === "CS") return "CS";
  throw new Error("serviceType invalid");
}
function safeParseJsonArray(x) {
  try {
    const arr = JSON.parse(x || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * ✅ PREFIX BARU:
 * - TELLER => A
 * - CS     => B
 * Catatan: ini hanya mengubah bentuk ticket_code, logika antrian tetap sama.
 */
function prefixFor(serviceType) {
  return serviceType === "TELLER" ? "A" : "B";
}

/**
 * ✅ ambil angka terakhir dari ticket_code lama
 * Support format lama: "T-001", "CS-015"
 * Support format baru: "A001", "B015" / "A-001", "B-015"
 */
function extractNumber(ticketCode) {
  if (!ticketCode) return NaN;
  const m = String(ticketCode).match(/(\d{1,})\s*$/);
  return m ? parseInt(m[1], 10) : NaN;
}

// ============= QUEUE LOGIC =============

// Ambil nomor berikutnya (tambah 1 berdasarkan max hari ini)
async function takeTicket(serviceType) {
  serviceType = normalizeService(serviceType);

  const row = await get(
    `
    SELECT ticket_code
    FROM tickets
    WHERE service_type = ?
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY id DESC
    LIMIT 1
    `,
    [serviceType]
  );

  let nextNum = 1;
  if (row && row.ticket_code) {
    // ✅ lebih aman: ambil angka di belakang apapun prefix-nya
    const last = extractNumber(row.ticket_code);
    if (!isNaN(last)) nextNum = last + 1;
  }

  // ✅ FORMAT BARU:
  // Teller: A001, A002...
  // CS:     B001, B002...
  const code = `${prefixFor(serviceType)}${pad3(nextNum)}`;
  // kalau kamu tetap pengin ada strip, pakai ini:
  // const code = `${prefixFor(serviceType)}-${pad3(nextNum)}`;

  await run(
    `
    INSERT INTO tickets (service_type, ticket_code, status)
    VALUES (?, ?, 'WAITING')
    `,
    [serviceType, code]
  );

  return code;
}

// Panggil nomor berikutnya dari WAITING (FIFO)
async function callNext(serviceType, counterName) {
  serviceType = normalizeService(serviceType);
  if (!counterName) throw new Error("counterName required");

  const row = await get(
    `
    SELECT id, ticket_code
    FROM tickets
    WHERE service_type = ?
      AND status = 'WAITING'
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY id ASC
    LIMIT 1
    `,
    [serviceType]
  );

  if (!row) return null;

  await run(
    `
    UPDATE tickets
    SET status = 'CALLED',
        counter_name = ?,
        called_at = datetime('now','localtime')
    WHERE id = ?
    `,
    [counterName, row.id]
  );

  return { ticketCode: row.ticket_code, counterName, serviceType };
}

// Ambil state untuk display (sedang dilayani + daftar waiting)
async function getState() {
  const tellerNow = await get(
    `
    SELECT ticket_code, counter_name
    FROM tickets
    WHERE service_type='TELLER'
      AND status='CALLED'
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY called_at DESC, id DESC
    LIMIT 1
    `
  );

  const csNow = await get(
    `
    SELECT ticket_code, counter_name
    FROM tickets
    WHERE service_type='CS'
      AND status='CALLED'
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY called_at DESC, id DESC
    LIMIT 1
    `
  );

  const tellerQueueRows = await all(
    `
    SELECT ticket_code
    FROM tickets
    WHERE service_type='TELLER'
      AND status='WAITING'
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY id ASC
    LIMIT 10
    `
  );

  const csQueueRows = await all(
    `
    SELECT ticket_code
    FROM tickets
    WHERE service_type='CS'
      AND status='WAITING'
      AND date(created_at) = ${todayKeySQL()}
    ORDER BY id ASC
    LIMIT 10
    `
  );

  return {
    tellerNow: tellerNow
      ? {
          ticket_code: tellerNow.ticket_code,
          counter_name: tellerNow.counter_name,
        }
      : null,
    csNow: csNow
      ? { ticket_code: csNow.ticket_code, counter_name: csNow.counter_name }
      : null,
    tellerQueue: (tellerQueueRows || []).map((r) => r.ticket_code),
    csQueue: (csQueueRows || []).map((r) => r.ticket_code),
  };
}

// ============= ADMIN FUNCTIONS =============
async function getTodaySummary() {
  const total = await get(
    `SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = ${todayKeySQL()}`
  );
  const tellerWaiting = await get(
    `SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = ${todayKeySQL()} AND service_type='TELLER' AND status='WAITING'`
  );
  const csWaiting = await get(
    `SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = ${todayKeySQL()} AND service_type='CS' AND status='WAITING'`
  );
  const calledToday = await get(
    `SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = ${todayKeySQL()} AND status='CALLED'`
  );

  return {
    totalTickets: total?.c || 0,
    tellerWaiting: tellerWaiting?.c || 0,
    csWaiting: csWaiting?.c || 0,
    calledToday: calledToday?.c || 0,
  };
}

async function getTodayCalls() {
  const rows = await all(
    `
    SELECT service_type, ticket_code, counter_name, called_at
    FROM tickets
    WHERE date(created_at) = ${todayKeySQL()}
      AND status='CALLED'
    ORDER BY called_at DESC, id DESC
    LIMIT 200
    `
  );
  return rows || [];
}

async function clearTodayTickets() {
  await run(`DELETE FROM tickets WHERE date(created_at) = ${todayKeySQL()}`);
  return true;
}

// ============= DISPLAY CONFIG =============
async function getDisplayConfig() {
  const row = await get(
    `SELECT promo_text, video_path, promo_images, updated_at FROM display_config WHERE id = 1 LIMIT 1`
  );

  return {
    promoText: row?.promo_text || "",
    videoPath: row?.video_path || null,
    promoImages: safeParseJsonArray(row?.promo_images),
    updatedAt: row?.updated_at || null,
  };
}

async function setDisplayConfig({ promo_text, video_path, promo_images }) {
  const current = await getDisplayConfig();

  const nextPromo = promo_text !== undefined ? promo_text : current.promoText;
  const nextVideo = video_path !== undefined ? video_path : current.videoPath;

  const nextImages =
    promo_images !== undefined
      ? Array.isArray(promo_images)
        ? promo_images
        : safeParseJsonArray(promo_images)
      : current.promoImages;

  await run(
    `
    UPDATE display_config
    SET promo_text = ?,
        video_path = ?,
        promo_images = ?,
        updated_at = datetime('now','localtime')
    WHERE id = 1
    `,
    [nextPromo, nextVideo, JSON.stringify(nextImages)]
  );

  return getDisplayConfig();
}

// ============= EXPORT =============
module.exports = {
  initDb,
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
  getDisplayConfig,
  setDisplayConfig,
  // helper (dipakai server)
  getDbPath,
  getUserDataPathSafe,
};
