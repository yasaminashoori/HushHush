let settings = {
  blocked: [],
  allowed: [],
  concepts: [],
  softBlocked: [],
  interestLabels: [],
  randomOn: true,
  randomPercent: 10,
  aiOn: false,
};

const aiDecision = new Map();
const pendingIds = new Set();
const loggedTweets = new Set();
let classifyTimer = null;
let filteredCount = 0;
let placeholderTimer = null;
let placeholderIndex = 0;
let activeTab = "mute";

const PLACEHOLDERS = [
  "دختر",
  "رابطه",
  "دیت",
  "ازدواج",
  "پسر",
  "دنگ",
  "اسپم",
  "تبلیغات",
  "سیاست",
  "AI slop",
  "crypto spam",
  "engagement bait",
  "rage bait",
  "clickbait",
  "giveaway",
];

function normalize(text) {
  return text.toLowerCase();
}

function extractTextWithEmoji(root) {
  if (!root) return "";
  let out = "";

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.tagName === "IMG") {
      const alt = node.getAttribute("alt") || "";
      const src = node.getAttribute("src") || "";
      if (alt && (src.includes("/emoji/") || src.includes("twimg.com/emoji"))) {
        out += alt;
      } else if (alt && !src) {
        out += alt;
      }
      return;
    }

    for (const child of node.childNodes) walk(child);
  };

  walk(root);
  return out.replace(/\s+/g, " ").trim();
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getTweetId(tweet) {
  const link = tweet.querySelector('a[href*="/status/"]');
  if (link) {
    const m = link.getAttribute("href").match(/\/status\/(\d+)/);
    if (m) return m[1];
  }
  return "h" + hashCode((tweet.innerText || "").slice(0, 200));
}

function getTweetText(tweet) {
  const body =
    tweet.querySelector('[data-testid="tweetText"]') ||
    tweet.querySelector("[lang]");
  if (body) {
    const withEmoji = extractTextWithEmoji(body);
    if (withEmoji) return withEmoji;
  }
  // fallback
  return extractTextWithEmoji(tweet) || (tweet.innerText || "").trim();
}

function getTweetDisplayName(tweet) {
 const userNameBlock = tweet.querySelector('[data-testid="User-Name"]');
  if (!userNameBlock) return "";

  const nameLink =
    userNameBlock.querySelector('a[href^="/"]:not([href*="/status/"])') ||
    userNameBlock.querySelector('a[href^="/"]');

  return extractTextWithEmoji(nameLink || userNameBlock);
}

function shouldSoftBlock(tweet) {
  if (!settings.softBlocked.length) return false;
  const name = normalize(getTweetDisplayName(tweet));
  if (!name) return false;
  return settings.softBlocked.some((w) => name.includes(normalize(w)));
}

