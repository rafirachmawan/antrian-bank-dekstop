// FILE: db.js
// Database lokal berbasis file JSON: queue.json

const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "queue.json");

/**
 * Pastikan file queue.json ada dan punya struktur dasar
 */
function ensureDbFile() {
  if (!fs.existsSync(dbPath)) {
    const initial = {
      lastId: 0,
      tickets: [],
    };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), "utf-8");
    return;
  }

  // kalau sudah ada, pastikan minimal punya field tickets
  try {
    const raw = fs.readFileSync(dbPath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tickets)) {
      throw new Error("Invalid structure");
    }
  } catch {
    const initial = {
      lastId: 0,
      tickets: [],
    };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), "utf-8");
  }
}

function loadDb() {
  ensureDbFile();
  const raw = fs.readFileSync(dbPath, "utf-8");
  let data = JSON.parse(raw);

  if (!Array.isArray(data.tickets)) {
    data = { lastId: 0, tickets: [] };
  }

  // kalau lastId belum ada, hitung dari id terbesar
  if (typeof data.lastId !== "number") {
    data.lastId = data.tickets.reduce((max, t) => Math.max(max, t.id || 0), 0);
  }

  return data;
}

function saveDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Dipanggil dari main.js saat app ready
 */
function initDb() {
  ensureDbFile();
}

/**
 * Helper: range awal & akhir hari ini (00:00 – 23:59:59)
 */
function getTodayRange() {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = startDate.getTime();
  const end = start + 24 * 60 * 60 * 1000; // +1 hari
  return { start, end };
}

/**
 * Membuat tiket baru (TELLER / CS)
 * return: string ticket_code -> "T-001", "CS-010"
 */
function takeTicket(serviceType) {
  const db = loadDb();
  const tickets = db.tickets || [];
  const prefix = serviceType === "CS" ? "CS" : "T";

  // cari tiket terakhir untuk serviceType ini
  const lastTicketSame = [...tickets]
    .reverse()
    .find((t) => t.service_type === serviceType);

  let nextNumber = 1;
  if (lastTicketSame && lastTicketSame.ticket_code) {
    const numericPart = lastTicketSame.ticket_code
      .replace("T-", "")
      .replace("CS-", "");
    const parsed = parseInt(numericPart, 10);
    if (!isNaN(parsed)) {
      nextNumber = parsed + 1;
    }
  }

  const ticketNumberStr = String(nextNumber).padStart(3, "0");
  const ticketCode =
    prefix === "T" ? `T-${ticketNumberStr}` : `CS-${ticketNumberStr}`;

  const now = Date.now();
  const id = (db.lastId || 0) + 1;
  db.lastId = id;

  tickets.push({
    id,
    service_type: serviceType, // 'TELLER' / 'CS'
    ticket_code: ticketCode,
    status: "WAITING", // WAITING / CALLED
    counter_name: null,
    created_at: now,
    called_at: null,
  });

  db.tickets = tickets;
  saveDb(db);

  return ticketCode;
}

/**
 * Memanggil nomor berikutnya untuk serviceType tertentu
 * return: { ticketCode, counterName } atau null jika kosong
 */
function callNext(serviceType, counterName) {
  const db = loadDb();
  const tickets = db.tickets || [];

  // tiket dengan status WAITING paling awal (id terkecil)
  const next = tickets
    .filter((t) => t.service_type === serviceType && t.status === "WAITING")
    .sort((a, b) => a.id - b.id)[0];

  if (!next) {
    return null;
  }

  const now = Date.now();
  next.status = "CALLED";
  next.counter_name = counterName;
  next.called_at = now;

  saveDb(db);

  return {
    ticketCode: next.ticket_code,
    counterName,
  };
}

/**
 * State untuk DISPLAY & OPERATOR:
 * {
 *   tellerNow: { ticket_code, counter_name } | undefined
 *   csNow: { ticket_code, counter_name } | undefined
 *   tellerQueue: [ 'T-001', ... ]
 *   csQueue: [ 'CS-001', ... ]
 * }
 */
