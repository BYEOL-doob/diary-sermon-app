/**
 * Puppeteer is Node.js-only and cannot run directly in the browser bundle.
 * Use `npm run scrape:sermons` to create `sermons.json` from watvmedia.org.
 */
export async function fetchSermonMetadataWithPuppeteer() {
  return [
    {
      title: "설교를 추천할 수 없습니다.",
      url: "",
      description: "",
    },
  ];
}
