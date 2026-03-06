import axios from "axios";

const SEARCH_BASE_URL = "https://watvmedia.org/ko/search";
const LOCAL_SERMONS_URL = `${import.meta.env.BASE_URL}sermons.json`;
const EMBEDDING_THRESHOLD = 0.7;
const MAX_RESULTS = 3;
const RECOMMEND_CACHE_KEY = "sermonMeaningCacheV1";
const EMBEDDING_CACHE_KEY = "sermonEmbeddingCacheV1";
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const KEYWORD_MAP = {
  fear: "두려움",
  stress: "스트레스",
  anxiety: "불안",
  worry: "걱정",
  work: "직장",
  family: "가정",
  hope: "소망",
  faith: "믿음",
  prayer: "기도",
  love: "사랑",
};

const geminiKey =
  (typeof process !== "undefined" ? process.env?.GEMINI_API_KEY : undefined) ||
  import.meta.env.VITE_GEMINI_API_KEY ||
  import.meta.env.GEMINI_API_KEY;

function normalizeKeyword(keyword) {
  const lower = String(keyword || "").trim().toLowerCase();
  if (!lower) return "";
  return KEYWORD_MAP[lower] || String(keyword).trim();
}

function hasUsableApiKey(key) {
  if (!key || typeof key !== "string") return false;
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  return !(normalized.includes("your_gemini_api_key_here") || normalized.includes("replace_me"));
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeSermonRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: normalizeWhitespace(item.title || ""),
      url: normalizeWhitespace(item.url || ""),
      category: normalizeWhitespace(item.category || "설교"),
      tags: Array.isArray(item.tags) ? item.tags.map((t) => normalizeWhitespace(t)).filter(Boolean) : [],
      description: normalizeWhitespace(item.description || ""),
      publishedAt: Number(item.publishedAt) || 0,
    }))
    .filter((item) => item.title && item.url);
}

function extractCategory(text) {
  const matched = text.match(/\[(.*?)\]/);
  return matched?.[1]?.trim() || "";
}

function stripLabel(text, label) {
  if (!label) return normalizeWhitespace(text);
  return normalizeWhitespace(String(text || "").replace(label, " "));
}

