/**
 * check-seed-html-sync.ts (#3105)
 *
 * Roda em GH Action `pr-checks.yml` pra cada PR. Detecta quando um seed de
 * página estática (`seed/courses/*.json`, `seed/books/*.json`) mudou no PR
 * mas o HTML gerado correspondente (`workers/cursos/public/index.html`,
 * `workers/livros/public/index.html`) NÃO mudou no mesmo PR — sinal forte de
 * que o build step (`build-cursos-page.ts`/`build-livros-page.ts`) não foi
 * rodado antes do commit.
 *
 * Motivação (#3105): commit 00dcb5a1 (#2451) atualizou
 * `seed/courses/cursos-ia.json` E `workers/cursos/public/index.html`
 * corretamente (o teste de drift `test/cursos-asset-drift.test.ts` já cobre
 * "o HTML committed bate com o seed"), mas o deploy do Worker nunca rodou —
 * gap operacional, não de build. Este check ataca um sintoma relacionado e
 * mais barato de detectar cedo: complementa (não substitui) o teste de drift
 * dando um sinal específico e imediato de "você esqueceu de rodar o builder"
 * já no diff do PR, sem precisar re-renderizar o HTML inteiro.
 *
 * Este check NÃO dispara deploy — blast radius de deploy automático de
 * Worker de produção em CI é alto demais (ver CLAUDE.md, princípios
 * operacionais). Só alerta/falha o PR.
 *
 * Env vars (passados pelo GH Action):
 *   BASE_SHA — sha do base (master) na hora do PR
 *   HEAD_SHA — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (nenhum seed mudou, OU todo seed que mudou teve o HTML
 *       correspondente também mudado no mesmo PR)
 *   1 — falha (seed mudou sem o HTML correspondente)
 *   2 — input inválido / erro de git irrecuperável
 */

import { spawnSync } from "node:child_process";
import type { PrCheckSpawnFn } from "./lib/spawn-types.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { buildHomeFeed, buildIndexHtml } from "./lib/site-home-page.ts";

/** Alias local — mesmo padrão de scripts/check-pr-bugfix.ts (#2699). */
export type SpawnFn = PrCheckSpawnFn;

/**
 * Par seed → HTML gerado. Adicionar aqui quando uma nova página estática
 * ganhar um seed + builder (mesmo padrão de cursos/livros).
 */
export interface SeedHtmlPair {
  /** Nome curto pra mensagens de erro. */
  name: string;
  /** Prefixo de path que identifica arquivos do seed (ex: "seed/courses/"). */
  seedPrefix: string;
  /** Path do HTML gerado que deve acompanhar qualquer mudança no seed. */
  htmlPath: string;
  /** Comando pra regenerar o HTML — impresso na mensagem de erro. */
  buildCommand: string;
}

export const SEED_HTML_PAIRS: SeedHtmlPair[] = [
  {
    name: "cursos",
    seedPrefix: "seed/courses/",
    htmlPath: "workers/cursos/public/index.html",
    buildCommand: "npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html",
  },
  // #6454: `workers/site/public/index.html` (a home) é derivado de
  // `sitemap.xml` (`gen-home-page.ts`/`publish-edition-site-page.ts
  // --sitemap` já regeneram os dois juntos no caminho automático — este
  // par pega o caminho MANUAL: alguém rodando `gen-archive-pages.ts` (que
  // reescreve o sitemap inteiro) sem rodar `gen-home-page.ts` na sequência,
  // exatamente o esquecimento que deixou a home congelada ~10 dias antes
  // do fix). `seedPrefix` aqui é o PRÓPRIO sitemap, não um diretório — o
  // matcher (`startsWith`) casa com igualdade exata do mesmo jeito.
  {
    name: "home-do-site",
    seedPrefix: "workers/site/public/sitemap.xml",
    htmlPath: "workers/site/public/index.html",
    buildCommand: "npx tsx scripts/gen-home-page.ts",
  },
  {
    name: "livros",
    seedPrefix: "seed/books/",
    htmlPath: "workers/livros/public/index.html",
    buildCommand: "npx tsx scripts/build-livros-page.ts --out workers/livros/public/index.html",
  },
];

