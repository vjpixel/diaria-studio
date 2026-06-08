/**
 * Filtro 2 — Cobertura recente de temas
 *
 * Lê context/past-editions.md, extrai edições dos últimos 7 dias,
 * e remove artigos que cobrem tema já publicado (critério conservador).
 *
 * #1112 (2026-05-12): Este agent agora executa APENAS o Filtro 2 (semântica).
 * Filtro 1 (datas) foi para scripts/research-review-dates.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

interface Article {
  url: string;
  title: string;
  summary?: string;
  published_at?: string;
  source?: string;
  category?: string;
  date_unverified?: boolean;
  date?: string;
  flag?: string;
  editor_submitted?: boolean;
}

interface Stats {
  total_input?: number;
  removed_topic_covered?: number;
  total_output?: number;
  removals?: Array<{ url: string; title: string; reason: string; detail: string }>;
}

interface Input {
  categorized: {
    lancamento: Article[];
    pesquisa: Article[];
    noticias: Article[];
    tutorial: Article[];
    video?: Article[];
  };
  stats: Stats;
}

interface PastEdition {
  date: string; // ISO format: 2026-05-13
  title: string;
  urls: string[];
  articleTitles: string[];
}

function parseEditionDate(dateString: string): Date {
  // Tenta parsear ISO (2026-05-13)
  const match = dateString.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  }
  return new Date('1970-01-01');
}

function readPastEditions(pastEditionsPath: string): PastEdition[] {
  const content = fs.readFileSync(pastEditionsPath, 'utf-8');
  const editions: PastEdition[] = [];

  // Regex para extrair seções de edições (## YYYY-MM-DD — "Título")
  const sectionRegex = /## (\d{4}-\d{2}-\d{2}) — "([^"]+)"\n(?:URL: (.+?))?\n\nLinks usados:\n([\s\S]*?)(?=---\n## |\Z)/g;

  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    const dateStr = match[1];
    const title = match[2];
    const urlLine = match[3];
    const linksText = match[4];

    // Extrair URLs das linhas "- https://..."
    const urls: string[] = [];
    const linkLines = linksText.match(/^- (.+?)$/gm) || [];
    for (const line of linkLines) {
      const url = line.replace(/^- /, '').trim();
      if (url) urls.push(url);
    }

    editions.push({
      date: dateStr,
      title: title,
      urls: urls,
      articleTitles: [] // Preenchido depois se necessário
    });
  }

  return editions;
}

function getRecentEditions(editions: PastEdition[], targetDate: Date, days: number = 7): PastEdition[] {
  const cutoffDate = new Date(targetDate.getTime() - days * 24 * 60 * 60 * 1000);

  return editions.filter(ed => {
    const edDate = parseEditionDate(ed.date);
    return edDate >= cutoffDate && edDate < targetDate;
  });
}

function normalizeUrl(url: string): string {
  return url.toLowerCase().trim().replace(/\/$/, '');
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}

function checkExactUrlMatch(articleUrl: string, pastUrls: string[]): boolean {
  const normalized = normalizeUrl(articleUrl);
  return pastUrls.some(url => normalizeUrl(url) === normalized);
}

function calculateStringOverlap(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().match(/\b\w+\b/g) || []);
  const words2 = new Set(text2.toLowerCase().match(/\b\w+\b/g) || []);

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

function checkSemanticOverlap(
  article: Article,
  recentEditions: PastEdition[]
): { covered: boolean; edDate: string; detail: string } {
  // Critério conservador: remover SÓ se overlap temático for claro e direto

  const articleText = (article.title + ' ' + (article.summary || '')).toLowerCase();

  // 1. Check exact URL match (prioridade máxima)
  for (const ed of recentEditions) {
    if (checkExactUrlMatch(article.url, ed.urls)) {
      return {
        covered: true,
        edDate: ed.date,
        detail: `URL idêntica publicada em ${ed.date}`
      };
    }
  }

  // 2. Check semantic overlap conservador
  // Temas óbvios que precisam match alto (>0.6) para remover
  for (const ed of recentEditions) {
    // Overlap de título/resumo direto
    const titleOverlap = calculateStringOverlap(article.title, ed.title);

    // Se título da edição já cobriu este artigo: overlap alto
    if (titleOverlap > 0.65) {
      // Validate semantic match: keywords principais devem coincidir
      const keywords = ['openai', 'anthropic', 'google', 'meta', 'claude', 'chatgpt', 'gemini',
                        'deepseek', 'llama', 'grok', 'xai', 'nvidia', 'microsoft', 'amazon',
                        'agentes', 'agents', 'o1', 'gpt', 'voice', 'voz', 'multimodal',
                        'reasoning', 'raciocínio', 'robotics', 'robôs', 'humanoid'];

      const articleKeywords = keywords.filter(k => articleText.includes(k));
      const editionKeywords = keywords.filter(k => ed.title.toLowerCase().includes(k));

      if (articleKeywords.length > 0 && editionKeywords.length > 0) {
        const commonKeywords = articleKeywords.filter(k => editionKeywords.includes(k));
        if (commonKeywords.length > 0) {
          return {
            covered: true,
            edDate: ed.date,
            detail: `tema similar já coberto em ${ed.date}: "${ed.title}"`
          };
        }
      }
    }

    // Check contra URLs individuais da edição para overlap de tema
    for (const pastTitle of ed.articleTitles) {
      const urlOverlap = calculateStringOverlap(article.title, pastTitle);
      if (urlOverlap > 0.7) {
        return {
          covered: true,
          edDate: ed.date,
          detail: `mesmo artigo/tema publicado em ${ed.date}`
        };
      }
    }
  }

  // 3. Regra especial para editor_submitted (#321): bar mais alta
  // Remover SÓ se 3+ artigos sobre o mesmo tema apareceram na edição anterior
  // ou se overlap exato (mesmo evento, mesma data)
  if (article.editor_submitted) {
    const lastEdition = recentEditions[recentEditions.length - 1];
    if (lastEdition) {
      let sameTopicCount = 0;
      for (const pastUrl of lastEdition.urls) {
        const sameTopicOverlap = calculateStringOverlap(article.title, pastUrl);
        if (sameTopicOverlap > 0.6) {
          sameTopicCount++;
        }
      }
      // Só remover se 3+ artigos do mesmo tema (saturação)
      if (sameTopicCount >= 3) {
        return {
          covered: true,
          edDate: lastEdition.date,
          detail: `overlap saturado (3+ artigos do tema) em ${lastEdition.date}`
        };
      }
    }
  }

  return { covered: false, edDate: '', detail: '' };
}

// === MAIN ===

const editionDir = process.argv[2];
const cwd = process.cwd();
const edition_aammdd = path.basename(editionDir);

// Parse edition date (AAMMDD -> ISO)
const yy = parseInt(edition_aammdd.slice(0, 2), 10);
const mm = parseInt(edition_aammdd.slice(2, 4), 10);
const dd = parseInt(edition_aammdd.slice(4, 6), 10);
const edition_date = new Date(`20${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T00:00:00Z`);

const inputFile = path.join(cwd, editionDir, '_internal', 'tmp-dates-reviewed.json');
const pastEditionsPath = path.join(cwd, 'context', 'past-editions.md');

// Ler input
const input: Input = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

// Ler past-editions.md
const allPastEditions = readPastEditions(pastEditionsPath);
const recentEditions = getRecentEditions(allPastEditions, edition_date, 7);

console.error(`[Filter2] Edição: ${edition_aammdd} (${edition_date.toISOString()})`);
console.error(`[Filter2] Edições recentes (últimos 7 dias): ${recentEditions.length}`);
recentEditions.forEach(ed => {
  console.error(`  - ${ed.date}: "${ed.title}" (${ed.urls.length} links)`);
});

// Aplicar filtro
const removals: Array<{ url: string; title: string; reason: string; detail: string }> = [];
const buckets: (keyof typeof input.categorized)[] = ['lancamento', 'pesquisa', 'noticias', 'tutorial', 'video'];

for (const bucket of buckets) {
  const articles = input.categorized[bucket];
  if (!Array.isArray(articles)) continue;

  const filtered: Article[] = [];

  for (const article of articles) {
    const overlap = checkSemanticOverlap(article, recentEditions);

    if (overlap.covered) {
      removals.push({
        url: article.url,
        title: article.title,
        reason: 'topic_covered',
        detail: overlap.detail
      });
      console.error(`[Filter2] REMOVER: ${article.title}`);
      console.error(`  └─ Motivo: ${overlap.detail}`);
    } else {
      filtered.push(article);
    }
  }

  (input.categorized as any)[bucket] = filtered;
}

// Atualizar stats
const totalKept = Object.values(input.categorized).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
input.stats.removed_topic_covered = (input.stats.removed_topic_covered || 0) + removals.length;
input.stats.total_output = totalKept;

if (!input.stats.removals) {
  input.stats.removals = [];
}
input.stats.removals = (input.stats.removals || []).concat(removals);

// Gravar output
const outputFile = path.join(cwd, editionDir, '_internal', 'tmp-reviewed.json');
fs.writeFileSync(outputFile, JSON.stringify(input, null, 2));

console.log(JSON.stringify({
  status: 'ok',
  edition: edition_aammdd,
  removed: removals.length,
  kept: totalKept,
  recent_editions_checked: recentEditions.length,
  buckets: {
    lancamento: (input.categorized.lancamento || []).length,
    pesquisa: (input.categorized.pesquisa || []).length,
    noticias: (input.categorized.noticias || []).length,
    tutorial: (input.categorized.tutorial || []).length,
    video: (input.categorized.video || []).length
  },
  removals: removals.slice(0, 10) // Log primeiras 10 remoções
}, null, 2));