function keywordShouldHide(tweetText) {
  const text = normalize(tweetText);

  if (settings.blocked.some((w) => text.includes(normalize(w)))) return true;
  if (settings.concepts.some((w) => text.includes(normalize(w)))) return true;

  if (settings.allowed.length > 0) {
    const hasAllowed = settings.allowed.some((w) => text.includes(normalize(w)));
    if (!hasAllowed) {
      if (settings.randomOn && hashCode(text) % 100 < settings.randomPercent) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function applyVisibility(tweet, hide, reason) {
  const cell = tweet.closest('div[data-testid="cellInnerDiv"]') || tweet;
  const next = hide ? "1" : "0";

  if (cell.dataset.hhHide === next) {
    if (reason) cell.dataset.hhReason = reason;
    return;
  }

  cell.dataset.hhHide = next;
  if (reason) cell.dataset.hhReason = reason;
}

function scheduleClassify() {
  clearTimeout(classifyTimer);
  classifyTimer = setTimeout(runClassifyBatch, 400);
}

function runClassifyBatch() {
  if (!settings.aiOn) return;

  const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const batch = [];

  tweets.forEach((tweet) => {
    const id = getTweetId(tweet);
    if (aiDecision.has(id) || pendingIds.has(id)) return;
    const text = getTweetText(tweet);
    if (!text || text.length < 8) return;
    pendingIds.add(id);
    batch.push({ id, text, tweet });
  });

  if (batch.length === 0) return;

  const slice = batch.slice(0, 12);
  chrome.runtime.sendMessage(
    { type: "classify", texts: slice.map((b) => b.text) },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        slice.forEach((b) => {
          pendingIds.delete(b.id);
          aiDecision.set(b.id, {
            show: !keywordShouldHide(b.text),
            reason: "fallback",
          });
        });
        filterTweets();
        return;
      }
      slice.forEach((b, i) => {
        pendingIds.delete(b.id);
        const r = res.results[i] || { show: true, reason: "" };
        aiDecision.set(b.id, {
          show: r.show !== false,
          reason: r.reason || "",
        });
      });
      filterTweets();
      if (batch.length > 12) scheduleClassify();
    }
  );
}

function logTweetUser(tweet) {
  const tweetId = getTweetId(tweet);
  if (loggedTweets.has(tweetId)) return;
  loggedTweets.add(tweetId);

  let name = null;
  const userNameBlock = tweet.querySelector('[data-testid="User-Name"]');
  if (userNameBlock) {
    const nameLink =
      userNameBlock.querySelector('a[href^="/"] span') ||
      userNameBlock.querySelector('a[href^="/"]');
    name = (nameLink?.textContent || "").trim() || null;
  }

  let userId = null;
  const userIdLink = tweet.querySelector('a[href*="/i/user/"]');
  if (userIdLink) {
    const m = userIdLink.getAttribute("href")?.match(/\/i\/user\/(\d+)/);
    if (m) userId = m[1];
  }

  if (!userId) {
    const elWithId = tweet.querySelector("[data-user-id]");
    if (elWithId) userId = elWithId.getAttribute("data-user-id");
  }
}

function filterTweets() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  tweets.forEach((tweet) => {
    logTweetUser(tweet);

    if (shouldSoftBlock(tweet)) {
      applyVisibility(tweet, true, "soft-block");
      return;
    }

    const text = getTweetText(tweet);
    const id = getTweetId(tweet);

    if (
      settings.blocked.some((w) => normalize(text).includes(normalize(w))) ||
      settings.concepts.some((w) => normalize(text).includes(normalize(w)))
    ) {
      applyVisibility(tweet, true, "muted");
      return;
    }

    if (settings.aiOn) {
      const decision = aiDecision.get(id);
      if (decision) {
        applyVisibility(tweet, !decision.show, decision.reason);
      } else {
        applyVisibility(tweet, false, "pending");
        scheduleClassify();
      }
    } else {
      applyVisibility(tweet, keywordShouldHide(text), "keyword");
    }

    ensureBounceBtn(tweet);
  });

  filteredCount = document.querySelectorAll('[data-hh-hide="1"]').length;
  updateFilteredCountUi();
}

function ensureBounceBtn(tweet) {
  if (tweet.querySelector(".hh-bounce-btn")) return;

  const actions =
    tweet.querySelector('[role="group"]') ||
    tweet.querySelector('[data-testid="app-text-transition-container"]')?.parentElement;
  if (!actions) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hh-bounce-btn";
  btn.title = "Hush this — suggest mutes";
  btn.textContent = "🤫";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBouncePanel(tweet, btn);
  });
  actions.appendChild(btn);
}