export function getChangedFiles(baseSha: string, headSha: string, spawnFn: SpawnFn): string[] {
  const r = spawnFn("git", ["diff", "--name-status", `${baseSha}..${headSha}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff falhou: ${r.stderr}`);
  }
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (status === "A" || status === "M" || status === "D") {
      const p = parts[1];
      if (p) paths.push(p);
    } else if (status?.startsWith("R")) {
      // rename — só o path novo conta (mesmo padrão de check-pr-bugfix.ts,
      // #2082). Incluir o path antigo aqui causaria falso-negativo: se
      // htmlPath for renomeado PRA FORA (deixa de existir naquele path), o
      // path antigo ainda cairia em changedSet e o check reportaria "sem
      // drift" mesmo com o asset de fato ausente do path esperado.
      const p = parts[2] ?? parts[1];
      if (p) paths.push(p);
    }
  }
  return paths;
}

/**
 * Um par "falha" quando ALGUM arquivo mudado começa com `seedPrefix` mas
 * `htmlPath` não está entre os arquivos mudados.
 */
export function findDriftedPairs(
  changedFiles: string[],
  pairs: SeedHtmlPair[] = SEED_HTML_PAIRS,
): SeedHtmlPair[] {
  const changedSet = new Set(changedFiles);
  return pairs.filter((pair) => {
    const seedChanged = changedFiles.some((f) => f.startsWith(pair.seedPrefix));
    if (!seedChanged) return false;
    return !changedSet.has(pair.htmlPath);
  });
}

/**
 * #7864: mesmo limite de `gen-home-page.ts` (`DEFAULT_ARCHIVE_LIMIT`) — a
 * home mostra 6 cards de arquivo + a feature; manter os dois em sincronia
 * evita que este re-render produza um `index.html` estruturalmente diferente
 * do gerador oficial por um detalhe de limite, não de conteúdo.
 */
const HOME_ARCHIVE_LIMIT = 6;

