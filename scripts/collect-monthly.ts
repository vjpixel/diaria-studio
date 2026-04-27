/**
 * Coleta os ~90 destaques de todas as edições publicadas em um mês.
 *
 * Phase 1 — fonte: arquivos locais em `data/editions/{AAMMDD}/`. Para cada edição válida:
 *   - Parse `02-reviewed.md` (texto revisado) via `parseDestaques` (extract-destaques.ts).
 *   - Cruza com `_internal/01-approved.json` para metadata enriquecida (score, source, BR flag).
 *
 * Limitação Phase 1: depende de a edição ter sido processada nesta máquina.
 * Edições publicadas de outra máquina (sem `02-reviewed.md` local) não entram.
 * O #188 spec original prevê Beehiiv MCP como source-of-truth — migração
 * fica como follow-up dedicado em #196.
 *
 * Output: `data/monthly/{YYMM}/raw-destaques.json` com todos os destaques do mês +
 * metadata estruturada pro `analyst-monthly` agrupar por tema.
 *
 * Uso:
 *   npx tsx scripts/collect-monthly.ts <YYMM>
 *
 * Ex: `npx tsx scripts/collect-monthly.ts 2604` para abril 2026.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques, type Destaque } from "./extract-destaques.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITIONS_DIR = resolve(ROOT, "data/editions");
const MONTHLY_DIR = resolve(ROOT, "data/monthly");

interface ApprovedHighlight {
  rank: number;
  score: number;
  bucket: string;
  reason: string;
  article: {
    url: string;
    title: string;
    published_at: string;
    summary: string;
    source: string;
    method: string;
    category: string;
  };
  url: string;
}

interface ApprovedJson {
  highlights: ApprovedHighlight[];
  categorized?: {
    lancamento?: unknown[];
    pesquisa?: unknown[];
    noticias?: unknown[];
  };
}

interface MonthlyDestaque {
  edition: string;        // AAMMDD
  position: 1 | 2 | 3;    // D1/D2/D3 na edição original
  category: string;       // category label do header (ex: "BRASIL", "LANÇAMENTO")
  title: string;
  body: string;
  why: string;
  url: string;
  // Enriched from 01-approved.json (when found):
  score?: number;
  source?: string;
  summary?: string;
  published_at?: string;
  is_brazil: boolean;     // hostname-based + content keywords + reason field
  brazil_signals: string[]; // why we flagged it
}

interface MonthlyOutput {
  yymm: string;
  generated_at: string;
  editions_count: number;
  destaques_count: number;
  destaques: MonthlyDestaque[];
  warnings: string[];
}

// ── Brasil detection ────────────────────────────────────────────────

const BR_HOSTS = [
  "g1.globo.com",
  "globo.com",
  "uol.com.br",
  "folha.uol.com.br",
  "folha.com.br",
  "estadao.com.br",
  "valor.globo.com",
  "valoreconomico.com.br",
  "cnnbrasil.com.br",
  "correio24horas.com.br",
  "nexojornal.com.br",
  "veja.abril.com.br",
  "exame.com",
  "infomoney.com.br",
  "tecnoblog.net",
  "olhardigital.com.br",
  "akitaonrails.com",
];

const BR_KEYWORDS = [
  "brasil",
  "brasileiro",
  "brasileira",
  "lula",
  "anpd",
  "lgpd",
  "anatel",
  "abdi",
  "tse",
  "stf",
  "cade",
  "itaú",
  "itau",
  "bradesco",
  "petrobras",
  "embraer",
  "nubank",
  "stone",
  "magazine luiza",
  "brasília",
  "brasilia",
];

function detectBrazil(args: {
  url: string;
  title: string;
  summary?: string;
  reason?: string;
}): { is_brazil: boolean; signals: string[] } {
  const signals: string[] = [];

  // Host check
  try {
    const host = new URL(args.url).hostname.replace(/^www\./, "");
    if (host.endsWith(".br")) signals.push(`host:${host}`);
    else if (BR_HOSTS.includes(host)) signals.push(`host:${host}`);
  } catch {
    // ignore malformed URL
  }

  // Reason field from approved.json: heurística — captura tokens "BR"
  // (ex: "BR coverage", "Score N: BR ...") OU palavra "Brasil" no reason.
  // Não há contrato formal com o scorer diário; se a redação mudar, o sinal
  // some silenciosamente. Mitigado pelos outros sinais (host, keywords).
  if (args.reason && (/\bBR\b/.test(args.reason) || /\bBrasil\b/i.test(args.reason))) {
    signals.push("reason:BR-mention");
  }

  // Keyword check on title + summary
  const haystack = `${args.title} ${args.summary || ""}`.toLowerCase();
  for (const kw of BR_KEYWORDS) {
    if (haystack.includes(kw)) {
      signals.push(`kw:${kw}`);
      break; // one keyword is enough
    }
  }

  return { is_brazil: signals.length > 0, signals };
}

// ── Edition discovery ──────────────────────────────────────────────

function listEditionsForMonth(yymm: string): string[] {
  if (!/^\d{4}$/.test(yymm)) {
    throw new Error(`YYMM inválido: ${yymm}. Use formato YYMM (ex: 2604).`);
  }
  if (!existsSync(EDITIONS_DIR)) return [];

  const all = readdirSync(EDITIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d{6}$/.test(name)) // strict AAMMDD only — exclude backups, locals, etc.
    .filter((name) => name.startsWith(yymm))
    .sort(); // chronological

  return all;
}

// ── Per-edition extraction ─────────────────────────────────────────

function loadApproved(editionDir: string): ApprovedJson | null {
  const path = join(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return null;
  }
}

function findHighlightForUrl(approved: ApprovedJson | null, url: string): ApprovedHighlight | null {
  if (!approved?.highlights) return null;
  return approved.highlights.find((h) => h.url === url || h.article?.url === url) || null;
}

function extractEditionDestaques(edition: string): {
  destaques: MonthlyDestaque[];
  warnings: string[];
} {
  const editionDir = join(EDITIONS_DIR, edition);
  const reviewedPath = join(editionDir, "02-reviewed.md");
  const warnings: string[] = [];

  if (!existsSync(reviewedPath)) {
    warnings.push(`${edition}: 02-reviewed.md não existe — pulando`);
    return { destaques: [], warnings };
  }

  const raw = readFileSync(reviewedPath, "utf8");
  let parsed: Destaque[] = [];
  try {
    parsed = parseDestaques(raw);
  } catch (err) {
    warnings.push(`${edition}: erro ao parsear 02-reviewed.md (${(err as Error).message})`);
    return { destaques: [], warnings };
  }

  if (parsed.length !== 3) {
    warnings.push(`${edition}: esperado 3 destaques, encontrado ${parsed.length}`);
  }

  const approved = loadApproved(editionDir);
  if (!approved) {
    warnings.push(`${edition}: _internal/01-approved.json não existe — metadata reduzida`);
  }

  const result: MonthlyDestaque[] = parsed.map((d) => {
    const hl = findHighlightForUrl(approved, d.url);
    const article = hl?.article;
    const brazil = detectBrazil({
      url: d.url,
      title: d.title,
      summary: article?.summary,
      reason: hl?.reason,
    });

    return {
      edition,
      position: d.n,
      category: d.category,
      title: d.title,
      body: d.body,
      why: d.why,
      url: d.url,
      score: hl?.score,
      source: article?.source,
      summary: article?.summary,
      published_at: article?.published_at,
      is_brazil: brazil.is_brazil,
      brazil_signals: brazil.signals,
    };
  });

  return { destaques: result, warnings };
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const yymm = process.argv[2];
  if (!yymm) {
    console.error("Usage: npx tsx scripts/collect-monthly.ts <YYMM>");
    console.error("  Ex: npx tsx scripts/collect-monthly.ts 2604");
    process.exit(2);
  }

  const editions = listEditionsForMonth(yymm);
  if (editions.length === 0) {
    console.error(`Nenhuma edição encontrada para ${yymm} em ${EDITIONS_DIR}`);
    process.exit(1);
  }

  const allDestaques: MonthlyDestaque[] = [];
  const allWarnings: string[] = [];

  for (const ed of editions) {
    const { destaques, warnings } = extractEditionDestaques(ed);
    allDestaques.push(...destaques);
    allWarnings.push(...warnings);
  }

  const output: MonthlyOutput = {
    yymm,
    generated_at: new Date().toISOString(),
    editions_count: editions.length,
    destaques_count: allDestaques.length,
    destaques: allDestaques,
    warnings: allWarnings,
  };

  const outDir = join(MONTHLY_DIR, yymm);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "raw-destaques.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  const brazilCount = allDestaques.filter((d) => d.is_brazil).length;
  console.log(
    `OK: ${allDestaques.length} destaques de ${editions.length} edições (${brazilCount} marcados Brasil) → ${outPath}`
  );
  if (allWarnings.length > 0) {
    console.log(`Warnings: ${allWarnings.length}`);
    for (const w of allWarnings) console.log(`  - ${w}`);
  }
}

main();