function openBouncePanel(tweet, anchor) {
  document.querySelectorAll(".hh-bounce-panel").forEach((p) => p.remove());

  const panel = document.createElement("div");
  panel.className = "hh-bounce-panel";
  panel.innerHTML = `<div class="hh-bounce-title">Why mute this?</div>
    <div class="hh-reasons">Thinking…</div>`;

  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${rect.bottom + window.scrollY + 6}px`;
  panel.style.left = `${Math.max(8, rect.left + window.scrollX - 180)}px`;
  document.body.appendChild(panel);

  const close = (e) => {
    if (!panel.contains(e.target) && e.target !== anchor) {
      panel.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);

  const text = getTweetText(tweet);
  chrome.runtime.sendMessage({ type: "bounceSuggest", text }, (res) => {
    const box = panel.querySelector(".hh-reasons");
    if (!box) return;
    if (chrome.runtime.lastError || !res?.ok) {
      box.innerHTML = "";
      const list = document.createElement("div");
      box.appendChild(list);
      addReasonButtons(list, ["spam", "off-topic", "AI slop"], tweet, panel);
      return;
    }
    box.innerHTML = "";
    const list = document.createElement("div");
    box.appendChild(list);
    addReasonButtons(list, res.reasons, tweet, panel);
  });
}

function addReasonButtons(container, reasons, tweet, panel) {
  reasons.forEach((reason) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hh-reason-btn";
    b.textContent = reason;
    b.addEventListener("click", async () => {
      await addFilterWord(reason);
      applyVisibility(tweet, true, reason);
      panel.remove();
    });
    container.appendChild(b);
  });
}

async function addFilterWord(word) {
  const w = (word || "").trim();
  if (!w) return;
  const data = await chrome.storage.local.get({ concepts: [], apiKey: "", aiOn: false });
  const concepts = data.concepts || [];
  if (!concepts.some((c) => c.toLowerCase() === w.toLowerCase())) {
    concepts.push(w);
  }
  const aiOn = !!(data.aiOn && data.apiKey);
  await chrome.storage.local.set({ concepts, aiOn });
  chrome.runtime.sendMessage({ type: "clearAiCache" });
  aiDecision.clear();
  settings.concepts = concepts;
  settings.aiOn = aiOn;
  renderMuteChips();
  filterTweets();
  if (aiOn) scheduleClassify();
}

async function removeFilterWord(word) {
  const data = await chrome.storage.local.get({ concepts: [] });
  const concepts = (data.concepts || []).filter(
    (c) => c.toLowerCase() !== word.toLowerCase()
  );
  await chrome.storage.local.set({ concepts });
  chrome.runtime.sendMessage({ type: "clearAiCache" });
  aiDecision.clear();
  settings.concepts = concepts;
  renderMuteChips();
  filterTweets();
  if (settings.aiOn) scheduleClassify();
}

async function addSoftBlock(word) {
  const w = (word || "").trim();
  if (!w) return;

  const data = await chrome.storage.local.get({ softBlocked: [] });
  const softBlocked = data.softBlocked || [];
  if (!softBlocked.some((c) => c.toLowerCase() === w.toLowerCase())) {
    softBlocked.push(w);
  }
  await chrome.storage.local.set({ softBlocked });
  settings.softBlocked = softBlocked;
  renderSoftBlockChips();
  filterTweets();
}

async function removeSoftBlock(word) {
  const data = await chrome.storage.local.get({ softBlocked: [] });
  const softBlocked = (data.softBlocked || []).filter(
    (c) => c.toLowerCase() !== word.toLowerCase()
  );
  await chrome.storage.local.set({ softBlocked });
  settings.softBlocked = softBlocked;
  renderSoftBlockChips();
  filterTweets();
}

async function persistInterests(labels) {
  const allowed = keywordsForLabels(labels);
  await chrome.storage.sync.set({
    interestLabels: labels,
    allowed,
    randomOn: labels.length > 0,
    randomPercent: 10,
  });
  settings.interestLabels = labels;
  settings.allowed = allowed;
  settings.randomOn = labels.length > 0;
  chrome.runtime.sendMessage({ type: "clearAiCache" });
  aiDecision.clear();
  renderInterestChips();
  filterTweets();
  if (settings.aiOn) scheduleClassify();
}

function detectTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\d+/g);
  if (!m) return "dark";
  const [r, g, b] = m.map(Number);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "light" : "dark";
}

function updateFilteredCountUi() {
  const el = document.getElementById("hh-filtered-count");
  if (el) {
    el.textContent =
      filteredCount === 1 ? "1 post hushed" : `${filteredCount} posts hushed`;
  }
}

function renderMuteChips() {
  const box = document.getElementById("hh-mute-chips");
  if (!box) return;
  box.innerHTML = "";
  if (!settings.concepts.length) {
    box.innerHTML = '<span class="hh-empty">Nothing muted yet — type above &amp; hit Enter</span>';
    return;
  }
  settings.concepts.forEach((word) => {
    const chip = document.createElement("div");
    chip.className = "hh-chip";
    const label = document.createElement("span");
    label.textContent = word;
    const del = document.createElement("button");
    del.type = "button";
    del.setAttribute("aria-label", "Remove");
    del.textContent = "×";
    del.addEventListener("click", () => removeFilterWord(word));
    chip.appendChild(label);
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

function renderSoftBlockChips() {
  const box = document.getElementById("hh-account-chips");
  if (!box) return;
  box.innerHTML = "";

  if (!settings.softBlocked.length) {
    box.innerHTML =
      '<span class="hh-empty">No soft-blocked names — type a name fragment &amp; Enter</span>';
    return;
  }

  settings.softBlocked.forEach((word) => {
    const chip = document.createElement("div");
    chip.className = "hh-chip";
    const label = document.createElement("span");
    label.textContent = word;
    const del = document.createElement("button");
    del.type = "button";
    del.setAttribute("aria-label", "Remove");
    del.textContent = "×";
    del.addEventListener("click", () => removeSoftBlock(word));
    chip.appendChild(label);
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

function renderInterestChips() {
  const presets = document.getElementById("hh-interest-presets");
  const active = document.getElementById("hh-interest-active");
  if (!presets || !active) return;

  presets.innerHTML = "";
  INTEREST_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "hh-preset" + (settings.interestLabels.includes(preset.label) ? " active" : "");
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      const set = new Set(settings.interestLabels);
      if (set.has(preset.label)) set.delete(preset.label);
      else set.add(preset.label);
      persistInterests([...set]);
    });
    presets.appendChild(btn);
  });

  active.innerHTML = "";
  if (!settings.interestLabels.length) {
    active.innerHTML =
      '<span class="hh-empty">No interests — timeline stays open. Pick some to focus.</span>';
    return;
  }
  settings.interestLabels.forEach((label) => {
    const chip = document.createElement("div");
    chip.className = "hh-chip hh-chip-interest";
    const span = document.createElement("span");
    span.textContent = label;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", () => {
      persistInterests(settings.interestLabels.filter((l) => l !== label));
    });
    chip.appendChild(span);
    chip.appendChild(del);
    active.appendChild(chip);
  });
}

function startPlaceholderAnimation(placeholderEl, inputEl) {
  clearInterval(placeholderTimer);
  placeholderEl.textContent = PLACEHOLDERS[0];

  const tick = () => {
    if (inputEl.value.trim() || document.activeElement === inputEl) {
      placeholderEl.classList.add("is-hidden");
      return;
    }
    placeholderEl.classList.remove("is-hidden");
    placeholderEl.classList.add("is-fading");
    setTimeout(() => {
      placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
      placeholderEl.textContent = PLACEHOLDERS[placeholderIndex];
      placeholderEl.classList.remove("is-fading");
    }, 150);
  };

  placeholderTimer = setInterval(tick, 900);
}

function bindMuteTab(body) {
  const input = body.querySelector("#hh-input");
  const placeholder = body.querySelector("#hh-placeholder");
  if (!input || !placeholder) return;

  const syncPlaceholder = () => {
    const hide = !!input.value.trim() || document.activeElement === input;
    placeholder.classList.toggle("is-hidden", hide);
  };

  input.addEventListener("focus", syncPlaceholder);
  input.addEventListener("blur", syncPlaceholder);
  input.addEventListener("input", syncPlaceholder);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      input.value = "";
      syncPlaceholder();
      addFilterWord(val);
    }
  });

  renderMuteChips();
  startPlaceholderAnimation(placeholder, input);
}

function bindAccountsTab(body) {
  const input = body.querySelector("#hh-account-input");
  if (!input) return;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      input.value = "";
      addSoftBlock(val);
    }
  });

  renderSoftBlockChips();
}

function bindInterestTab(body) {
  const input = body.querySelector("#hh-interest-input");
  if (!input) return;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      input.value = "";
      const set = new Set(settings.interestLabels);
      set.add(val);
      persistInterests([...set]);
    }
  });
  renderInterestChips();
}

function renderPanelBody(root) {
  const body = root.querySelector(".hh-body");
  if (!body) return;

  body.innerHTML = `
    <div class="hh-tabs">
      <button type="button" class="hh-tab ${activeTab === "mute" ? "active" : ""}" data-tab="mute">Mute</button>
      <button type="button" class="hh-tab ${activeTab === "accounts" ? "active" : ""}" data-tab="accounts">Accounts</button>
      <button type="button" class="hh-tab ${activeTab === "interests" ? "active" : ""}" data-tab="interests">Interests</button>
    </div>
    <div class="hh-tab-panel" id="hh-panel-mute" ${activeTab === "mute" ? "" : "hidden"}>
      <div class="hh-input-wrap">
        <input class="hh-input" id="hh-input" type="text" autocomplete="off" spellcheck="false" />
        <div class="hh-placeholder" id="hh-placeholder"></div>
      </div>
      <div class="hh-section-label">Muted</div>
      <div class="hh-chips" id="hh-mute-chips"></div>
    </div>
    <div class="hh-tab-panel" id="hh-panel-accounts" ${activeTab === "accounts" ? "" : "hidden"}>
      <p class="hh-hint">Hide posts whose display name contains these fragments.</p>
      <div class="hh-input-wrap">
        <input class="hh-input" id="hh-account-input" type="text" placeholder="e.g. casino, news, ..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="hh-section-label">Soft blocked</div>
      <div class="hh-chips" id="hh-account-chips"></div>
    </div>
    <div class="hh-tab-panel" id="hh-panel-interests" ${activeTab === "interests" ? "" : "hidden"}>
      <p class="hh-hint">Keep your signal, hush the rest.</p>
      <div class="hh-presets" id="hh-interest-presets"></div>
      <div class="hh-input-wrap" style="margin-top:10px">
        <input class="hh-input" id="hh-interest-input" type="text" placeholder="Add Custom" autocomplete="off" />
      </div>
      <div class="hh-section-label">Active</div>
      <div class="hh-chips" id="hh-interest-active"></div>
    </div>
    <div class="hh-footer">
      <button type="button" class="hh-link" id="hh-settings">Settings</button>
      <span class="hh-count" id="hh-filtered-count">0 posts hushed</span>
    </div>`;

  body.querySelectorAll(".hh-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      renderPanelBody(root);
    });
  });

  body.querySelector("#hh-settings")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openOptions" });
  });

  if (activeTab === "mute") bindMuteTab(body);
  else if (activeTab === "accounts") bindAccountsTab(body);
  else bindInterestTab(body);
  updateFilteredCountUi();
}

function ensurePanel(forceBody) {
  let root = document.getElementById("hh-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "hh-root";
    root.classList.toggle("hh-light", detectTheme() === "light");
    root.innerHTML = `
      <div class="hh-panel">
        <div class="hh-header">
          <h2 class="hh-title">
            <img class="hh-logo" src="${chrome.runtime.getURL("assets/icons/logo.png")}" alt="" />
            HushHush
          </h2>
          <div class="hh-header-actions">
            <button type="button" class="hh-icon-btn" id="hh-collapse" title="Collapse">–</button>
          </div>
        </div>
        <div class="hh-body"></div>
      </div>`;
    document.documentElement.appendChild(root);

    root.querySelector("#hh-collapse")?.addEventListener("click", () => {
      root.classList.toggle("hh-collapsed");
      const btn = root.querySelector("#hh-collapse");
      if (btn) btn.textContent = root.classList.contains("hh-collapsed") ? "+" : "–";
    });

    renderPanelBody(root);
    return root;
  }

  root.classList.toggle("hh-light", detectTheme() === "light");
  if (forceBody || !root.querySelector(".hh-tabs")) {
    renderPanelBody(root);
  } else {
    renderMuteChips();
    renderSoftBlockChips();
    renderInterestChips();
    updateFilteredCountUi();
  }
  return root;
}

function loadSettingsAndFilter() {
  chrome.storage.sync.get(
    {
      blocked: [],
      allowed: [],
      interestLabels: [],
      randomOn: true,
      randomPercent: 10,
    },
    (sync) => {
      chrome.storage.local.get(
        { aiOn: false, apiKey: "", concepts: [], softBlocked: [] },
        (local) => {
          settings.blocked = (sync.blocked || []).filter(Boolean);
          settings.allowed = (sync.allowed || []).filter(Boolean);
          settings.interestLabels = (sync.interestLabels || []).filter(Boolean);
          settings.randomOn = sync.randomOn;
          settings.randomPercent = sync.randomPercent;
          settings.concepts = (local.concepts || []).filter(Boolean);
          settings.softBlocked = (local.softBlocked || []).filter(Boolean);
          settings.aiOn = !!(local.aiOn && local.apiKey);
          ensurePanel(false);
          filterTweets();
          if (settings.aiOn) scheduleClassify();
        }
      );
    }
  );
}

const observer = new MutationObserver(() => {
  filterTweets();
  if (settings.aiOn) scheduleClassify();
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.storage.onChanged.addListener(() => {
  aiDecision.clear();
  pendingIds.clear();
  loggedTweets.clear();
  loadSettingsAndFilter();
});

loadSettingsAndFilter();