/** Lê o conteúdo de `path` na árvore de `ref` via `git show` — `null` se o path não existir nesse ref (nunca lança por ausência, só por erro de git genuíno). */
function readFileAtRef(ref: string, path: string, spawnFn: SpawnFn): string | null {
  const r = spawnFn("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

/**
 * #7864: re-renderiza `workers/site/public/index.html` a partir do
 * `sitemap.xml` + páginas de edição (`workers/site/public/p/{slug}/index.html`)
 * como estavam no HEAD_SHA do PR — mesmo miolo puro que `gen-home-page.ts`
 * usa em produção (`buildHomeFeed`/`buildIndexHtml`, `scripts/lib/site-home-page.ts`),
 * só que lendo do objeto git do commit em vez do working directory. Isso
 * garante corretude mesmo se o working directory do runner não estiver
 * necessariamente no HEAD_SHA exato do PR (`actions/checkout@v4` no evento
 * `pull_request` traz o merge ref, não o head puro) — mesma técnica que
 * `getChangedFiles` já usa pra diffar sem depender do working directory.
 *
 * Lança se o sitemap não existir em `ref` — nesse caso não há como avaliar
 * "bateria ou não", e o chamador trata isso como drift real (fail-safe).
 */
export function renderHomePageAtRef(ref: string, spawnFn: SpawnFn): string {
  const sitemapXml = readFileAtRef(ref, "workers/site/public/sitemap.xml", spawnFn);
  if (sitemapXml === null) {
    throw new Error(`renderHomePageAtRef: workers/site/public/sitemap.xml não encontrado em ${ref}`);
  }
  const readPageHtml = (slug: string): string | null =>
    readFileAtRef(ref, `workers/site/public/p/${slug}/index.html`, spawnFn);
  // +1 pra separar a feature (feed[0]) e ainda sobrar HOME_ARCHIVE_LIMIT
  // entradas de arquivo — mesma soma de gen-home-page.ts.
  const feed = buildHomeFeed(sitemapXml, readPageHtml, HOME_ARCHIVE_LIMIT + 1);
  const feature = feed[0] ?? null;
  const archive = feed.slice(1);
  return buildIndexHtml({ feature, archive });
}

/**
 * #7864: resolve se o par `home-do-site` é drift REAL ou falso-positivo.
 *
 * `findDriftedPairs` só olha presença no diff — nunca compara conteúdo. Para
 * este par especificamente, `sitemap.xml` pode mudar (nova edição D+1
 * publicada) sem que nenhuma edição nova fique elegível pra home HOJE (a
 * mais recente elegível já era a mesma de antes) — nesse caso, re-renderizar
 * `index.html` produz um resultado byte-a-byte idêntico ao já committed, e
 * não há "esquecimento de build" real pra reportar.
 *
 * Retorna `true` (drift real, deve reprovar) quando o re-render diverge do
 * `index.html` committed em `headSha`, OU quando o `index.html` não existe
 * nesse ref (caso degenerado — tratado como drift, nunca engolido em
 * silêncio), OU quando o próprio re-render lança (sitemap ausente/corrompido
 * — fail-safe: sem conseguir confirmar "não é drift", reprova como hoje).
 */
export function confirmHomeDrift(headSha: string, spawnFn: SpawnFn): boolean {
  const committed = readFileAtRef(headSha, "workers/site/public/index.html", spawnFn);
  if (committed === null) return true;
  let rendered: string;
  try {
    rendered = renderHomePageAtRef(headSha, spawnFn);
  } catch (e) {
    console.error(
      `[#7864] falha ao re-renderizar a home pra confirmar drift — tratando como drift real: ${(e as Error).message}`,
    );
    return true;
  }
  return rendered !== committed;
}

/**
 * #7864: aplica a confirmação por re-render só ao par `home-do-site` — os
 * demais pares (cursos/livros) não têm essa fonte de falso-positivo (seus
 * seeds sempre implicam mudança visível de conteúdo, ver corpo da issue) e
 * continuam reprovando só por presença no diff, como sempre.
 */
export function filterConfirmedDrift(
  candidates: SeedHtmlPair[],
  headSha: string,
  spawnFn: SpawnFn,
): SeedHtmlPair[] {
  return candidates.filter((pair) => {
    if (pair.name !== "home-do-site") return true;
    return confirmHomeDrift(headSha, spawnFn);
  });
}

function formatFailure(drifted: SeedHtmlPair[]): string {
  const lines = [
    `[#3105] Seed de página estática mudou sem o HTML correspondente no mesmo PR.`,
    ``,
  ];
  for (const pair of drifted) {
    lines.push(
      `  - ${pair.name}: ${pair.seedPrefix}*.json mudou, mas ${pair.htmlPath} não.`,
      `    Rode: ${pair.buildCommand}`,
      `    E inclua o HTML atualizado no mesmo commit.`,
      ``,
    );
  }
  lines.push(
    `Sem isso, o deploy do Worker (wrangler deploy) fica servindo conteúdo`,
    `defasado em relação ao seed — foi exatamente o que aconteceu em #3105.`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!baseSha || !headSha) {
    console.error("[#3105] env vars ausentes: BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(baseSha, headSha, spawnSync as SpawnFn);
  } catch (e) {
    console.error(`[#3105] ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const candidates = findDriftedPairs(changedFiles);
  const drifted = filterConfirmedDrift(candidates, headSha, spawnSync as SpawnFn);
  if (drifted.length === 0) {
    console.log("[#3105] Nenhum seed de página estática divergiu do HTML gerado. Pass.");
    process.exit(0);
    return;
  }

  console.error(formatFailure(drifted));
  process.exit(1);
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[#3105] erro não-tratado: ${(e as Error).message}`);
    process.exit(2);
  });
}
