/**
 * check-repeat-theme.ts (#8896)
 *
 * §1w-quint-b do Stage 1 ("Repeat-de-tema, fail-soft") — já documentado em
 * `.claude/agents/orchestrator-stage-1-research.md` e já listado no gate
 * humano §1x (campo `repeatTheme`), mas o script em si nunca existiu no repo
 * até esta issue: `repeatTheme` sempre chegava vazio ao editor porque não
 * havia nada gerando o dado. Achado ao vivo investigando a #8896 (D1 260928
 * Wired × D1 260925 Guardian, mesmo evento "agente de IA invade sistema
 * governamental/de saúde australiano", cobertura de fontes/ângulos
 * diferentes — passou pelo dedup "hard" de `dedup.ts` porque a similaridade
 * de título entre as duas coberturas é baixa demais pra remoção automática,
 * ~0.22 de Jaccard, e não havia nenhum sinal mais fraco pra avisar o
 * editor).
 *
 * Nunca bloqueia — mesmo padrão warning-only de `has-negative-impact-highlight`
 * (#3916/#3918): dois candidatos parecidos pode ser coincidência de
 * vocabulário do domínio IA, não repetição de evento; cabe ao editor decidir
 * no gate, este script só avisa. Lógica pura em `scripts/lib/repeat-theme-check.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-repeat-theme.ts \
 *     --categorized data/editions/AAMMDD/_internal/tmp-categorized.json \
 *     [--past-editions data/past-editions.md] \
 *     [--editions-dir data/editions] \
 *     [--current-edition AAMMDD] \
 *     [--window 3] \
 *     [--warn-threshold 0.20]
 *
 * `--current-edition` é opcional — se omitido, é derivado do path de
 * `--categorized` (mesmo padrão de `deriveCurrentEdition`, que casa
 * `data/editions/{AAMMDD}/...`) pra nunca comparar a edição contra ela mesma.
 *
 * Stdout: JSON `{ flagged, theme, eventMatches, subjectMatches }` — `flagged`
 * e `theme` são os 2 campos que o playbook do Stage 1 já espera; os arrays
 * detalhados são aditivos (debug/auditoria). Nunca lança e sempre sai com
 * exit 0 — instrumentação fail-soft, um erro aqui não pode travar o Stage 1.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  readPastEditionsMd,
  extractPastThemeEntities,
  extractPastDestaqueTitles,
  deriveCurrentEdition,
  DEFAULT_PAST_WINDOW,
} from "./lib/past-editions-extract.ts";
import {
  detectEventOverlap,
  detectSubjectThemeOverlap,
  buildRepeatThemeResult,
  REPEAT_THEME_WARN_THRESHOLD,
  type RepeatThemeCandidate,
} from "./lib/repeat-theme-check.ts";
import { isMainModule } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface CategorizedArticle {
  url?: string;
  title?: string;
  summary?: string;
  [key: string]: unknown;
}

interface CategorizedFlat {
  lancamento?: CategorizedArticle[];
  radar?: CategorizedArticle[];
  use_melhor?: CategorizedArticle[];
  video?: CategorizedArticle[];
  [key: string]: unknown;
}

const ALL_BUCKET_NAMES = ["lancamento", "radar", "use_melhor", "video"] as const;

/** Achata os 4 buckets de `tmp-categorized.json` numa lista única de candidatos. */
export function flattenCategorized(buckets: CategorizedFlat): RepeatThemeCandidate[] {
  const out: RepeatThemeCandidate[] = [];
  for (const bucket of ALL_BUCKET_NAMES) {
    const arr = buckets[bucket];
    if (!Array.isArray(arr)) continue;
    for (const article of arr) {
      out.push({
        title: article?.title,
        summary: article?.summary,
        url: article?.url,
        bucket,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedRepeatThemeArgs {
  categorized: string;
  pastEditions: string;
  editionsDir: string;
  currentEdition?: string;
  window: number;
  warnThreshold: number;
}

function parseArgs(argv: string[]): ParsedRepeatThemeArgs {
  let categorized = "";
  let pastEditions = resolve(import.meta.dirname, "..", "data", "past-editions.md");
  let editionsDir = resolve(import.meta.dirname, "..", "data", "editions");
  let currentEdition: string | undefined;
  let window = DEFAULT_PAST_WINDOW;
  let warnThreshold = REPEAT_THEME_WARN_THRESHOLD;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--categorized" && argv[i + 1]) categorized = argv[++i];
    else if (argv[i] === "--past-editions" && argv[i + 1]) pastEditions = argv[++i];
    else if (argv[i] === "--editions-dir" && argv[i + 1]) editionsDir = argv[++i];
    else if (argv[i] === "--current-edition" && argv[i + 1]) currentEdition = argv[++i];
    else if (argv[i] === "--window" && argv[i + 1]) {
      const w = parseInt(argv[++i], 10);
      if (!Number.isInteger(w) || w < 1) {
        console.error(`[check-repeat-theme] --window deve ser um inteiro positivo (recebido: ${argv[i]})`);
        process.exit(1);
      }
      window = w;
    } else if (argv[i] === "--warn-threshold" && argv[i + 1]) {
      const t = parseFloat(argv[++i]);
      if (!Number.isFinite(t) || t <= 0 || t > 1) {
        console.error(`[check-repeat-theme] --warn-threshold deve estar em (0, 1] (recebido: ${argv[i]})`);
        process.exit(1);
      }
      warnThreshold = t;
    }
  }

  if (!categorized) {
    console.error(
      "Uso: check-repeat-theme.ts --categorized <path> [--past-editions <path>] [--editions-dir <path>] [--current-edition <AAMMDD>] [--window <N>] [--warn-threshold <0-1>]",
    );
    process.exit(1);
  }

  return { categorized, pastEditions, editionsDir, currentEdition, window, warnThreshold };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));

  // Fail-soft (docstring): qualquer erro vira { flagged: false, theme: null }
  // em vez de travar o Stage 1 por causa de instrumentação de warning.
  try {
    if (!existsSync(args.categorized)) {
      console.error(`[check-repeat-theme] arquivo não encontrado: ${args.categorized} — seguindo sem sinal`);
      process.stdout.write(JSON.stringify({ flagged: false, theme: null, eventMatches: [], subjectMatches: [] }) + "\n");
      process.exit(0);
    }

    const raw = JSON.parse(readFileSync(args.categorized, "utf8")) as CategorizedFlat;
    const candidates = flattenCategorized(raw);

    const currentAammdd = args.currentEdition ?? deriveCurrentEdition(args.categorized);

    // Sinal 1 (#1475, mecanismo original): entidades de subject line de past-editions.md.
    const pastMd = readPastEditionsMd(args.pastEditions);
    const pastThemeEntities = extractPastThemeEntities(pastMd, args.window);
    const subjectMatches = detectSubjectThemeOverlap(candidates, pastThemeEntities);

    // Sinal 2 (#8896, o gap real): Jaccard de título vs destaques recentes locais.
    const pastDestaques = extractPastDestaqueTitles(args.editionsDir, args.window, currentAammdd);
    const eventMatches = detectEventOverlap(candidates, pastDestaques, {
      warnThreshold: args.warnThreshold,
    });

    const result = buildRepeatThemeResult(eventMatches, subjectMatches);

    if (result.flagged) {
      console.error(`[check-repeat-theme] ${eventMatches.length + subjectMatches.length} candidato(s) marcado(s) — ${result.theme}`);
    } else {
      console.error(`[check-repeat-theme] ${candidates.length} candidato(s) verificados, ${pastDestaques.length} destaque(s) passado(s) — nenhuma sobreposição de evento/tema.`);
    }

    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (err) {
    console.error(`[check-repeat-theme] falha inesperada — seguindo sem sinal (fail-soft): ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(JSON.stringify({ flagged: false, theme: null, eventMatches: [], subjectMatches: [] }) + "\n");
    process.exit(0);
  }
}
