import { useMemo, useState } from "react";
import { recommendSermon } from "../services/api.js";
import { analyzeDiary } from "../services/openaiService.js";

const STORAGE_KEY = "diaryEntries";

function getInitialDate() {
  return new Date().toISOString().slice(0, 10);
}

function loadEntries() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.date === "string" &&
        typeof item.content === "string",
    );
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export default function DiaryEntryForm() {
  const [date, setDate] = useState(getInitialDate);
  const [content, setContent] = useState("");
  const [entries, setEntries] = useState(loadEntries);
  const [recommendations, setRecommendations] = useState([]);
  const [analysisResult, setAnalysisResult] = useState({ emotions: [], keywords: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const latestEntry = useMemo(() => entries[0], [entries]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) {
      setError("내용을 입력해 주세요.");
      return;
    }

    const newEntry = { date, content: trimmed };
    const nextEntries = [newEntry, ...entries];
    setEntries(nextEntries);
    saveEntries(nextEntries);
    setContent("");
    setError("");
  };

  const handleAnalyze = async () => {
    const targetText = content.trim() || latestEntry?.content || "";
    if (!targetText) {
      setError("분석할 일기 내용이 없습니다.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const analysis = await analyzeDiary(targetText);
      const items = await recommendSermon(analysis.keywords);
      setRecommendations(items);
      setAnalysisResult(analysis);
    } catch (analysisError) {
      setError(analysisError?.message || "설교 추천 또는 일기 분석에 실패했습니다.");
      setRecommendations([]);
      setAnalysisResult({ emotions: [], keywords: [] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-4xl bg-slate-50 px-4 py-8 text-slate-900 sm:px-6">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Diary Entry Form</h1>

      <form
        onSubmit={handleSubmit}
        className="mb-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <label htmlFor="date" className="mb-2 block text-sm font-semibold text-slate-700">
          Date
        </label>
        <input
          id="date"
          name="date"
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
          name="content"
          rows="6"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="오늘의 묵상, 기도 제목, 감사한 일을 기록해 보세요."
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Save Entry
          </button>
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={loading}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-wait disabled:bg-emerald-300"
          >
            {loading ? "Analyzing..." : "Analyze & Recommend Sermon"}
          </button>
        </div>
      </form>

      {error ? <p className="mb-4 text-sm font-semibold text-rose-600">{error}</p> : null}

      <section className="mb-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-3 text-xl font-semibold">Sermon Recommendations</h2>
        {recommendations.length === 0 ? (
          <p className="text-slate-600">아직 추천 결과가 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {recommendations.map((item, index) => (
              <li
                key={item.url || `${item.title}-${index}`}
                className="rounded-lg border border-slate-200 p-3"
              >
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2"
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-3 text-xl font-semibold">Diary Analysis</h2>
        <p className="mb-2 text-sm font-semibold text-slate-700">Emotions</p>
        {analysisResult.emotions.length === 0 ? (
          <p className="mb-3 text-slate-600">아직 감정 분석 결과가 없습니다.</p>
        ) : (
          <ul className="mb-3 flex flex-wrap gap-2">
            {analysisResult.emotions.map((emotion, index) => (
              <li
                key={`${emotion}-${index}`}
                className="rounded-full bg-rose-100 px-3 py-1 text-sm text-rose-700"
              >
                {emotion}
              </li>
            ))}
          </ul>
        )}

        <p className="mb-2 text-sm font-semibold text-slate-700">Keywords</p>
        {analysisResult.keywords.length === 0 ? (
          <p className="text-slate-600">아직 키워드 분석 결과가 없습니다.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {analysisResult.keywords.map((keyword, index) => (
              <li
                key={`${keyword}-${index}`}
                className="rounded-full bg-blue-100 px-3 py-1 text-sm text-blue-700"
              >
                {keyword}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-3 text-xl font-semibold">Past Entries</h2>
        {entries.length === 0 ? (
          <p className="text-slate-600">저장된 일기가 없습니다.</p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry, index) => (
              <li key={`${entry.date}-${index}`} className="rounded-lg border border-slate-200 p-3">
                <p className="mb-1">
                  <strong>{entry.date}</strong>
                </p>
                <p className="whitespace-pre-wrap text-slate-700">{entry.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
