const geminiKey =
  (typeof process !== "undefined" ? process.env?.GEMINI_API_KEY : undefined) ||
  import.meta.env.VITE_GEMINI_API_KEY ||
  import.meta.env.GEMINI_API_KEY;

function hasUsableApiKey(key) {
  if (!key || typeof key !== "string") return false;
  const normalized = key.trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (
    lower.includes("your_gemini_api_key_here") ||
    lower.includes("your-gemini-api-key") ||
    lower.includes("replace_me")
  ) {
    return false;
  }

  return true;
}

const EMOTION_RULES = [
  { emotion: "믿음 부족", terms: ["fear", "afraid", "scared", "두려움", "무섭", "불안"] },
  { emotion: "회개", terms: ["guilt", "shame", "죄책", "자책", "후회"] },
  { emotion: "인내 필요", terms: ["stress", "stressed", "pressure", "스트레스", "압박"] },
  { emotion: "위로 필요", terms: ["sad", "tired", "empty", "슬픔", "우울", "지침"] },
  { emotion: "감사", terms: ["grateful", "thankful", "감사", "고마"] },
  { emotion: "소망", terms: ["hope", "faith", "소망", "희망", "믿음"] },
];

const STOPWORDS = new Set([
  "그리고",
  "하지만",
  "정말",
  "너무",
  "오늘",
  "어제",
  "the",
  "and",
  "for",
  "with",
  "that",
  "have",
  "this",
  "from",
  "were",
  "been",
]);

const THEME_VERSE_MAP = {
  감사: "시편 100:4",
  회개: "요한일서 1:9",
  소망: "로마서 15:13",
  믿음: "히브리서 11:1",
  두려움: "디모데후서 1:7",
  위로: "고린도후서 1:3-4",
  인내: "야고보서 1:2-4",
};

function inferMainTheme(emotions, keywords) {
  const merged = [...(emotions || []), ...(keywords || [])].join(" ");
  if (merged.includes("감사")) return { theme: "감사", verse: THEME_VERSE_MAP.감사 };
  if (merged.includes("회개")) return { theme: "회개", verse: THEME_VERSE_MAP.회개 };
  if (merged.includes("소망")) return { theme: "소망", verse: THEME_VERSE_MAP.소망 };
  if (merged.includes("믿음")) return { theme: "믿음", verse: THEME_VERSE_MAP.믿음 };
  if (merged.includes("두려") || merged.includes("불안")) return { theme: "두려움", verse: THEME_VERSE_MAP.두려움 };
  if (merged.includes("우울") || merged.includes("위로")) return { theme: "위로", verse: THEME_VERSE_MAP.위로 };
  if (merged.includes("인내") || merged.includes("압박")) return { theme: "인내", verse: THEME_VERSE_MAP.인내 };
  return { theme: "믿음", verse: THEME_VERSE_MAP.믿음 };
}

function normalizeAnalysis(parsed) {
  const emotions = Array.isArray(parsed?.emotions)
    ? parsed.emotions.filter((value) => typeof value === "string" && value.trim())
    : [];
  const keywords = Array.isArray(parsed?.keywords)
    ? parsed.keywords.filter((value) => typeof value === "string" && value.trim())
    : [];
  const rawIntensity = Number(parsed?.intensity);
  const intensity = Number.isFinite(rawIntensity)
    ? Math.max(1, Math.min(10, Math.round(rawIntensity)))
    : 5;

  const main_theme =
    parsed?.main_theme && typeof parsed.main_theme === "object"
      ? {
          theme: typeof parsed.main_theme.theme === "string" ? parsed.main_theme.theme : inferMainTheme(emotions, keywords).theme,
          verse: typeof parsed.main_theme.verse === "string" ? parsed.main_theme.verse : inferMainTheme(emotions, keywords).verse,
        }
      : inferMainTheme(emotions, keywords);

  return {
    emotions: emotions.length ? emotions : ["믿음 점검"],
    keywords,
    intensity,
    main_theme,
  };
}

export function analyzeDiaryLocally(diary_content) {
  const text = String(diary_content || "");
  const lower = text.toLowerCase();

  const emotions = EMOTION_RULES.filter((rule) => rule.terms.some((term) => lower.includes(term))).map(
    (rule) => rule.emotion,
  );

  const keywords = Array.from(
    new Set(
      lower
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
    ),
  ).slice(0, 6);

  const themeInfo = inferMainTheme(emotions, keywords);
  const intensity = Math.max(1, Math.min(10, Math.round(Math.min(10, text.length / 40) || 3)));

  return {
    emotions: emotions.length ? emotions : ["믿음 점검"],
    keywords,
    intensity,
    main_theme: themeInfo,
  };
}

export async function analyzeDiary(diary_content) {
  if (!hasUsableApiKey(geminiKey)) {
    return analyzeDiaryLocally(diary_content);
  }

  const model = import.meta.env.VITE_GEMINI_MODEL || "gemini-2.5-flash-lite";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
  const prompt = `너는 일기의 감정을 성경적 관점으로 재해석하는 분석가다.
반드시 JSON만 출력하고 설명문은 쓰지 마라.

출력 스키마:
{
  "emotions": ["성경적 감정 라벨"],
  "keywords": ["핵심 키워드"],
  "intensity": 1,
  "main_theme": {
    "theme": "주제",
    "verse": "성경구절"
  }
}

규칙:
- emotions는 일반 심리 용어보다 성경적 관점을 우선한다.
  예) "죄책감" -> "회개", "두려움" -> "믿음 부족"
- intensity는 1~10 정수.
- main_theme.verse는 주제와 맞는 실제 성경 구절로 제시.

Few-shot 예시 1:
입력: "오늘 실수한 일이 계속 떠올라 마음이 무겁고 죄책감이 든다."
출력:
{"emotions":["회개","위로 필요"],"keywords":["실수","죄책감","마음"],"intensity":7,"main_theme":{"theme":"회개","verse":"요한일서 1:9"}}

Few-shot 예시 2:
입력: "앞으로의 진로가 너무 불안하고 두렵다. 기도하지만 믿음이 약해진 것 같다."
출력:
{"emotions":["믿음 부족","소망"],"keywords":["진로","불안","기도","믿음"],"intensity":8,"main_theme":{"theme":"두려움","verse":"디모데후서 1:7"}}

Few-shot 예시 3:
입력: "작은 일에도 감사가 나왔다. 오늘 하루 지켜주심이 느껴졌다."
출력:
{"emotions":["감사","소망"],"keywords":["감사","하루","지켜주심"],"intensity":4,"main_theme":{"theme":"감사","verse":"시편 100:4"}}

Few-shot 예시 4:
입력: "압박감이 커서 지치지만 끝까지 인내하고 싶다."
출력:
{"emotions":["인내 필요","소망"],"keywords":["압박감","지침","인내"],"intensity":6,"main_theme":{"theme":"인내","verse":"야고보서 1:2-4"}}

분석할 일기:
${diary_content}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const status = response.status;
      const message = errorPayload?.error?.message || "Gemini API 호출에 실패했습니다.";
      const apiError = new Error(message);
      apiError.status = status;
      throw apiError;
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(text);
    return normalizeAnalysis(parsed);
  } catch (error) {
    return analyzeDiaryLocally(diary_content);
  }
}
