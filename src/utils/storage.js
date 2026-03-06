const DIARY_KEY = "diaryEntries";

function parseDiaries(rawValue) {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
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

export function getAllDiaries() {
  return parseDiaries(window.localStorage.getItem(DIARY_KEY));
}

export function saveDiary(entry) {
  if (!entry || typeof entry.date !== "string" || typeof entry.content !== "string") {
    return;
  }

  const diaries = getAllDiaries();
  const updated = [...diaries, { date: entry.date, content: entry.content }];
  window.localStorage.setItem(DIARY_KEY, JSON.stringify(updated));
}

export function clearDiaries() {
  window.localStorage.removeItem(DIARY_KEY);
}