function parsePublishedAt(text) {
  const source = String(text || "");
  const matched = source.match(/(20\d{2})[.\-/년 ]\s*(\d{1,2})[.\-/월 ]\s*(\d{1,2})/);
  if (!matched) return 0;

  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const timestamp = new Date(year, month, day).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function tokenize(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^0-9a-zA-Z가-힣]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadCache(key) {
  const raw = window.localStorage.getItem(key);
  const parsed = safeJsonParse(raw || "{}", {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function saveCache(key, data) {
  window.localStorage.setItem(key, JSON.stringify(data));
}

function toCacheKey(value) {
  const text = String(value || "");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return `k_${Math.abs(hash >>> 0)}`;
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function geminiGenerateJson(prompt) {
  if (!hasUsableApiKey(geminiKey)) {
    throw new Error("Gemini API key is unavailable");
  }
  const model = import.meta.env.VITE_GEMINI_MODEL || "gemini-2.5-flash-lite";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!response.ok) throw new Error("Gemini generation failed");
  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return safeJsonParse(text, {});
}

async function getEmbedding(text) {
  if (!hasUsableApiKey(geminiKey)) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${geminiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/text-embedding-004",
      content: { parts: [{ text }] },
    }),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload?.embedding?.values || null;
}

async function getEmbeddingCached(text) {
  const cache = loadCache(EMBEDDING_CACHE_KEY);
  const key = toCacheKey(text);
  if (Array.isArray(cache[key])) {
    return cache[key];
  }
  const values = await getEmbedding(text);
  if (Array.isArray(values) && values.length > 0) {
    cache[key] = values;
    saveCache(EMBEDDING_CACHE_KEY, cache);
  }
  return values;
}

function buildMeaningInput(analysis, diaryContent) {
  const emotions = (analysis?.emotions || []).join(", ");
  const keywords = (analysis?.keywords || []).join(", ");
  const theme = analysis?.main_theme?.theme || "";
  const verse = analysis?.main_theme?.verse || "";
  return normalizeWhitespace(
    `감정: ${emotions} 키워드: ${keywords} 주제: ${theme} 말씀: ${verse} 일기내용: ${diaryContent}`,
  );
}

function buildSermonDocument(item) {
  return normalizeWhitespace(
    `제목: ${item.title} 카테고리: ${item.category} 태그: ${(item.tags || []).join(", ")} 설명: ${
      item.description || ""
    } 게시일: ${item.publishedAt || 0}`,
  );
}

function buildAnalysisTerms(analysis, diaryContent) {
  const keywords = Array.isArray(analysis?.keywords) ? analysis.keywords : [];
  const emotions = Array.isArray(analysis?.emotions) ? analysis.emotions : [];
  const theme = analysis?.main_theme?.theme ? [analysis.main_theme.theme] : [];
  const diaryTerms = tokenize(String(diaryContent || "")).slice(0, 20);

  return Array.from(
    new Set(
      [...keywords, ...emotions, ...theme, ...diaryTerms]
        .map((term) => normalizeWhitespace(String(term || "")).toLowerCase())
        .filter((term) => term.length >= 2),
    ),
  );
}

function textRelevanceScore(item, terms) {
  const title = normalizeWhitespace(item.title || "").toLowerCase();
  const description = normalizeWhitespace(item.description || "").toLowerCase();
  const tags = (item.tags || []).map((tag) => normalizeWhitespace(tag).toLowerCase());

  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (description.includes(term)) score += 3;
    if (tags.some((tag) => tag.includes(term))) score += 5;
  }

  // 분량이 너무 짧은 결과보다 설명이 있는 결과를 약간 우대
  if (description.length > 40) score += 1;
  return score;
}

function pickTopByTextRelevance(candidates, analysis, diaryContent, limit = MAX_RESULTS) {
  const terms = buildAnalysisTerms(analysis, diaryContent);
  return candidates
    .map((item) => ({ ...item, textScore: textRelevanceScore(item, terms) }))
    .sort((a, b) => {
      if (b.textScore !== a.textScore) return b.textScore - a.textScore;
      return (b.publishedAt || 0) - (a.publishedAt || 0);
    })
    .slice(0, limit);
}

function localReason(item, analysis) {
  const tags = (item.tags || []).join(", ");
  const theme = analysis?.main_theme?.theme || "주제";
  return `일기 주제(${theme})와 설교 태그(${tags || "없음"})가 유사하여 추천되었습니다.`;
}

async function addReasonsWithGemini(candidates, analysis, diaryContent) {
  if (!candidates.length) return [];
  if (!hasUsableApiKey(geminiKey)) {
    return candidates.map((item) => ({ ...item, reason: localReason(item, analysis) }));
  }

  const prompt = `다음 일기 분석 결과와 설교 목록을 보고 각 설교가 왜 적합한지 한 줄로 설명해.
JSON만 출력:
{"reasons":[{"url":"...","reason":"..."}]}
일기: ${diaryContent}
분석: ${JSON.stringify(analysis)}
설교목록: ${JSON.stringify(candidates.map((x) => ({ title: x.title, url: x.url, tags: x.tags || [] })))} `;

  try {
    const parsed = await geminiGenerateJson(prompt);
    const reasonMap = new Map((parsed?.reasons || []).map((r) => [r.url, r.reason]));
    return candidates.map((item) => ({
      ...item,
      reason: reasonMap.get(item.url) || localReason(item, analysis),
    }));
  } catch {
    return candidates.map((item) => ({ ...item, reason: localReason(item, analysis) }));
  }
}

function parseSermonsFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const links = Array.from(doc.querySelectorAll("a[href]"));
  const picked = [];
  const seen = new Set();

  for (const anchor of links) {
    const href = anchor.getAttribute("href") || "";
    const isMediaLink = href.includes("/ko/media/") || href.includes("/media/");
    if (!isMediaLink) continue;

    const container = anchor.closest("article, li, .item, .post, .search-item, .row, div");
    if (!container) continue;

    const blockText = normalizeWhitespace(container.textContent || "");
    const hdPage = normalizeWhitespace(container.querySelector(".hd-page")?.textContent || "");
    const rawTitle = hdPage || normalizeWhitespace(anchor.getAttribute("title") || anchor.textContent || "");
    if (!rawTitle) continue;

    const category = extractCategory(rawTitle || blockText);
    const hasSermonCategory =
      category === "설교" ||
      rawTitle.includes("[설교]") ||
      blockText.includes("[설교]") ||
      normalizeWhitespace(container.querySelector(".category")?.textContent || "").includes("설교");
    if (!hasSermonCategory) continue;

    const fullUrl = href.startsWith("http") ? href : `https://watvmedia.org${href}`;
    if (seen.has(fullUrl)) continue;

    const tagNodes = Array.from(container.querySelectorAll(".btn-group a, .btn-group button, .btn-group .btn"));
    const tags = tagNodes.map((node) => normalizeWhitespace(node.textContent || "")).filter(Boolean);
    const description = stripLabel(stripLabel(blockText, rawTitle), `[${category || "설교"}]`).slice(0, 260);
    const publishedAt = parsePublishedAt(blockText);

    seen.add(fullUrl);
    picked.push({
      title: rawTitle.replace(/\[설교\]/g, "").trim(),
      url: fullUrl,
      category: "설교",
      tags,
      description,
      publishedAt,
    });
    if (picked.length >= 40) break;
  }

  return picked;
}

async function requestSearchHtml(url) {
  // Browser 환경에서는 watvmedia 원본 도메인 직접 호출이 CORS로 차단되므로 프록시만 시도.
  const isBrowser = typeof window !== "undefined";
  if (!isBrowser) {
    try {
      const direct = await axios.get(url, { timeout: 10000 });
      if (typeof direct.data === "string" && direct.data.trim()) return direct.data;
    } catch {
      // Ignore direct failures and try proxies below.
    }
  }

  for (const buildProxyUrl of CORS_PROXIES) {
    try {
      const proxied = await axios.get(buildProxyUrl(url), { timeout: 12000 });
      if (typeof proxied.data === "string" && proxied.data.trim()) return proxied.data;
    } catch {
      // Try next proxy.
    }
  }

  throw new Error("설교 검색 페이지를 가져오지 못했습니다.");
}

async function loadLocalSermons() {
  try {
    const response = await fetch(LOCAL_SERMONS_URL, { cache: "no-store" });
    if (!response.ok) return [];
    const json = await response.json();
    return normalizeSermonRecords(json);
  } catch {
    return [];
  }
}

async function loadSermonCandidates(analysis, diaryContent, sermonSource = []) {
  if (Array.isArray(sermonSource) && sermonSource.length > 0) {
    return normalizeSermonRecords(sermonSource);
  }

  const localSermons = await loadLocalSermons();
  if (localSermons.length > 0) {
    return localSermons;
  }

  const normalized = Array.isArray(analysis?.keywords)
    ? analysis.keywords.map(normalizeKeyword).filter(Boolean)
    : [];
  const theme = normalizeKeyword(analysis?.main_theme?.theme || "");
  const query = [...normalized, theme, ...tokenize(String(diaryContent || ""))].slice(0, 6).join(" ");
  if (!query) return [];

  const searchUrl = `${SEARCH_BASE_URL}?query=${encodeURIComponent(query)}`;

  if (typeof window !== "undefined") {
    // 브라우저에서는 CORS 이슈 방지를 위해 로컬 sermons.json만 우선 사용.
    return [];
  }

  try {
    const html = await requestSearchHtml(searchUrl);
    return parseSermonsFromHtml(html);
  } catch {
    return [];
  }
}

export async function recommendSermonsByMeaning(analysis, diary_content, sermonSource = []) {
  const cache = loadCache(RECOMMEND_CACHE_KEY);
  const meaningInput = buildMeaningInput(analysis, diary_content);
  const cacheKey = toCacheKey(`${meaningInput}::${JSON.stringify(sermonSource || []).slice(0, 1000)}`);
  if (Array.isArray(cache[cacheKey])) {
    return cache[cacheKey];
  }

  const candidates = await loadSermonCandidates(analysis, diary_content, sermonSource);
  if (!candidates.length) {
    cache[cacheKey] = [];
    saveCache(RECOMMEND_CACHE_KEY, cache);
    return [];
  }

  const textRanked = pickTopByTextRelevance(candidates, analysis, diary_content, MAX_RESULTS);
  const queryEmbedding = await getEmbeddingCached(meaningInput);
  let ranked = [];
  if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
    const scored = [];
    for (const item of candidates) {
      const sermonText = buildSermonDocument(item);
      const sermonEmbedding = await getEmbeddingCached(sermonText);
      const similarity = cosineSimilarity(queryEmbedding, sermonEmbedding);
      if (similarity >= EMBEDDING_THRESHOLD) {
        scored.push({ ...item, similarity });
      }
    }

    ranked = scored
      .sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        return (b.publishedAt || 0) - (a.publishedAt || 0);
      })
      .slice(0, MAX_RESULTS);
  }

  if (!ranked.length) {
    // 임베딩 실패/미달 시 최신순이 아니라 일기 연관도 기반으로 선택
    ranked = textRanked;
  } else {
    // 임베딩 매칭이 있어도 텍스트 연관도를 보조 점수로 반영
    const textScoreByUrl = new Map(textRanked.map((item) => [item.url, item.textScore || 0]));
    ranked = ranked
      .map((item) => ({ ...item, textScore: textScoreByUrl.get(item.url) || 0 }))
      .sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        if ((b.textScore || 0) !== (a.textScore || 0)) return (b.textScore || 0) - (a.textScore || 0);
        return (b.publishedAt || 0) - (a.publishedAt || 0);
      })
      .slice(0, MAX_RESULTS);
  }

  const withReasons = await addReasonsWithGemini(ranked, analysis, diary_content);
  const result = withReasons.map((item) => ({
    title: item.title,
    url: item.url,
    reason: item.reason,
  }));

  cache[cacheKey] = result;
  saveCache(RECOMMEND_CACHE_KEY, cache);
  return result;
}

export async function recommendSermon(keywords, diaryContent = "", analysis = null) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords : [keywords];
  const normalizedAnalysis =
    analysis && typeof analysis === "object"
      ? analysis
      : {
          emotions: [],
          keywords: normalizedKeywords.filter(Boolean),
          main_theme: { theme: "", verse: "" },
        };
  return recommendSermonsByMeaning(normalizedAnalysis, diaryContent);
}