function getState() {
  const db = loadDb();
  const tickets = db.tickets || [];

  const tellerCalled = tickets.filter(
    (t) => t.service_type === "TELLER" && t.status === "CALLED"
  );
  const csCalled = tickets.filter(
    (t) => t.service_type === "CS" && t.status === "CALLED"
  );

  // tiket terakhir dipanggil (berdasarkan called_at / id)
  const tellerNow =
    tellerCalled.length > 0
      ? tellerCalled.reduce((latest, t) => {
          if (!latest) return t;
          return (t.called_at || t.id) > (latest.called_at || latest.id)
            ? t
            : latest;
        }, null)
      : null;

  const csNow =
    csCalled.length > 0
      ? csCalled.reduce((latest, t) => {
          if (!latest) return t;
          return (t.called_at || t.id) > (latest.called_at || latest.id)
            ? t
            : latest;
        }, null)
      : null;

  const tellerQueue = tickets
    .filter((t) => t.service_type === "TELLER" && t.status === "WAITING")
    .sort((a, b) => a.id - b.id)
    .map((t) => t.ticket_code);

  const csQueue = tickets
    .filter((t) => t.service_type === "CS" && t.status === "WAITING")
    .sort((a, b) => a.id - b.id)
    .map((t) => t.ticket_code);

  return {
    tellerNow: tellerNow
      ? {
          ticket_code: tellerNow.ticket_code,
          counter_name: tellerNow.counter_name,
        }
      : null,
    csNow: csNow
      ? {
          ticket_code: csNow.ticket_code,
          counter_name: csNow.counter_name,
        }
      : null,
    tellerQueue,
    csQueue,
  };
}

/**
 * Ringkasan antrian HARI INI (dipakai admin panel)
 */
function getTodaySummary() {
  const db = loadDb();
  const tickets = db.tickets || [];
  const { start, end } = getTodayRange();

  const todayTickets = tickets.filter(
    (t) => t.created_at >= start && t.created_at < end
  );

  const totalToday = todayTickets.length;

  const tellerWaitingToday = todayTickets.filter(
    (t) => t.service_type === "TELLER" && t.status === "WAITING"
  ).length;

  const csWaitingToday = todayTickets.filter(
    (t) => t.service_type === "CS" && t.status === "WAITING"
  ).length;

  const tellerCalledToday = todayTickets.filter(
    (t) =>
      t.service_type === "TELLER" &&
      t.status === "CALLED" &&
      t.called_at != null &&
      t.called_at >= start &&
      t.called_at < end
  ).length;

  const csCalledToday = todayTickets.filter(
    (t) =>
      t.service_type === "CS" &&
      t.status === "CALLED" &&
      t.called_at != null &&
      t.called_at >= start &&
      t.called_at < end
  ).length;

  return {
    totalToday,
    tellerWaitingToday,
    csWaitingToday,
    tellerCalledToday,
    csCalledToday,
  };
}

/**
 * Riwayat panggilan HARI INI (status CALLED)
 */
function getTodayCalls() {
  const db = loadDb();
  const tickets = db.tickets || [];
  const { start, end } = getTodayRange();

  const calls = tickets
    .filter(
      (t) =>
        t.status === "CALLED" &&
        t.called_at != null &&
        t.called_at >= start &&
        t.called_at < end
    )
    .sort((a, b) => (a.called_at || a.id) - (b.called_at || b.id));

  // kembalikan apa adanya (dipakai admin.html)
  return calls;
}

/**
 * Reset tiket HARI INI (hapus yang created_at hari ini)
 */
function clearTodayTickets() {
  const db = loadDb();
  const tickets = db.tickets || [];
  const { start, end } = getTodayRange();

  db.tickets = tickets.filter(
    (t) => t.created_at < start || t.created_at >= end
  );

  // lastId bisa dibiarkan, tidak masalah walaupun id lanjut terus
  saveDb(db);
}

module.exports = {
  initDb,
  takeTicket,
  callNext,
  getState,
  getTodaySummary,
  getTodayCalls,
  clearTodayTickets,
};
