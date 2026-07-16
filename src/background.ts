// Each scratch tab gets a unique ?doc id so its draft is independent — otherwise
// every tab restores the one shared draft from IndexedDB.
function scratchUrl(): string {
  return chrome.runtime.getURL("scratch.html") + "?doc=" + crypto.randomUUID();
}

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: scratchUrl() });
});

// Keyboard command -> tell the active tab's content script to overlay Neovim on
// the currently focused text field.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-nvim" && tab?.id !== undefined) {
    void chrome.tabs.sendMessage(tab.id, { type: "nvim-activate" });
  }
});

// Content script -> background: the hostile-page fallback notice's "Open scratch
// page" escape hatch. The content script can't open a tab itself, so it asks us.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "open-scratch") {
    void chrome.tabs.create({ url: scratchUrl() });
  }
});
