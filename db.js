// FILE: db.js
const fs = require("fs");
const path = require("path");

let dataFilePath;
let tickets = [];

/**
 * Load data dari file JSON (kalau ada), kalau tidak, mulai dari array kosong.
 */
function loadFromFile() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const raw = fs.readFileSync(dataFilePath, "utf8");
      tickets = JSON.parse(raw);
      if (!Array.isArray(tickets)) tickets = [];
    } else {
      tickets = [];
    }
  } catch (err) {
    console.error("Gagal baca queue.json, mulai dengan data kosong:", err);
    tickets = [];
  }
}

/**
 * Simpan data ke file JSON.
 */
function saveToFile() {
  try {
    fs.writeFileSync(dataFilePath, JSON.stringify(tickets, null, 2), "utf8");
  } catch (err) {
    console.error("Gagal simpan queue.json:", err);
  }
}

function initDb() {
  // Simpan di folder project (boleh juga ganti ke appData nanti)
  dataFilePath = path.join(process.cwd(), "queue.json");
  loadFromFile();
}

function getNextNumber(serviceType) {
  const list = tickets.filter((t) => t.service_type === serviceType);
  const maxNum = list.reduce((max, t) => Math.max(max, t.number), 0);
  return maxNum + 1;
}

function formatTicket(serviceType, num) {
  const n = String(num).padStart(3, "0");
  if (serviceType === "TELLER") return `T-${n}`;
  if (serviceType === "CS") return `CS-${n}`;
  return n;
}

// Dipakai KIOSK untuk ambil nomor
function takeTicket(serviceType) {
  if (!["TELLER", "CS"].includes(serviceType)) {
    throw new Error("Invalid service type");
  }

  const num = getNextNumber(serviceType);
  const ticketCode = formatTicket(serviceType, num);

  const ticket = {
    id: Date.now() + Math.random(), // id sederhana
    service_type: serviceType, // 'TELLER' atau 'CS'
    number: num,
    ticket_code: ticketCode,
    status: "WAITING", // WAITING / CALLED / DONE
    counter_name: null,
    called_at: null,
    created_at: new Date().toISOString(),
  };

  tickets.push(ticket);
  saveToFile();

  return ticketCode;
}

// Dipakai TELLER/CS untuk memanggil berikutnya
function callNext(serviceType, counterName) {
  const ticket = tickets.find(
    (t) => t.service_type === serviceType && t.status === "WAITING"
  );

  if (!ticket) return null;

  ticket.status = "CALLED";
  ticket.counter_name = counterName;
  ticket.called_at = new Date().toISOString();
  saveToFile();

  return { ticketCode: ticket.ticket_code, counterName };
}

// Dipakai DISPLAY untuk baca state antrian sekarang
function getState() {
  const tellerCalled = tickets.filter(
    (t) => t.service_type === "TELLER" && t.status === "CALLED"
  );
  const csCalled = tickets.filter(
    (t) => t.service_type === "CS" && t.status === "CALLED"
  );

  const lastTeller =
    tellerCalled.length > 0
      ? tellerCalled.reduce((a, b) =>
          (a.called_at || a.created_at) > (b.called_at || b.created_at) ? a : b
        )
      : null;

  const lastCs =
    csCalled.length > 0
      ? csCalled.reduce((a, b) =>
          (a.called_at || a.created_at) > (b.called_at || b.created_at) ? a : b
        )
      : null;

  const tellerQueue = tickets
    .filter((t) => t.service_type === "TELLER" && t.status === "WAITING")
    .sort((a, b) => a.id - b.id)
    .slice(0, 10)
    .map((t) => t.ticket_code);

  const csQueue = tickets
    .filter((t) => t.service_type === "CS" && t.status === "WAITING")
    .sort((a, b) => a.id - b.id)
    .slice(0, 10)
    .map((t) => t.ticket_code);

  return {
    tellerNow: lastTeller
      ? {
          ticket_code: lastTeller.ticket_code,
          counter_name: lastTeller.counter_name,
        }
      : null,
    csNow: lastCs
      ? {
          ticket_code: lastCs.ticket_code,
          counter_name: lastCs.counter_name,
        }
      : null,
    tellerQueue,
    csQueue,
  };
}

module.exports = {
  initDb,
  takeTicket,
  callNext,
  getState,
};
