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
    // fallback kalau suatu saat db.js dipakai non-electron (jarang)
    return process.cwd();
  }
}

let db = null;

function getDbPath() {
  // ✅ SIMPAN DB DI APPDATA (WAJIB)
  const baseDir = getUserDataPathSafe();
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, "queue.sqlite");
}

function openDb() {
  if (db) return db;

  const dbPath = getDbPath();
  const exists = fs.existsSync(dbPath);

  // ✅ kasih callback biar keliatan errornya kalau ada
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

// ============= INIT =============
function initDb() {
  openDb();

  const sqlTickets = `
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,              -- TELLER / CS
    ticket_code TEXT NOT NULL,               -- T-001 / CS-015
    status TEXT NOT NULL DEFAULT 'WAITING',  -- WAITING / CALLED
    counter_name TEXT NULL,                  -- Teller 1 / CS 2
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    called_at TEXT NULL
  );
  `;

  const sqlConfig = `
  CREATE TABLE IF NOT EXISTS display_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    promo_text TEXT DEFAULT '',
    video_path TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  `;

  openDb().serialize(() => {
    openDb().run(sqlTickets);
    openDb().run(sqlConfig);
    openDb().run(
      `INSERT OR IGNORE INTO display_config (id, promo_text, video_path) VALUES (1,'',NULL);`
    );
  });
}

// ============= UTILS =============
function todayKeySQL() {
  // ✅ konsisten localtime (jangan pakai date(created_at) doang)
  return "date(created_at, 'localtime') = date('now','localtime')";
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function normalizeService(serviceType) {
  if (serviceType === "TELLER") return "TELLER";
  if (serviceType === "CS") return "CS";
  throw new Error("serviceType invalid");
}

// ============= QUEUE LOGIC =============
function takeTicket(serviceType) {
  serviceType = normalizeService(serviceType);
  let ticket = null;

  openDb().serialize(() => {
    openDb().get(
      `
      SELECT ticket_code
      FROM tickets
      WHERE service_type = ?
        AND ${todayKeySQL()}
      ORDER BY id DESC
      LIMIT 1
      `,
      [serviceType],
      (err, row) => {
        if (err) throw err;

        let nextNum = 1;
        if (row && row.ticket_code) {
          const numPart = row.ticket_code.replace("T-", "").replace("CS-", "");
          const last = parseInt(numPart, 10);
          if (!isNaN(last)) nextNum = last + 1;
        }

        const code =
          serviceType === "TELLER"
            ? `T-${pad3(nextNum)}`
            : `CS-${pad3(nextNum)}`;

        openDb().run(
          `
          INSERT INTO tickets (service_type, ticket_code, status)
          VALUES (?, ?, 'WAITING')
          `,
          [serviceType, code],
          (err2) => {
            if (err2) throw err2;
            ticket = code;
          }
        );
      }
    );
  });

  return ticket;
}

function callNext(serviceType, counterName) {
  serviceType = normalizeService(serviceType);
  if (!counterName) throw new Error("counterName required");

  let result = null;

  openDb().serialize(() => {
    openDb().get(
      `
      SELECT id, ticket_code
      FROM tickets
      WHERE service_type = ?
        AND status = 'WAITING'
        AND ${todayKeySQL()}
      ORDER BY id ASC
      LIMIT 1
      `,
      [serviceType],
      (err, row) => {
        if (err) throw err;
        if (!row) {
          result = null;
          return;
        }

        openDb().run(
          `
          UPDATE tickets
          SET status = 'CALLED',
              counter_name = ?,
              called_at = datetime('now','localtime')
          WHERE id = ?
          `,
          [counterName, row.id],
          (err2) => {
            if (err2) throw err2;
            result = {
              ticketCode: row.ticket_code,
              counterName,
              serviceType,
            };
          }
        );
      }
    );
  });

  return result;
}

function getState() {
  let state = {
    tellerNow: null,
    csNow: null,
    tellerQueue: [],
    csQueue: [],
  };

  openDb().serialize(() => {
    openDb().get(
      `
      SELECT ticket_code, counter_name
      FROM tickets
      WHERE service_type='TELLER'
        AND status='CALLED'
        AND ${todayKeySQL()}
      ORDER BY called_at DESC, id DESC
      LIMIT 1
      `,
      [],
      (err, row) => {
        if (err) throw err;
        state.tellerNow = row
          ? { ticket_code: row.ticket_code, counter_name: row.counter_name }
          : null;
      }
    );

    openDb().get(
      `
      SELECT ticket_code, counter_name
      FROM tickets
      WHERE service_type='CS'
        AND status='CALLED'
        AND ${todayKeySQL()}
      ORDER BY called_at DESC, id DESC
      LIMIT 1
      `,
      [],
      (err, row) => {
        if (err) throw err;
        state.csNow = row
          ? { ticket_code: row.ticket_code, counter_name: row.counter_name }
          : null;
      }
    );

    openDb().all(
      `
      SELECT ticket_code
      FROM tickets
      WHERE service_type='TELLER'
        AND status='WAITING'
        AND ${todayKeySQL()}
      ORDER BY id ASC
      LIMIT 10
      `,
      [],
      (err, rows) => {
        if (err) throw err;
        state.tellerQueue = (rows || []).map((r) => r.ticket_code);
      }
    );

    openDb().all(
      `
      SELECT ticket_code
      FROM tickets
      WHERE service_type='CS'
        AND status='WAITING'
        AND ${todayKeySQL()}
      ORDER BY id ASC
      LIMIT 10
      `,
      [],
      (err, rows) => {
        if (err) throw err;
        state.csQueue = (rows || []).map((r) => r.ticket_code);
      }
    );
  });

  return state;
}

// ============= ADMIN FUNCTIONS =============
function getTodaySummary() {
  let summary = {
    totalTickets: 0,
    tellerWaiting: 0,
    csWaiting: 0,
    calledToday: 0,
  };

  openDb().serialize(() => {
    openDb().get(
      `
      SELECT COUNT(*) as c
      FROM tickets
      WHERE ${todayKeySQL()}
      `,
      [],
      (err, row) => {
        if (err) throw err;
        summary.totalTickets = row?.c || 0;
      }
    );

    openDb().get(
      `
      SELECT COUNT(*) as c
      FROM tickets
      WHERE ${todayKeySQL()}
        AND service_type='TELLER'
        AND status='WAITING'
      `,
      [],
      (err, row) => {
        if (err) throw err;
        summary.tellerWaiting = row?.c || 0;
      }
    );

    openDb().get(
      `
      SELECT COUNT(*) as c
      FROM tickets
      WHERE ${todayKeySQL()}
        AND service_type='CS'
        AND status='WAITING'
      `,
      [],
      (err, row) => {
        if (err) throw err;
        summary.csWaiting = row?.c || 0;
      }
    );

    openDb().get(
      `
      SELECT COUNT(*) as c
      FROM tickets
      WHERE ${todayKeySQL()}
        AND status='CALLED'
      `,
      [],
      (err, row) => {
        if (err) throw err;
        summary.calledToday = row?.c || 0;
      }
    );
  });

  return summary;
}

function getTodayCalls() {
  let rowsOut = [];

  openDb().serialize(() => {
    openDb().all(
      `
      SELECT service_type, ticket_code, counter_name, called_at
      FROM tickets
      WHERE ${todayKeySQL()}
        AND status='CALLED'
      ORDER BY called_at DESC, id DESC
      LIMIT 200
      `,
      [],
      (err, rows) => {
        if (err) throw err;
        rowsOut = rows || [];
      }
    );
  });

  return rowsOut;
}

function clearTodayTickets() {
  openDb().serialize(() => {
    openDb().run(
      `
      DELETE FROM tickets
      WHERE ${todayKeySQL()}
      `
    );
  });

  return true;
}

// ============= EXPORT =============
module.exports = {
  initDb,
  takeTicket,
  callNext,
  getState,

  // admin
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
};
