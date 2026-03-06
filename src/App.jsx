import { useEffect, useMemo, useState } from "react";
import { analyzeDiary, analyzeDiaryLocally } from "./services/openaiService.js";
import { recommendSermonsByMeaning } from "./services/api.js";
import { clearDiaries, getAllDiaries, saveDiary } from "./utils/storage.js";

const today = new Date().toISOString().slice(0, 10);
const FLOW_CACHE_KEY = "diaryFlowCacheV1";
const MAX_FLOW_CACHE_ENTRIES = 40;

function hydrateSavedDiaries() {
  return getAllDiaries()
    .slice()
    .reverse()
    .map((entry, index) => ({
      id: `saved-${index}-${entry.date}`,
      ...entry,
      analysis: { emotions: [], keywords: [] },
      recommendations: [],
    }));
}

function loadFlowCache() {
  try {
    const raw = window.localStorage.getItem(FLOW_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function makeCacheKey(text) {
  const source = String(text || "");
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 33) ^ source.charCodeAt(i);
  }
  return `flow_${Math.abs(hash >>> 0)}`;
}

function upsertFlowCache(prev, key, payload) {
  const next = { ...prev, [key]: { ...payload, updatedAt: Date.now() } };
  const entries = Object.entries(next).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_FLOW_CACHE_ENTRIES));
}

