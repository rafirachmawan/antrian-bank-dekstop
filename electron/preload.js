// FILE: electron/preload.js
const { contextBridge, ipcRenderer } = require("electron");
const { URLSearchParams } = require("url");

const params = new URLSearchParams(global.location.search);

// ✅ Tetap: queueConfig (logika lama tidak diubah)
contextBridge.exposeInMainWorld("queueConfig", {
  branchName: params.get("branchName") || "BANK ASTRO",
  apiBase: params.get("api") || "http://localhost:3000",
});

// ✅ Tambahan: kioskPrinter untuk silent thermal print
// Dipakai oleh HTML: window.kioskPrinter.printTicket({ branch, layanan, ticket, waktu })
contextBridge.exposeInMainWorld("kioskPrinter", {
  /**
   * Kirim perintah print ke main process (silent/thermal).
   * main.js harus menangani channel "PRINT_TICKET".
   */
  printTicket: (payload) => ipcRenderer.invoke("PRINT_TICKET", payload),
});
