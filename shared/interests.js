const INTEREST_PRESETS = [
  { id: "game", label: "Game", keywords: ["game", "gaming", "esports", "steam", "playstation", "xbox"] },
  { id: "programming", label: "Programming", keywords: ["programming", "coding", "javascript", "python", "github", "developer"] },
  { id: "ai", label: "AI", keywords: ["AI", "LLM", "ChatGPT", "machine learning", "OpenAI"] },
  { id: "crypto", label: "Crypto", keywords: ["crypto", "bitcoin", "ethereum", "web3"] },
  { id: "design", label: "Design", keywords: ["design", "UI", "UX", "figma"] },
  { id: "startup", label: "Startup", keywords: ["startup", "founder", "venture", "YC"] },
  { id: "football", label: "Football", keywords: ["football", "soccer", "Premier League", "Champions League"] },
  { id: "music", label: "Music", keywords: ["music", "album", "concert", "spotify"] },
  { id: "cinema", label: "Cinema", keywords: ["cinema", "movie", "film", "netflix", "series"] },
  { id: "fa-football", label: "فوتبال", keywords: ["فوتبال", "استقلال", "پرسپولیس", "لیگ برتر"] },
  { id: "fa-code", label: "برنامه‌نویسی", keywords: ["برنامه‌نویسی", "کد", "توسعه‌دهنده", "گیت‌هاب"] },
  { id: "fa-cinema", label: "سینما", keywords: ["سینما", "فیلم", "سریال"] },
  { id: "fa-music", label: "موسیقی", keywords: ["موسیقی", "آهنگ", "کنسرت"] },
];

function keywordsForLabels(labels) {
  try {
    const out = [];
    labels.forEach((label) => {
      const preset = INTEREST_PRESETS.find((p) => p.label === label);
      const list = preset ? preset.keywords : [label];
      list.forEach((k) => {
        if (!out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k);
      });
    });
    return out;
  } catch (error) {
    console.error("Error in keywordsForLabels:", error);
    return [];
  }
}