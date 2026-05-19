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

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { dohFetch } from "./lib/doh-fetch.ts"; // #1365 — DoH fallback pra UDP/53 broken

const WORKER_URL =
  process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";
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

function parseArgs(argv: string[]): { edition: string; out: string } | null {
  let edition = "";
  let out = "";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--edition" && value) { edition = value; i++; }
    else if (flag === "--out" && value) { out = value; i++; }
  }
  if (!edition || !out) return null;
  return { edition, out };
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
): Promise<Top1Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${WORKER_URL}/leaderboard/top1?period=${slug}`,
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

  let payload: Top1Response;
  try {
    payload = await fetchTop1ForPeriod(slug);
    const podiumCount = payload.podium?.length ?? 0;
    console.log(
      `[fetch-leaderboard-top1] ${payload.top1.length} líder(es) em rank 1, ${podiumCount} no podium (1-3), período ${payload.period_slug}`,
    );
  } catch (e) {
    // Graceful: persist payload vazio. Renderer omite bloco.
    console.error(
      `[fetch-leaderboard-top1] WARN: fetch falhou (${(e as Error).message}); ` +
        "gravando vazio — bloco será omitido da newsletter.",
    );
    payload = { top1: [], podium: [], period: "", period_slug: slug };
  }

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[fetch-leaderboard-top1] wrote ${outPath}`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}
