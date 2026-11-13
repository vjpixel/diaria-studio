#!/usr/bin/env tsx
/**
 * weekly-shared-selection.ts (#13022)
 *
 * CLI da seleção única compartilhada do `/diaria-pacote-semanal`: monta o
 * ranking por clique da semana (núcleo puro em
 * `scripts/lib/weekly-shared-ranking.ts`, onde estão a métrica, a regra de
 * empate e a premissa dos cliques de sexta) e grava
 * `data/weekly/{cycle}/_internal/shared-selection.json`, que alimenta:
 *
 *   - `publish-weekly-social.ts --mode clicked --shared-selection {arquivo}`
 *     (carrossel clicked da retro, 5 itens, D1/D2/D3/RADAR);
 *   - `select-linkedin-weekly.ts --shared-selection {arquivo}` (manchetes do
 *     LinkedIn semanal, só destaques, #8029).
 *
 * Não publica nada nem chama rede: lê `02-reviewed.md` das edições e o cache
 * local de cliques (Beehiiv + Kit, como as duas skills).
 *
 * Decisões do editor no gate consolidado ficam gravadas em `overrides` no
 * próprio arquivo e são reaplicadas a cada re-rodada (mesmo padrão do
 * `useMelhorOverride`, #11777): se uma delas deixar de valer (o ranking mudou
 * depois de um `kit-sync`), o script sai com erro (exit 2) em vez de voltar
 * ao automático em silêncio; `--reset-overrides` descarta todas.
 *
 * Uso:
 *   npx tsx scripts/weekly-shared-selection.ts --saturday AAMMDD
 *   npx tsx scripts/weekly-shared-selection.ts --saturday AAMMDD --swap URL_SAI --with URL_ENTRA
 *   npx tsx scripts/weekly-shared-selection.ts --saturday AAMMDD --pick clicked|linkedin --urls url1,url2
 *   npx tsx scripts/weekly-shared-selection.ts --saturday AAMMDD --confirm-suggestions
 *   npx tsx scripts/weekly-shared-selection.ts --saturday AAMMDD --reset-overrides
 *
 * Saída: 0 = gravado; 1 = nenhuma edição na janela; 2 = argumento ou decisão
 * gravada inválida (nada é gravado).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { formatAAMMDD, parseAAMMDD, resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { extractWeeklyCandidates, type WeeklyRawCandidate } from "./lib/weekly-linkedin-parse.ts";
import { clickCountsForUrl, matchPostsToWindow, uniqueOpensOf } from "./lib/weekly-linkedin-clicks.ts";
import { toRankedCandidate, type WeeklyRankedCandidate } from "./lib/weekly-linkedin-select.ts";
import { loadUnifiedPostsForRanking } from "./select-linkedin-weekly.ts";
import {
  EMPTY_OVERRIDES,
  SHARED_PRODUCTS,
  SharedSelectionError,
  buildSharedSelection,
  clickAgeReport,
  isEligibleFor,
  type ProductSelection,
  type SharedOverrides,
  type SharedProduct,
} from "./lib/weekly-shared-ranking.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SHARED_SELECTION_FILE = "shared-selection.json";

/** Caminho do arquivo da seleção compartilhada de um ciclo, relativo a `rootDir`. */
export function sharedSelectionPath(rootDir: string, cycle: string): string {
  return join(rootDir, weeklyLinkedinRelDir(cycle), "_internal", SHARED_SELECTION_FILE);
}

/** Shape gravado em disco — lido pelos dois consumidores. */
export interface SharedSelectionFile {
  version: 1;
  saturday: string;
  publishMonday: string;
  cycle: string;
  contentWindow: string[];
  editionsFound: string[];
  editionsMissing: string[];
  generatedAt: string;
  overrides: SharedOverrides;
  clicked: ProductSelection;
  linkedin: ProductSelection;
  ranking: Array<{
    url: string;
    title: string;
    editionDate: string;
    kind: string;
    section: string;
    category: string;
    ratePct: number;
    clicks: number;
    opens: number;
    hasClickData: boolean;
    eligible: Record<SharedProduct, boolean>;
    position: Record<SharedProduct, number | null>;
  }>;
  excluded: Array<{ url: string; title: string; editionDate: string }>;
  clickAge: ReturnType<typeof clickAgeReport>["rows"];
  swapLog: ReturnType<typeof buildSharedSelection>["swapLog"];
  warnings: string[];
}

