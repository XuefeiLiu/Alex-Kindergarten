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
  ["Hunter College Campus Schools", "https://www.hunterschools.org/"],
  ["NYC DOE Kindergarten", "https://www.schools.nyc.gov/enrollment/enroll-grade-by-grade/kindergarten"]
];

const outputPath = new URL("../data/admissions-monitor.json", import.meta.url);
const dateWords = "January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept\\.?|Sep\\.?|Oct\\.?|Nov\\.?|Dec\\.?";
const signalPattern = new RegExp(`(announcement|news|event|register|registration|webinar|information session|info session|roundtable|workshop|application|deadline|tour|open house|interview|parent|visit|assessment|financial aid|Ravenna|ISAAGNY|2026|2027|${dateWords})`, "i");
const boilerplatePattern = /(warmly|privacy policy|cookie policy|quicklinks|skip to main content|open menu|close menu|search|type on the line above|all rights reserved|contact us|street, new york|follow us|facebook|instagram|linkedin|learn more|list of|alumni|get involved|reunion|class notes|tuition, fees|meet our team|welcome admissions|home admissions|calendar, news|media calendar|trinity fund|making a stock gift|support trinity|annual fund|planned giving|lgbtq\+ inclusion)/i;

function decodeEntities(text) {
  const named = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    ndash: "-",
    mdash: "-",
    hellip: "..."
  };

  return text
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([a-f0-9]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&([a-z]+);/gi, (match, value) => named[value.toLowerCase()] ?? match);
}

function normalizeHtml(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|div|tr|section|article)>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\.\s+/g, ". ")
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
    .map((part) => part.replace(/\s+/g, " "))
    .filter((part) => part.length > 30 && part.length < 280)
    .filter((part) => signalPattern.test(part))
    .filter((part) => !boilerplatePattern.test(part))
    .filter((part) => /[.!?]$|\b(2026|2027|deadline|opens?|due|schedule|required|optional|must|available|register|tour|visit|interview|assessment)\b/i.test(part))
    .map((part) => {
      const cleaned = part
        .replace(/\bAdmissions\s+Admissions\b/gi, "Admissions")
        .replace(/\bApplication\s+Application\b/gi, "Application")
        .replace(/\bApply\s+Apply\b/gi, "Apply")
        .replace(/\.\.+/g, ".")
        .trim();
      return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
    });

  return [...new Set(chunks)]
    .slice(0, 8)
    .map((part) => `Check: ${part}`);
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
