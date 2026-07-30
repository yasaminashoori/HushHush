const statusEl = document.getElementById("popupStatus");
const openApp = document.getElementById("openApp");
const openX = document.getElementById("openX");

try {
  chrome.storage.local.get({ concepts: [], apiKey: "", aiOn: false }, (local) => {
    try {
      chrome.storage.sync.get({ interestLabels: [] }, (sync) => {
        try {
          const mutes = (local.concepts || []).length;
          const interests = (sync.interestLabels || []).length;
          const ai = !!(local.aiOn && local.apiKey);
          const parts = [];
          if (mutes) parts.push(`${mutes} mute${mutes === 1 ? "" : "s"}`);
          if (interests) parts.push(`${interests} interest${interests === 1 ? "" : "s"}`);
          statusEl.className = "popup-status ok";
          statusEl.textContent = parts.length
            ? `Live · ${parts.join(" · ")}${ai ? " · AI on" : ""}`
            : "Ready · open X and start hushing";
        } catch (error) {
          console.error("Error updating status display:", error);
          statusEl.className = "popup-status ok";
          statusEl.textContent = "Ready · open X and start hushing";
        }
      });
    } catch (error) {
      console.error("Error reading sync storage:", error);
      statusEl.className = "popup-status ok";
      statusEl.textContent = "Ready · open X and start hushing";
    }
  });
} catch (error) {
  console.error("Error reading local storage:", error);
  statusEl.className = "popup-status ok";
  statusEl.textContent = "Ready · open X and start hushing";
}

openApp.addEventListener("click", () => {
  try {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: "options/index.html" });
  } catch (error) {
    console.error("Error opening options page:", error);
  }
});

openX.addEventListener("click", () => {
  try {
    chrome.tabs.create({ url: "https://x.com/home" });
  } catch (error) {
    console.error("Error opening X:", error);
  }
});