/** Lê o arquivo gravado. `null` se ausente; lança se ilegível ou de outro formato. */
export function readSharedSelection(path: string): SharedSelectionFile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SharedSelectionFile;
  if (parsed?.version !== 1 || !parsed.clicked || !parsed.linkedin) {
    throw new Error(`${path} não é uma seleção compartilhada válida (version 1, com clicked e linkedin).`);
  }
  return parsed;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

export function main(rootDirOverride?: string, argv: string[] = process.argv.slice(2), nowOverride?: Date): void {
  const rootDir = rootDirOverride ?? ROOT;
  const { flags, values } = parseArgs(argv);
  const saturday = values["saturday"] ?? "";
  const now = nowOverride ?? (values["now"] ? new Date(values["now"]) : new Date());

  const satDate = parseAAMMDD(saturday);
  if (!satDate) fail(2, "Uso: weekly-shared-selection.ts --saturday AAMMDD [--swap URL --with URL] [--pick clicked|linkedin --urls u1,u2] [--confirm-suggestions] [--reset-overrides]");
  if (satDate.getDay() !== 6) fail(2, `--saturday ${saturday} não é um sábado.`);
  const publishMonday = formatAAMMDD(addDays(satDate, 2));
  const resolution = resolveWeeklyLinkedinCycle(publishMonday);
  if (!resolution) fail(2, `não consegui resolver o ciclo da segunda ${publishMonday}.`);
  const { cycle, contentWindow } = resolution;

  for (const f of ["swap", "with", "pick", "urls"]) {
    if (flags.has(f)) fail(2, `--${f} precisa de valor.`);
  }
  if (Boolean(values["swap"]) !== Boolean(values["with"])) fail(2, "--swap e --with andam juntos (URL que sai, URL que entra).");
  if (Boolean(values["pick"]) !== Boolean(values["urls"])) fail(2, "--pick e --urls andam juntos (produto, URLs na ordem escolhida).");
  const pickProduct = values["pick"] as SharedProduct | undefined;
  if (pickProduct && !SHARED_PRODUCTS.includes(pickProduct)) fail(2, `--pick inválido: "${pickProduct}" (clicked ou linkedin).`);

  const outPath = sharedSelectionPath(rootDir, cycle);
  let previous: SharedSelectionFile | null = null;
  try {
    previous = readSharedSelection(outPath);
  } catch (e) {
    if (!flags.has("reset-overrides")) fail(2, `${(e as Error).message} Rode com --reset-overrides para recomeçar.`);
  }
  const base: SharedOverrides = flags.has("reset-overrides") || !previous ? EMPTY_OVERRIDES : previous.overrides;
  const overrides: SharedOverrides = {
    picks: { ...base.picks },
    swaps: [...base.swaps],
    confirmedSuggestions: [...base.confirmedSuggestions],
  };
  if (pickProduct) {
    overrides.picks[pickProduct] = values["urls"].split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (values["swap"]) overrides.swaps.push({ out: values["swap"].trim(), in: values["with"].trim() });
  if (flags.has("confirm-suggestions")) overrides.confirmedSuggestions = [...SHARED_PRODUCTS];

  // Leitura das edições e do cache de clique (mesmo caminho do select-linkedin-weekly.ts).
  const editionsRootDir = join(rootDir, "data/editions");
  const editions = contentWindow.map((date) => {
    const mdPath = join(resolveEditionDir(editionsRootDir, date), "02-reviewed.md");
    if (!existsSync(mdPath)) return { date, found: false, candidates: [] as WeeklyRawCandidate[] };
    return { date, found: true, candidates: extractWeeklyCandidates(readFileSync(mdPath, "utf8"), date) };
  });
  const found = editions.filter((e) => e.found);
  if (found.length === 0) fail(1, `Nenhuma edição com 02-reviewed.md na janela ${contentWindow.join(", ")} — nada pra selecionar.`);

  const posts = loadUnifiedPostsForRanking(join(rootDir, "data/beehiiv-cache/posts"), join(rootDir, "data/kit-cache/broadcasts"));
  const windowPosts = matchPostsToWindow(posts, contentWindow);
  const candidates: WeeklyRankedCandidate[] = found
    .flatMap((e) => e.candidates)
    .map((c) => {
      const post = windowPosts.get(c.editionDate);
      return toRankedCandidate(c, clickCountsForUrl(c.url, post?.stats?.clicks), uniqueOpensOf(post), windowPosts.has(c.editionDate));
    });

  let core: ReturnType<typeof buildSharedSelection>;
  try {
    core = buildSharedSelection({ candidates, editionsFound: found.length, overrides });
  } catch (e) {
    if (e instanceof SharedSelectionError) fail(2, `Seleção compartilhada não gravada: ${e.message}`);
    throw e;
  }

  const sentEpochs = new Map<string, number>();
  for (const [date, post] of windowPosts) if (post.publish_date) sentEpochs.set(date, post.publish_date);
  const age = clickAgeReport(contentWindow, sentEpochs, now);

  const warnings: string[] = [];
  for (const e of editions.filter((x) => !x.found)) warnings.push(`Edição ${e.date} sem 02-reviewed.md — fora do ranking.`);
  for (const e of found) {
    if (!windowPosts.has(e.date)) {
      warnings.push(`Sem dados de clique pra edição ${e.date} (sem post confirmado no cache Beehiiv/Kit) — rode kit-sync.ts e re-rode.`);
    }
  }
  warnings.push(...age.warnings, ...core.clicked.warnings, ...core.linkedin.warnings);
  for (const p of SHARED_PRODUCTS) {
    const pending = core[p].pending;
    if (pending && pending.resolution === "suggestion") {
      warnings.push(
        `[${p}] empate dentro do ruído de 1 clique (#5109): ${pending.group.length} candidatos para ${pending.slots} vaga(s); a prévia usa a SUGESTÃO do desempate editorial — confirmar ou trocar no gate.`,
      );
    }
  }
  for (const { swap, outcome } of core.swapLog) {
    for (const s of outcome.skipped) warnings.push(`Troca ${swap.out} → ${swap.in} não aplicada no ${s.product}: ${s.reason}.`);
  }

  const position = (p: SharedProduct, url: string) => {
    const i = core[p].urls.indexOf(url);
    return i === -1 ? null : i + 1;
  };
  const output: SharedSelectionFile = {
    version: 1,
    saturday,
    publishMonday,
    cycle,
    contentWindow,
    editionsFound: found.map((e) => e.date),
    editionsMissing: editions.filter((e) => !e.found).map((e) => e.date),
    generatedAt: now.toISOString(),
    overrides,
    clicked: core.clicked,
    linkedin: core.linkedin,
    ranking: core.ranking.ranked.map((c) => ({
      url: c.url,
      title: c.title,
      editionDate: c.editionDate,
      kind: c.kind,
      section: c.section,
      category: c.category,
      ratePct: Math.round(c.ratePct * 100) / 100,
      clicks: c.uniqueVerifiedClicks + c.webUniqueClicks,
      opens: c.opens,
      hasClickData: c.hasClickData,
      eligible: { clicked: isEligibleFor("clicked", c), linkedin: isEligibleFor("linkedin", c) },
      position: { clicked: position("clicked", c.url), linkedin: position("linkedin", c.url) },
    })),
    excluded: core.ranking.excluded.map((c) => ({ url: c.url, title: c.title, editionDate: c.editionDate })),
    clickAge: age.rows,
    swapLog: core.swapLog,
    warnings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  const titleOf = new Map(core.ranking.ranked.map((c) => [c.url, `${c.title} (${c.editionDate})`]));
  console.log(`OK: seleção compartilhada ${cycle} (sábado ${saturday}, segunda ${publishMonday}) → ${outPath}`);
  for (const p of SHARED_PRODUCTS) {
    console.log(`\n${p} (${core[p].urls.length}/${core[p].slots}${core[p].manual ? ", com troca do gate" : ""}):`);
    core[p].urls.forEach((u, i) => console.log(`  ${i + 1}. ${titleOf.get(u) ?? u}`));
  }
  console.log("\nIdade do dado de clique:");
  for (const r of age.rows) {
    console.log(`  ${r.editionDate}: ${r.hours == null ? "sem post no cache" : `${r.hours}h`}${r.immature ? "  ⚠ imaturo" : ""}`);
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
