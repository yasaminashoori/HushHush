chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "options/index.html" });
  }
});

const PROVIDERS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o-mini",
  },
};

const decisionCache = new Map();
const CACHE_LIMIT = 500;

function decisionKey(text, allow, block, concepts) {
  return [text.slice(0, 400), allow.join("|"), block.join("|"), concepts.join("|")].join("::");
}

function cachePut(key, value) {
  if (decisionCache.size > CACHE_LIMIT) {
    decisionCache.delete(decisionCache.keys().next().value);
  }
  decisionCache.set(key, value);
}

// adding error handling
async function loadConfig() {
  try {
    const local = await chrome.storage.local.get({
      aiOn: false,
      apiKey: "",
      provider: "groq",
      customUrl: "",
      customModel: "",
      concepts: [],
    });
    const sync = await chrome.storage.sync.get({ allowed: [], blocked: [] });
    return {
      ...local,
      allowed: sync.allowed || [],
      blocked: sync.blocked || [],
    };
  } catch (error) {
    console.error("Error in loadConfig:", error);
    return {
      aiOn: false,
      apiKey: "",
      provider: "groq",
      customUrl: "",
      customModel: "",
      concepts: [],
      allowed: [],
      blocked: [],
    };
  }
}

async function chat(messages, config) {
  if (!config.apiKey) throw new Error("API key missing");

  let url;
  let model;
  if (config.provider === "custom") {
    url = config.customUrl;
    model = config.customModel || "gpt-4o-mini";
  } else {
    const p = PROVIDERS[config.provider] || PROVIDERS.groq;
    url = p.url;
    model = p.model;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function classifyMessages(tweets, config) {
  const interests = config.allowed.length ? config.allowed.join(", ") : "(none)";
  const blocked = config.blocked.length ? config.blocked.join(", ") : "(none)";
  const concepts = config.concepts.length ? config.concepts.join(", ") : "(none)";

  return [
    {
      role: "system",
      content:
        "Classify X posts for a feed filter. Return JSON only: " +
        '{"results":[{"id":"t0","show":true,"reason":"..."}]}\n' +
        "Hide if HARD BLOCK or MUTE CONCEPTS match (semantic ok). " +
        "If INTERESTS exist, show only related posts. Prefer show when unsure.",
    },
    {
      role: "user",
      content:
        `INTERESTS: ${interests}\nHARD BLOCK: ${blocked}\nMUTE CONCEPTS: ${concepts}\n\n` +
        tweets.map((t, i) => `[t${i}] ${t}`).join("\n\n"),
    },
  ];
}

// adding error handling
async function classifyBatch(texts) {
  try {
    const config = await loadConfig();
    if (!config.aiOn || !config.apiKey) {
      return texts.map(() => ({ show: null, reason: "off", source: "off" }));
    }

    const results = new Array(texts.length);
    const pendingIdx = [];
    const pendingText = [];

    texts.forEach((text, i) => {
      const key = decisionKey(text, config.allowed, config.blocked, config.concepts);
      if (decisionCache.has(key)) {
        results[i] = { ...decisionCache.get(key), source: "cache" };
      } else {
        pendingIdx.push(i);
        pendingText.push(text.slice(0, 500));
      }
    });

    const size = 8;
    for (let start = 0; start < pendingText.length; start += size) {
      const sliceText = pendingText.slice(start, start + size);
      const sliceIdx = pendingIdx.slice(start, start + size);
      try {
        const parsed = await chat(classifyMessages(sliceText, config), config);
        const list = Array.isArray(parsed.results) ? parsed.results : [];
        sliceIdx.forEach((orig, j) => {
          const item = list.find((r) => r.id === `t${j}`) || list[j] || {};
          const decision = { show: item.show !== false, reason: item.reason || "" };
          cachePut(decisionKey(texts[orig], config.allowed, config.blocked, config.concepts), decision);
          results[orig] = { ...decision, source: "llm" };
        });
      } catch (err) {
        sliceIdx.forEach((orig) => {
          results[orig] = { show: true, reason: String(err.message || err), source: "error" };
        });
      }
    }

    return results;
  } catch (error) {
    console.error("Error in classifyBatch:", error);
    return texts.map(() => ({ show: true, reason: "error", source: "error" }));
  }
}

// adding error handling
async function suggestMutes(tweetText) {
  try {
    const config = await loadConfig();
    if (!config.apiKey) throw new Error("API key missing");

    const parsed = await chat(
      [
        {
          role: "system",
          content:
            'Suggest exactly 3 short mute phrases for a disliked post. Match the post language. JSON: {"reasons":["...","...","..."]}',
        },
        { role: "user", content: tweetText.slice(0, 800) },
      ],
      config
    );

    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3) : [];
    while (reasons.length < 3) reasons.push("off-topic");
    return reasons;
  } catch (error) {
    console.error("Error in suggestMutes:", error);
    return ["spam", "off-topic", "AI slop"];
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "classify") {
    classifyBatch(msg.texts || [])
      .then((results) => reply({ ok: true, results }))
      .catch((e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "bounceSuggest") {
    suggestMutes(msg.text || "")
      .then((reasons) => reply({ ok: true, reasons }))
      .catch((e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "clearAiCache") {
    decisionCache.clear();
    reply({ ok: true });
    return false;
  }

  if (msg.type === "testAi") {
    loadConfig()
      .then((config) =>
        chat(
          [
            { role: "system", content: 'Reply JSON: {"ok":true}' },
            { role: "user", content: "ping" },
          ],
          config
        )
      )
      .then((parsed) => reply({ ok: true, parsed }))
      .catch((e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "openOptions") {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: "options/index.html" });
    reply({ ok: true });
    return false;
  }
});