export default function App() {
  const [date, setDate] = useState(today);
  const [content, setContent] = useState("");
  const [diaries, setDiaries] = useState(hydrateSavedDiaries);
  const [flowCache, setFlowCache] = useState(loadFlowCache);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRecommending, setIsRecommending] = useState(false);

  // Firebase 확장 준비 (추후 활성화)
  // import { saveDiaryToFirestore, getDiariesFromFirestore } from "./services/firebaseDiary.js";

  useEffect(() => {
    window.localStorage.setItem(FLOW_CACHE_KEY, JSON.stringify(flowCache));
  }, [flowCache]);

  const loadingText = useMemo(() => {
    if (isRecommending) return "설교 추천을 불러오는 중...";
    if (isAnalyzing) return "일기 감정/키워드를 분석하는 중...";
    if (isSubmitting) return "일기를 저장하는 중...";
    return "";
  }, [isAnalyzing, isRecommending, isSubmitting]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = content.trim();

    if (!trimmed) {
      setError("일기를 작성해주세요");
      return;
    }

    setError("");
    setIsSubmitting(true);

    const baseEntry = { date, content: trimmed };

    try {
      // Local-first 저장. Firebase 연동 시 이 지점을 대체합니다.
      saveDiary(baseEntry);

      // Firebase hooks (for later integration)
      // await saveDiaryToFirebase(baseEntry);
      // const firebaseDiaries = await fetchDiariesFromFirebase();

      const cacheKey = makeCacheKey(trimmed);
      const cached = flowCache[cacheKey];
      let analysis;
      let recommendations;

      if (cached?.analysis && Array.isArray(cached?.recommendations)) {
        analysis = cached.analysis;
        recommendations = cached.recommendations;
      } else {
        setIsAnalyzing(true);
        let usedLocalFallback = false;
        try {
          analysis = await analyzeDiary(trimmed);
        } catch (analysisError) {
          usedLocalFallback = true;
          analysis = analyzeDiaryLocally(trimmed);
          setError(
            `${analysisError?.message || "AI 분석에 실패했습니다."} 로컬 분석으로 계속 진행합니다.`,
          );
        }
        setIsAnalyzing(false);

        setIsRecommending(true);
        recommendations = await recommendSermonsByMeaning(analysis, trimmed);
        setIsRecommending(false);

        setFlowCache((prev) => upsertFlowCache(prev, cacheKey, { analysis, recommendations }));
        if (!usedLocalFallback) {
          setError("");
        }
      }

      const enrichedEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...baseEntry,
        analysis,
        recommendations,
      };

      setDiaries((prev) => [enrichedEntry, ...prev]);
      setContent("");
      setDate(today);
    } catch (requestError) {
      setError(requestError?.message || "분석/추천 처리 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
      setIsAnalyzing(false);
      setIsRecommending(false);
    }
  };

  const handleClearLocal = () => {
    clearDiaries();
    setDiaries([]);
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl bg-slate-50 px-4 py-8 text-slate-900 sm:px-6">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Diary Sermon App</h1>
          <p className="mt-1 text-sm text-slate-600">
            저장 후 AI가 감정/키워드를 추출하고 WATV 설교를 추천합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={handleClearLocal}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:w-auto"
        >
          Clear Local Diaries
        </button>
      </header>

      <form
        onSubmit={handleSubmit}
        className="mb-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <label htmlFor="date" className="mb-2 block text-sm font-semibold text-slate-700">
          Date
        </label>
        <input
          id="date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />

        <label htmlFor="content" className="mb-2 block text-sm font-semibold text-slate-700">
          Content
        </label>
        <textarea
          id="content"
          rows="6"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="오늘의 감정, 고민, 감사한 일들을 기록해 보세요."
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />

        <button
          type="submit"
          disabled={isSubmitting || isAnalyzing || isRecommending}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-300"
        >
          {isSubmitting || isAnalyzing || isRecommending ? "Processing..." : "Save + Analyze + Recommend"}
        </button>

        {loadingText ? <p className="mt-3 text-sm text-blue-700">{loadingText}</p> : null}
        {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
      </form>

      <section className="space-y-3">
        {diaries.length === 0 ? (
          <div className="rounded-2xl bg-white p-5 text-slate-600 shadow-sm ring-1 ring-slate-200">
            저장된 일기가 없습니다.
          </div>
        ) : (
          diaries.map((entry) => (
            <article key={entry.id} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <p className="mb-1 text-sm text-slate-500">{entry.date}</p>
              <p className="mb-3 whitespace-pre-wrap text-slate-800">{entry.content}</p>

              <div className="mb-3">
                <p className="text-sm font-semibold text-slate-700">Emotions</p>
                {entry.analysis?.emotions?.length ? (
                  <p className="text-sm text-slate-600">{entry.analysis.emotions.join(", ")}</p>
                ) : (
                  <p className="text-sm text-slate-400">분석 전 또는 결과 없음</p>
                )}
              </div>

              <div className="mb-3">
                <p className="text-sm font-semibold text-slate-700">Keywords</p>
                {entry.analysis?.keywords?.length ? (
                  <p className="text-sm text-slate-600">{entry.analysis.keywords.join(", ")}</p>
                ) : (
                  <p className="text-sm text-slate-400">분석 전 또는 결과 없음</p>
                )}
              </div>

              <div className="mb-3 rounded-lg bg-indigo-50 p-3">
                <p className="text-sm font-semibold text-indigo-800">성경 연결</p>
                <p className="text-sm text-indigo-700">
                  주제: {entry.analysis?.main_theme?.theme || "없음"} / 말씀:{" "}
                  {entry.analysis?.main_theme?.verse || "없음"}
                </p>
                <p className="mt-1 text-xs text-indigo-600">
                  감정 강도: {typeof entry.analysis?.intensity === "number" ? entry.analysis.intensity : "-"} / 10
                </p>
              </div>

              <div>
                <p className="mb-1 text-sm font-semibold text-slate-700">Recommended Sermon</p>
                {entry.recommendations?.length ? (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {entry.recommendations.map((item, index) => (
                      <li key={`${item.url}-${index}`} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <p className="font-semibold text-slate-800">{item.title}</p>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 underline decoration-blue-300 underline-offset-2"
                        >
                          {item.url}
                        </a>
                        {item.reason ? <p className="mt-1 text-xs text-slate-500">이유: {item.reason}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-400">추천 결과 없음</p>
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
