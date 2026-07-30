const interestGrid = document.getElementById("interestGrid");
const selectedEl = document.getElementById("selectedInterests");
const customInterest = document.getElementById("customInterest");
const addInterestBtn = document.getElementById("addInterest");
const startBtn = document.getElementById("startBtn");
const startStatus = document.getElementById("startStatus");
const providerEl = document.getElementById("provider");
const customFields = document.getElementById("customFields");
const customUrl = document.getElementById("customUrl");
const customModel = document.getElementById("customModel");
const apiKeyEl = document.getElementById("apiKey");
const testAiBtn = document.getElementById("testAi");
const aiStatus = document.getElementById("aiStatus");

const selected = new Map();

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function renderSelected() {
  selectedEl.innerHTML = "";
  selected.forEach((_kw, label) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    const text = document.createElement("span");
    text.textContent = label;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", () => {
      selected.delete(label);
      document.querySelectorAll(".chip").forEach((btn) => {
        if (btn.dataset.label === label) btn.classList.remove("active");
      });
      renderSelected();
    });
    tag.appendChild(text);
    tag.appendChild(del);
    selectedEl.appendChild(tag);
  });
}

INTEREST_PRESETS.forEach((preset) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip";
  btn.dataset.label = preset.label;
  btn.textContent = preset.label;
  btn.addEventListener("click", () => {
    if (selected.has(preset.label)) {
      selected.delete(preset.label);
      btn.classList.remove("active");
    } else {
      selected.set(preset.label, preset.keywords);
      btn.classList.add("active");
    }
    renderSelected();
  });
  interestGrid.appendChild(btn);
});

function addCustom() {
  const label = customInterest.value.trim();
  if (!label) return;
  selected.set(label, [label]);
  customInterest.value = "";
  renderSelected();
}

addInterestBtn.addEventListener("click", addCustom);
customInterest.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCustom();
});

function updateProviderUi() {
  customFields.classList.toggle("hidden", providerEl.value !== "custom");
}
providerEl.addEventListener("change", updateProviderUi);

chrome.storage.sync.get({ allowed: [], interestLabels: [] }, (sync) => {
  try {
    (sync.interestLabels || []).forEach((label) => {
      const preset = INTEREST_PRESETS.find((p) => p.label === label);
      selected.set(label, preset ? preset.keywords : [label]);
    });
    if (!(sync.interestLabels || []).length && (sync.allowed || []).length) {
      sync.allowed.forEach((w) => selected.set(w, [w]));
    }
    document.querySelectorAll(".chip").forEach((btn) => {
      if (selected.has(btn.dataset.label)) btn.classList.add("active");
    });
    renderSelected();
  } catch (error) {
    console.error("Error loading interests from storage:", error);
  }
});

chrome.storage.local.get(
  { apiKey: "", provider: "groq", customUrl: "", customModel: "" },
  (data) => {
    try {
      apiKeyEl.value = data.apiKey || "";
      providerEl.value = data.provider || "groq";
      customUrl.value = data.customUrl || "";
      customModel.value = data.customModel || "";
      updateProviderUi();
    } catch (error) {
      console.error("Error loading local settings:", error);
    }
  }
);

testAiBtn.addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) {
    setStatus(aiStatus, "Add a key only if you want AI mode.", "err");
    return;
  }
  setStatus(aiStatus, "Testing…");
  try {
    chrome.storage.local.set(
      {
        apiKey,
        provider: providerEl.value,
        customUrl: customUrl.value.trim(),
        customModel: customModel.value.trim(),
        aiOn: true,
      },
      () => {
        try {
          chrome.runtime.sendMessage({ type: "testAi" }, (res) => {
            try {
              if (chrome.runtime.lastError || !res?.ok) {
                setStatus(
                  aiStatus,
                  "Couldn’t connect — " + (res?.error || chrome.runtime.lastError?.message || "check key"),
                  "err"
                );
                return;
              }
              setStatus(aiStatus, "Connected.", "ok");
            } catch (error) {
              console.error("Error in testAi response:", error);
              setStatus(aiStatus, "Error testing connection", "err");
            }
          });
        } catch (error) {
          console.error("Error sending testAi message:", error);
          setStatus(aiStatus, "Error testing connection", "err");
        }
      }
    );
  } catch (error) {
    console.error("Error in testAi click:", error);
    setStatus(aiStatus, "Error saving settings", "err");
  }
});

startBtn.addEventListener("click", () => {
  try {
    const interestLabels = [...selected.keys()];
    const allowed = keywordsForLabels(interestLabels);
    const apiKey = apiKeyEl.value.trim();

    chrome.storage.sync.set(
      {
        allowed,
        interestLabels,
        onboarded: true,
        randomOn: interestLabels.length > 0,
        randomPercent: 10,
      },
      () => {
        try {
          chrome.storage.local.set(
            {
              provider: providerEl.value,
              customUrl: customUrl.value.trim(),
              customModel: customModel.value.trim(),
              apiKey,
              aiOn: !!apiKey,
            },
            () => {
              try {
                setStatus(
                  startStatus,
                  interestLabels.length
                    ? "Saved. Opening X…"
                    : "Saved. Add mutes anytime from the panel.",
                  "ok"
                );
                startBtn.textContent = "Ready";
                setTimeout(() => chrome.tabs.create({ url: "https://x.com/home" }), 400);
              } catch (error) {
                console.error("Error in startBtn callback:", error);
                setStatus(startStatus, "Error saving settings", "err");
              }
            }
          );
        } catch (error) {
          console.error("Error saving local settings:", error);
          setStatus(startStatus, "Error saving settings", "err");
        }
      }
    );
  } catch (error) {
    console.error("Error in startBtn click:", error);
    setStatus(startStatus, "Error saving settings", "err");
  }
});