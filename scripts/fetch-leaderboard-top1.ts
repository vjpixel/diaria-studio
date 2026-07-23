#!/usr/bin/env tsx
/**
 * fetch-leaderboard-top1.ts (#1160)
 *
 * Pre-publish step pra edição: fetcha `/leaderboard/top1?period=YYYY-MM` do
 * Worker `poll` e grava resposta em `_internal/04-leaderboard-top1.json`.
 *
 * Stage 3 chama este script antes de `render-newsletter-html.ts` rodar.
 * O renderer lê o JSON local e injeta o bloco no rodapé do È IA?.
 *
 * Período: derivado da publication date da edição (AAMMDD → YYYY-MM).
 * Tradeoff editorial: voto na edição 260531 conta em Maio 2026 mesmo se
 * leitor votar em 02/jun (#1345).
 *
 * #1753: o bloco só aparece na **1ª edição do mês** e anuncia o mês que acabou
 * de fechar (período ANTERIOR ao da edição — `previousMonthSlug`). Em qualquer
 * outra edição grava vazio (renderer omite). "1ª do mês" = nenhuma edição
 * publicada em `past-editions-raw.json` cai no mesmo ano-mês com data anterior.
 *
 * Uso:
 *   npx tsx scripts/fetch-leaderboard-top1.ts --edition AAMMDD --out path.json
 *
 * Output: JSON com shape do endpoint
 *   { top1: [{nickname, correct, total, pct}], period: "Maio", period_slug: "2026-05" }
 *
 * Graceful: qualquer falha (Worker offline, fetch timeout, top1 vazio) →
 * exit 0 com JSON `{ top1: [], period: ..., period_slug: ... }`. Renderer
 * detecta top1 vazio e omite o bloco — newsletter funciona sem o leaderboard.
 *
 * Exit codes:
 *   0  sucesso (com top1 populado OU vazio)
 *   1  arg inválido
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { dohFetch } from "./lib/doh-fetch.ts"; // #1365 — DoH fallback pra UDP/53 broken
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #3904

const WORKER_URL =
  process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL;
const FETCH_TIMEOUT_MS = 15_000; // #1365 — bumped 5s→15s pra acomodar DoH fallback path

interface Top1Entry {
  nickname: string;
  correct: number;
  total: number;
  pct: number;
}

interface PodiumEntry {
  nickname: string;
  rank: number;
}

interface Top1Response {
  top1: Top1Entry[];
  podium?: PodiumEntry[]; // #1160 followup — rank 1-3 ordered
  period: string;
  period_slug: string;
}

/**
 * Pure: AAMMDD → "YYYY-MM". Mirror de `editionToMonthSlug` em
 * workers/poll/src/lib.ts (#1345) — duplicado aqui pra evitar import
 * cross-package.
 */
export function editionToMonthSlug(edition: string): string | null {
  if (!/^\d{6}$/.test(edition)) return null;
  const yy = edition.slice(0, 2);
  const mm = edition.slice(2, 4);
  const mmNum = parseInt(mm, 10);
  if (mmNum < 1 || mmNum > 12) return null;
  return `20${yy}-${mm}`;
}

/**
 * Pure (#1753): "YYYY-MM" → mês anterior "YYYY-MM". Janeiro vira dezembro do
 * ano anterior. Input malformado retorna o próprio slug (fail-open).
 *
 * O bloco "Vencedores do mês" só aparece na 1ª edição do mês e anuncia o mês
 * que acabou de fechar — então pedimos sempre o período ANTERIOR ao da edição.
 */
export function previousMonthSlug(slug: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(slug);
  if (!m) return slug;
  let year = parseInt(m[1], 10);
  let month = parseInt(m[2], 10) - 1;
  if (month < 1) { month = 12; year -= 1; }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Pure: edição AAMMDD → ISO date "20YY-MM-DD". null se malformada. */
function editionToIsoDate(edition: string): string | null {
  if (!/^\d{6}$/.test(edition)) return null;
  return `20${edition.slice(0, 2)}-${edition.slice(2, 4)}-${edition.slice(4, 6)}`;
}

/**
 * Pure (#1753): true se a edição é a 1ª do seu mês — i.e. nenhuma edição já
 * publicada (`past-editions-raw.json`) cai no mesmo ano-mês com data
 * ESTRITAMENTE anterior. `publishedAt` = lista de ISO timestamps de
 * `published_at`. Edição malformada → true (fail-open, não suprime o bloco).
 * A própria edição corrente (mesma data) não conta contra si — comparação `<`.
 */
export function isFirstEditionOfMonth(
  edition: string,
  publishedAt: string[],
): boolean {
  const iso = editionToIsoDate(edition);
  if (!iso) return true;
  const ym = iso.slice(0, 7); // "20YY-MM"
  for (const ts of publishedAt) {
    if (typeof ts !== "string" || ts.length < 10) continue;
    const tsDate = ts.slice(0, 10); // "YYYY-MM-DD"
    if (tsDate.slice(0, 7) === ym && tsDate < iso) return false;
  }
  return true;
}

/**
 * Lê `published_at` de cada edição em `past-editions-raw.json`. Graceful:
 * arquivo ausente/inválido → `[]` (→ `isFirstEditionOfMonth` retorna true,
 * fail-open: mostra o bloco em vez de suprimir por engano).
 *
 * Exportado (#2725) — `inject-champions-callout.ts` reusa pra checar o mesmo
 * gate "1ª edição do mês" sem duplicar a leitura de `past-editions-raw.json`.
 */
export function readPublishedDates(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).published_at : null))
      .filter((d): d is string => typeof d === "string");
  } catch {
    return [];
  }
}

