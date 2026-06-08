#!/usr/bin/env npx tsx
/**
 * Filtro 2: Cobertura recente de temas
 * Remove artigos cujo tema central já foi coberto nas últimas 7 dias
 */

import * as fs from "fs";
import * as path from "path";

interface Article {
  url: string;
  title: string;
  summary?: string;
  editor_submitted?: boolean;
  [key: string]: unknown;
}

interface CategorizedArticles {
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial: Article[];
  video: Article[];
}

interface InputData {
  categorized: CategorizedArticles;
}

interface OutputData {
  categorized: CategorizedArticles;
  stats: {
    total_input: number;
    removed_topic_covered: number;
    total_output: number;
    removals: Array<{
      url: string;
      title: string;
      reason: "topic_covered";
      detail: string;
    }>;
  };
}

function aammddToIso(aammdd: string): string {
  const yy = parseInt(aammdd.slice(0, 2), 10);
  const mm = aammdd.slice(2, 4);
  const dd = aammdd.slice(4, 6);
  const yyyy = yy >= 26 ? `20${yy}` : `20${yy}`;
  return `${yyyy}-${mm}-${dd}`;
}

function parseEditionHeader(line: string): { date: string; title: string } | null {
  const match = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+"(.+)"$/);
  return match ? { date: match[1], title: match[2] } : null;
}

function extractEditionUrls(section: string): string[] {
  const result: string[] = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^-\s+(https?:\/\/\S+)/);
    if (match) result.push(match[1]);
  }
  return result;
}

function isWithinDays(date1: string, date2: string, days: number): boolean {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diff = Math.abs(d1.getTime() - d2.getTime());
  return diff <= days * 24 * 60 * 60 * 1000;
}

function extractKeywords(text: string): string[] {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const stopwords = new Set([
    "and", "the", "for", "that", "this", "with", "from", "will", "have",
    "para", "mais", "como", "deve", "onde", "quando", "pode", "que", "seu",
    "seu", "uma", "com", "são", "por", "foi", "foi", "seu", "tem",
  ]);
  return words.filter((w) => !stopwords.has(w) && w.length > 2);
}

function calculateOverlap(keywords1: string[], keywords2: string[]): number {
  if (keywords1.length === 0 || keywords2.length === 0) return 0;
  const set1 = new Set(keywords1);
  const set2 = new Set(keywords2);
  const intersection = [...set1].filter((k) => set2.has(k));
  const union = new Set([...set1, ...set2]).size;
  return intersection.length / union;
}

async function main() {
  const editionDate = process.argv[2] || "260515";
  const editionDir = process.argv[3] || `data/editions/${editionDate}/`;
  const inputPath = path.join(editionDir, "_internal/tmp-dates-reviewed.json");
  const outputPath = path.join(editionDir, "_internal/tmp-reviewer-output.json");

  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const input: InputData = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const categorized = input.categorized || {
    lancamento: [],
    pesquisa: [],
    noticias: [],
    tutorial: [],
    video: [],
  };

  // Read past editions
  const pastEditionsPath = "context/past-editions.md";
  let pastEditionsText = "";
  if (fs.existsSync(pastEditionsPath)) {
    pastEditionsText = fs.readFileSync(pastEditionsPath, "utf-8");
  }

  // Extract recent editions (last 7 days)
  const editionIso = aammddToIso(editionDate);
  const recentEditions: Array<{ date: string; urls: string[] }> = [];

  const sections = pastEditionsText.split(/^## /m);
  for (const section of sections.slice(1)) {
    const lines = section.split("\n");
    const headerLine = "## " + lines[0];
    const parsed = parseEditionHeader(headerLine);

    if (parsed && isWithinDays(parsed.date, editionIso, 7)) {
      recentEditions.push({
        date: parsed.date,
        urls: extractEditionUrls(section),
      });
    }
  }

  console.log(
    `[Filter2] Found ${recentEditions.length} editions in last 7 days from ${editionIso}`
  );

  // Apply filter
  const output: OutputData = {
    categorized: {
      lancamento: [],
      pesquisa: [],
      noticias: [],
      tutorial: [],
      video: [],
    },
    stats: {
      total_input: 0,
      removed_topic_covered: 0,
      total_output: 0,
      removals: [],
    },
  };

  const categories = ["lancamento", "pesquisa", "noticias", "tutorial", "video"] as const;

  for (const category of categories) {
    const articles = categorized[category] || [];
    output.stats.total_input += articles.length;

    for (const article of articles) {
      let shouldRemove = false;
      let detail = "";

      // Check exact URL match
      for (const edition of recentEditions) {
        if (edition.urls.includes(article.url)) {
          shouldRemove = true;
          detail = `URL exata já usada em ${edition.date}`;
          break;
        }
      }

      if (!shouldRemove) {
        // Check semantic overlap (conservative)
        const articleKeywords = extractKeywords(
          (article.title || "") + " " + (article.summary || "")
        );
        if (articleKeywords.length > 0) {
          for (const edition of recentEditions) {
            let maxOverlap = 0;
            for (const url of edition.urls) {
              // Extract title-like info from URL (use the portion after last slash)
              const urlPart = url.split("/").pop() || "";
              const keywords = extractKeywords(urlPart);
              const overlap = calculateOverlap(articleKeywords, keywords);
              maxOverlap = Math.max(maxOverlap, overlap);
            }

            const threshold = article.editor_submitted ? 0.8 : 0.6;
            if (maxOverlap > threshold) {
              shouldRemove = true;
              detail = `tema similar em ${edition.date} (overlap: ${(maxOverlap * 100).toFixed(0)}%)`;
              break;
            }
          }
        }
      }

      if (shouldRemove) {
        output.stats.removed_topic_covered++;
        output.stats.removals.push({
          url: article.url,
          title: article.title,
          reason: "topic_covered",
          detail,
        });
      } else {
        output.categorized[category].push(article);
        output.stats.total_output++;
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`[Filter2] Complete`);
  console.log(`  Total input: ${output.stats.total_input}`);
  console.log(`  Removed: ${output.stats.removed_topic_covered}`);
  console.log(`  Output: ${output.stats.total_output} articles`);
  console.log(`  Saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
