chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("scratch.html") });
});

// Keyboard command -> tell the active tab's content script to overlay Neovim on
// the currently focused text field.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-nvim" && tab?.id !== undefined) {
    void chrome.tabs.sendMessage(tab.id, { type: "nvim-activate" });
  }
});