function parseArgs(
  argv: string[],
): { edition: string; out: string; pastEditions: string; brand: "diaria" | "clarice" } | null {
  const args = parseArgsSimple(argv);
  const edition = args.edition ?? "";
  const out = args.out ?? "";
  const pastEditions = args["past-editions"] ?? "data/past-editions-raw.json";
  const brand: "diaria" | "clarice" = args.brand === "clarice" ? "clarice" : "diaria";
  if (!edition || !out) return null;
  return { edition, out, pastEditions, brand };
}

// #1365: adapter pra manter compat com `fetchImpl: typeof fetch` injetado
// nos testes. Default = dohFetch wrapped, mas testes podem injetar mock.
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetchImpl: FetchLike = async (url, init) => {
  const res = await dohFetch(url, { signal: init?.signal });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export async function fetchTop1ForPeriod(
  slug: string,
  fetchImpl: FetchLike = defaultFetchImpl,
  brand: "diaria" | "clarice" = "diaria",
): Promise<Top1Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // #1905: brand=clarice puxa o leaderboard da Clarice News; default diaria
    // omite o param (back-compat com a URL legada).
    const brandParam = brand === "diaria" ? "" : `&brand=${brand}`;
    const res = await fetchImpl(
      `${WORKER_URL}/leaderboard/top1?period=${slug}${brandParam}`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json() as Top1Response;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: fetch-leaderboard-top1.ts --edition AAMMDD --out <path>");
    process.exit(1);
  }
  const slug = editionToMonthSlug(args.edition);
  if (!slug) {
    console.error(`Edition inválida: ${args.edition} (esperado AAMMDD)`);
    process.exit(1);
  }

  // #1753: o bloco "Vencedores do mês" só aparece na 1ª edição do mês e anuncia
  // o mês que acabou de fechar (período ANTERIOR). Em qualquer outra edição,
  // grava vazio — o renderer omite o bloco. Evita repetir os vencedores todo dia.
  const targetSlug = previousMonthSlug(slug);
  const publishedAt = readPublishedDates(
    resolve(process.cwd(), args.pastEditions),
  );
  const isFirst = isFirstEditionOfMonth(args.edition, publishedAt);

  let payload: Top1Response;
  if (!isFirst) {
    console.log(
      `[fetch-leaderboard-top1] edição ${args.edition} não é a 1ª do mês — ` +
        "leaderboard omitido (gravando vazio).",
    );
    // period_slug VAZIO de propósito: o renderer (renderLeaderboardTop1Row)
    // só OMITE o bloco quando não há slug (`if (!lbUrl) return ""`). Com um slug
    // não-vazio + zero líderes ele renderiza o convite "Acompanhe a leaderboard
    // de {mês}" — o que reintroduziria o bloco em toda edição (#1753). Vazio aqui
    // = bloco totalmente omitido nas edições que não são a 1ª do mês.
    payload = { top1: [], podium: [], period: "", period_slug: "" };
  } else {
    try {
      payload = await fetchTop1ForPeriod(targetSlug, defaultFetchImpl, args.brand);
      const podiumCount = payload.podium?.length ?? 0;
      console.log(
        `[fetch-leaderboard-top1] 1ª edição do mês — anunciando ${payload.period_slug}: ` +
          `${payload.top1.length} líder(es) em rank 1, ${podiumCount} no podium (1-3)`,
      );
    } catch (e) {
      // Graceful: persist payload vazio. Renderer omite bloco.
      console.error(
        `[fetch-leaderboard-top1] WARN: fetch falhou (${(e as Error).message}); ` +
          "gravando vazio — bloco será omitido da newsletter.",
      );
      payload = { top1: [], podium: [], period: "", period_slug: targetSlug };
    }
  }

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[fetch-leaderboard-top1] wrote ${outPath}`);
}

if (isMainModule(import.meta.url)) {
  await main();
}
