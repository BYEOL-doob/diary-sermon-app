import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE_URL = "https://watvmedia.org/ko/media/list";
const OUTPUT_FILE = "sermons.json";
const PUBLIC_OUTPUT_FILE = "public/sermons.json";
const MAX_PAGES = 5;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  return candidates.find((path) => existsSync(path));
}

function absoluteUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return `https://watvmedia.org${href}`;
}

function normalizeTitle(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isBadTitle(text) {
  const title = normalizeTitle(text);
  if (!title) return true;
  if (/^재생시간\s*\d{1,2}:\d{2}/.test(title)) return true;
  if (/^HTTP 상태\s*\d+/.test(title)) return true;
  if (title.includes("잘못된 요청")) return true;
  return false;
}

async function waitForSermonList(page) {
  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector(".media-item") ||
        !!document.querySelector(".sermon-item") ||
        !!document.querySelector(".hd-page") ||
        !!document.querySelector('a[href*="/ko/media/"]') ||
        document.body.innerText.includes("[설교]"),
      { timeout: 60000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function collectListItems(page) {
  return page.evaluate(() => {
    function normalizeTitleInPage(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }
    function isBadTitleInPage(text) {
      const title = normalizeTitleInPage(text);
      if (!title) return true;
      if (/^재생시간\s*\d{1,2}:\d{2}/.test(title)) return true;
      if (/^HTTP 상태\s*\d+/.test(title)) return true;
      if (title.includes("잘못된 요청")) return true;
      return false;
    }

    const cards = Array.from(
      document.querySelectorAll(".media-item, .sermon-item, article, li, .item, .search-item, .content-item"),
    );
    const links = [];
    const seen = new Set();

    for (const card of cards) {
      const link = card.querySelector('a[href*="/ko/media/"], a[href*="/media/"]');
      if (!link) continue;

      const titleCandidates = [
        card.querySelector(".hd-page"),
        card.querySelector("h3 a"),
        card.querySelector("h3"),
        card.querySelector(".title"),
        card.querySelector(".subject"),
        link,
      ];
      let title = "";
      for (const node of titleCandidates) {
        if (!node) continue;
        const candidate = normalizeTitleInPage(node.textContent || node.getAttribute?.("title") || "");
        if (!isBadTitleInPage(candidate)) {
          title = candidate;
          break;
        }
      }
      const url = link.getAttribute("href") || "";
      const descriptionNode = card.querySelector("p, .inner-text, .description, .summary");
      const description = (descriptionNode?.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || !url) continue;
      const key = `${title}::${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({ title, url, description });
    }

    // Fallback: grab any media links on the page.
    if (links.length === 0) {
      const allMediaLinks = Array.from(document.querySelectorAll('a[href*="/ko/media/"], a[href*="/media/"]'));
      for (const link of allMediaLinks) {
        const card = link.closest("article, li, .item, .search-item, .row, div") || document.body;
        const titleCandidates = [
          card.querySelector(".hd-page"),
          card.querySelector("h3 a"),
          card.querySelector("h3"),
          card.querySelector(".title"),
          card.querySelector(".subject"),
          link,
        ];
        let title = "";
        for (const node of titleCandidates) {
          if (!node) continue;
          const candidate = normalizeTitleInPage(node.textContent || node.getAttribute?.("title") || "");
          if (!isBadTitleInPage(candidate)) {
            title = candidate;
            break;
          }
        }
        const url = link.getAttribute("href") || "";
        const descriptionNode = card.querySelector("p, .inner-text, .description, .summary");
        const description = (descriptionNode?.textContent || "").replace(/\s+/g, " ").trim();
        if (!title || !url) continue;
        const key = `${title}::${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ title, url, description });
      }
    }

    return links;
  });
}

async function getTotalPages(page) {
  try {
    return await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("div.paging a, .paging a"));
      let max = 1;
      for (const a of anchors) {
        const textNum = Number((a.textContent || "").trim());
        if (Number.isFinite(textNum) && textNum > max) max = textNum;

        const onclick = a.getAttribute("onclick") || "";
        const onclickMatch = onclick.match(/paging\(['"]?(\d+)['"]?\)/);
        if (onclickMatch) {
          const n = Number(onclickMatch[1]);
          if (Number.isFinite(n) && n > max) max = n;
        }

        const href = a.getAttribute("href") || "";
        const hrefMatch = href.match(/[?&]page=(\d+)/);
        if (hrefMatch) {
          const n = Number(hrefMatch[1]);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
      return max;
    });
  } catch {
    return 1;
  }
}

async function moveToPage(page, targetPage) {
  if (targetPage === 1) return true;

  try {
    const movedWithPagingFn = await page.evaluate((n) => {
      if (typeof window.paging === "function") {
        window.paging(n);
        return true;
      }
      return false;
    }, targetPage);

    if (movedWithPagingFn) {
      await waitForSermonList(page);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const clicked = await page.evaluate((n) => {
      const anchors = Array.from(document.querySelectorAll("div.paging a, .paging a"));
      const byOnclick = anchors.find((a) => {
        const onclick = a.getAttribute("onclick") || "";
        return new RegExp(`paging\\(['"]?${n}['"]?\\)`).test(onclick);
      });
      if (byOnclick) {
        byOnclick.click();
        return true;
      }

      const byHref = anchors.find((a) => {
        const href = a.getAttribute("href") || "";
        return href.includes(`page=${n}`);
      });
      if (byHref) {
        byHref.click();
        return true;
      }
      return false;
    }, targetPage);

    if (clicked) {
      await waitForSermonList(page);
      return true;
    }
  } catch {
    // fallback below
  }

  await page.goto(`${BASE_URL}?page=${targetPage}`, { waitUntil: "networkidle2", timeout: 45000 });
  await waitForSermonList(page);
  return true;
}

async function collectDetailMetadata(browser, url) {
  const detailPage = await browser.newPage();
  try {
    await detailPage.setUserAgent(USER_AGENT);
    const response = await detailPage.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await detailPage.waitForSelector("body", { timeout: 10000 });
    await sleep(1500);
    const statusCode = response?.status?.() || 200;

    const metadata = await detailPage.evaluate(() => {
      const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cutBoilerplate = (value) => {
        const text = normalizeText(value);
        const markers = ["경기도 성남시", "Tel ", "ⓒ World Mission Society Church of God"];
        let cutIndex = -1;
        for (const marker of markers) {
          const idx = text.indexOf(marker);
          if (idx >= 0 && (cutIndex === -1 || idx < cutIndex)) {
            cutIndex = idx;
          }
        }
        return cutIndex >= 0 ? text.slice(0, cutIndex).trim() : text;
      };

      // Expand hidden/collapsed description if "more" controls exist.
      const expandSelectors = [".btn-more", ".read-more", ".more-btn", ".more", "[data-action='more']"];
      for (const selector of expandSelectors) {
        const btn = document.querySelector(selector);
        if (btn && typeof btn.click === "function") {
          btn.click();
        }
      }

      const titleCandidates = [
        document.querySelector(".hd-page"),
        document.querySelector("h1"),
        document.querySelector(".entry-title"),
        document.querySelector(".post-title"),
        document.querySelector('meta[property="og:title"]'),
      ];
      let title = "";
      for (const node of titleCandidates) {
        if (!node) continue;
        if (node.tagName?.toLowerCase() === "meta") {
          title = node.getAttribute("content") || "";
        } else {
          title = node.textContent || "";
        }
        if (title.trim()) break;
      }

      let description = "";
      const primaryNodes = Array.from(
        document.querySelectorAll(
          ".description, .inner-text, .post-content, .entry-content, article .content, .summary, .video-summary, .content-body",
        ),
      );
      for (const node of primaryNodes) {
        const text = cutBoilerplate(node?.textContent || "");
        if (text.length > description.length) {
          description = text;
        }
      }

      if (!description) {
        const paragraphTexts = Array.from(document.querySelectorAll("article p, .content p, .entry-content p, p"))
          .map((p) => normalizeText(p.textContent || ""))
          .filter(Boolean);
        description = cutBoilerplate(paragraphTexts.join(" "));
      }

      if (!description) {
        const metaCandidates = [
          document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
          document.querySelector('meta[name="description"]')?.getAttribute("content"),
          document.querySelector('meta[name="twitter:description"]')?.getAttribute("content"),
        ]
          .map((value) => cutBoilerplate(value || ""))
          .filter(Boolean);
        if (metaCandidates.length > 0) {
          description = metaCandidates[0];
        }
      }

      if (!description) {
        const ldJsonNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const node of ldJsonNodes) {
          try {
            const parsed = JSON.parse(node.textContent || "{}");
            const candidates = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of candidates) {
              const desc = cutBoilerplate(item?.description || "");
              if (desc) {
                description = desc;
                break;
              }
            }
            if (description) break;
          } catch {
            // ignore invalid JSON-LD
          }
        }
      }

      return {
        title: normalizeText(title),
        description,
      };
    });

    return {
      title: metadata?.title || "",
      description: metadata?.description || "",
      statusCode,
    };
  } catch {
    return { title: "", description: "", statusCode: 500 };
  } finally {
    await detailPage.close();
  }
}

async function run() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    throw new Error("크롬 실행 경로를 찾지 못했습니다. CHROME_PATH 환경변수를 설정해 주세요.");
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: 1400, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    const collected = new Map();

    console.log(`[crawl] open: ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await waitForSermonList(page);

    const detectedTotalPages = await getTotalPages(page);
    const pagesToCrawl = Math.min(MAX_PAGES, detectedTotalPages || MAX_PAGES);
    console.log(`[crawl] total pages detected: ${detectedTotalPages}, crawl target: ${pagesToCrawl}`);

    for (let pageNumber = 1; pageNumber <= pagesToCrawl; pageNumber += 1) {
      if (pageNumber > 1) {
        await moveToPage(page, pageNumber);
      }

      await sleep(3000);
      let listItems = await collectListItems(page);
      if (listItems.length === 0) {
        await sleep(3000);
        listItems = await collectListItems(page);
      }

      console.log(`[crawl] page ${pageNumber} items: ${listItems.length}`);
      for (const item of listItems) {
        const url = absoluteUrl(item.url);
        if (!url || collected.has(url)) continue;
        collected.set(url, { title: item.title, url, description: item.description || "" });
      }
    }

    const sermonItems = Array.from(collected.values());
    const output = [];

    for (let i = 0; i < sermonItems.length; i += 1) {
      const item = sermonItems[i];
      console.log(`[crawl] detail ${i + 1}/${sermonItems.length}: ${item.title}`);
      const metadata = await collectDetailMetadata(browser, item.url);
      const finalTitle = !isBadTitle(metadata.title) ? normalizeTitle(metadata.title) : normalizeTitle(item.title);
      const isBadStatus = Number(metadata.statusCode) >= 400;
      if (isBadStatus && isBadTitle(finalTitle)) {
        continue;
      }
      if (isBadTitle(finalTitle)) {
        continue;
      }
      const finalDescription = normalizeWhitespace(metadata.description || item.description || "");
      if (!finalDescription) {
        continue;
      }
      if (isBadStatus) {
        continue;
      }
      output.push({
        title: finalTitle,
        url: item.url,
        description: finalDescription,
      });
    }

    const uniqueMap = new Map();
    for (const entry of output) {
      if (!entry.url || uniqueMap.has(entry.url)) continue;
      uniqueMap.set(entry.url, entry);
    }
    const finalized = Array.from(uniqueMap.values());
    mkdirSync("public", { recursive: true });
    writeFileSync(OUTPUT_FILE, JSON.stringify(finalized, null, 2), "utf-8");
    writeFileSync(PUBLIC_OUTPUT_FILE, JSON.stringify(finalized, null, 2), "utf-8");

    console.log(`[done] saved ${finalized.length} sermons to ${OUTPUT_FILE} and ${PUBLIC_OUTPUT_FILE}`);
    finalized.forEach((sermon, index) => {
      console.log(`[${index + 1}] ${sermon.title} - ${sermon.url}`);
    });
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  const fallback = [
    {
      title: "설교를 추천할 수 없습니다.",
      url: "",
      description: "",
    },
  ];
  mkdirSync("public", { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(fallback, null, 2), "utf-8");
  writeFileSync(PUBLIC_OUTPUT_FILE, JSON.stringify(fallback, null, 2), "utf-8");
  console.error("[error]", error?.message || error);
  console.log("설교를 추천할 수 없습니다.");
});
