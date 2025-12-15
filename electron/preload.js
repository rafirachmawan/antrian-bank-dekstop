// FILE: electron/preload.js
const { contextBridge } = require("electron");
const { URLSearchParams } = require("url");

const params = new URLSearchParams(global.location.search);

contextBridge.exposeInMainWorld("queueConfig", {
  branchName: params.get("branchName") || "BANK ASTRO",
  apiBase: params.get("api") || "http://localhost:3000",
});
