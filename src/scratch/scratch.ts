// Scratch page entry point. Milestone 2 wires the Neovim WASM engine host
// (threaded build) and canvas renderer in here.
const app = document.getElementById("app");
if (app) {
  app.textContent = `nvim-in-browser v${chrome.runtime.getManifest().version} — engine not yet wired up`;
}
