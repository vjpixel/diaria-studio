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

  const drifted = findDriftedPairs(changedFiles);
  if (drifted.length === 0) {
    console.log("[#3105] Nenhum seed de página estática divergiu do HTML gerado. Pass.");
    process.exit(0);
    return;
  }

  console.error(formatFailure(drifted));
  process.exit(1);
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[#3105] erro não-tratado: ${(e as Error).message}`);
    process.exit(2);
  });
}
