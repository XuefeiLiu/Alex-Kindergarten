import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const targets = [
  ["Trinity School admissions/events", "https://www.trinityschoolnyc.org/admissions/admissions-k-4"],
  ["The Dalton School admissions", "https://www.dalton.org/apply/steps-to-apply"],
  ["Collegiate School admissions", "https://www.collegiateschool.org/admissions/apply-to-kindergarten"],
  ["The Allen-Stevenson School admissions", "https://www.allen-stevenson.org/admissions/apply"],
  ["The Allen-Stevenson School visits/events", "https://www.allen-stevenson.org/admissions/visit-and-meet-us"],
  ["Trevor Day School admissions/events", "https://www.trevor.org/admissions/apply-to-lower-school-ps-5"],
  ["The Browning School admissions/events", "https://browning.edu/admission"],
  ["The Town School dates/events", "https://www.thetownschool.org/admissions/important-dates-and-events"],
  ["United Nations International School admissions", "https://www.unis.org/admissions/apply"],
  ["United Nations International School tours/open houses", "https://www.unis.org/admissions/tours-open-houses"],
  ["Hunter College Elementary School", "https://www.hunterschools.org/es"],
  ["NYC DOE Kindergarten", "https://www.schools.nyc.gov/enrollment/enroll-grade-by-grade/kindergarten"]
];

const outputPath = new URL("../data/admissions-monitor.json", import.meta.url);
const dateWords = "January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept\\.?|Sep\\.?|Oct\\.?|Nov\\.?|Dec\\.?";
const signalPattern = new RegExp(`(announcement|news|event|register|registration|webinar|information session|info session|roundtable|workshop|application|deadline|tour|open house|interview|parent|visit|assessment|financial aid|Ravenna|ISAAGNY|2026|2027|${dateWords})`, "i");

function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function extractHints(text) {
  const chunks = text
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 30 && part.length < 350)
    .filter((part) => signalPattern.test(part));

  return [...new Set(chunks)]
    .slice(0, 8)
    .map((part) => part.length > 240 ? `${part.slice(0, 237)}...` : part);
}

async function readPrevious() {
  try {
    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    return new Map((parsed.schools || []).map((school) => [school.name, school]));
  } catch {
    return new Map();
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Alex-Kindergarten admissions monitor; contact via repository owner"
      }
    });
    const html = await response.text();
    return { ok: response.ok, statusCode: response.status, html };
  } finally {
    clearTimeout(timeout);
  }
}

const previous = await readPrevious();
const checkedAt = new Date().toISOString();
const schools = [];

for (const [name, url] of targets) {
  const prior = previous.get(name);
  try {
    const result = await fetchWithTimeout(url);
    const text = normalizeHtml(result.html);
    const hash = hashText(text);
    schools.push({
      name,
      url,
      status: prior?.hash && prior.hash !== hash ? "changed" : prior ? "unchanged" : "new",
      checkedAt,
      httpStatus: result.statusCode,
      hash,
      previousHash: prior?.hash || null,
      hints: extractHints(text)
    });
  } catch (error) {
    schools.push({
      name,
      url,
      status: "error",
      checkedAt,
      httpStatus: null,
      hash: prior?.hash || null,
      previousHash: prior?.hash || null,
      hints: prior?.hints || [],
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const summary = {
  checkedAt,
  changedCount: schools.filter((school) => school.status === "changed").length,
  errorCount: schools.filter((school) => school.status === "error").length,
  schools
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
