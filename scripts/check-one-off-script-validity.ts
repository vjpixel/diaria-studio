#!/usr/bin/env npx tsx
/**
 * scripts/check-one-off-script-validity.ts (#7114)
 *
 * Roda em GH Action `pr-checks.yml` pra cada PR. Detecta arquivo NOVO
 * (status `A` no diff, nunca modificado — a #7114 é explícita: "Não
 * remover nenhum script existente aqui... não estender o marcador a script
 * de pipeline ou task agendada") dentro de `scripts/` (nível raiz, não
 * `scripts/lib/`) cujo nome bate o padrão `analyze-*`/`diagnose-*`/
 * `probe-*`/`measure-*`/`compare-*` e falha ALTO se ele não declarar
 * `@one-off-validity` (ver `scripts/lib/one-off-script-validity.ts`).
 *
 * FALHA ALTO de propósito (não avisa e deixa passar) — dado que o gate
 * precisa (lista de arquivos novos do PR, conteúdo desses arquivos) é
 * 100% local ao checkout (`git diff` entre 2 SHAs já presentes,
 * `fetch-depth: 0`), nunca depende de rede/API externa — não há cenário
 * fail-soft aplicável aqui além de erro de invocação (env vars ausentes).
 *
 * Env vars (passados pelo GH Action):
 *   BASE_SHA — sha do base (master) na hora do PR
 *   HEAD_SHA — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (nenhum script one-off novo, OU todos os novos declaram o marcador)
 *   1 — falha (script novo sem marcador, ou marcador malformado)
 *   2 — input inválido / erro de git irrecuperável
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import type { PrCheckSpawnFn } from "./lib/spawn-types.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  checkOneOffScriptValidity,
  isOneOffScriptFilename,
  malformedMarkerMessage,
  missingMarkerMessage,
} from "./lib/one-off-script-validity.ts";

export type SpawnFn = PrCheckSpawnFn;

const LOG_PREFIX = "[#7114]";

/** Paths ADICIONADOS (status `A`, nunca `M`/`R`/`D`) sob `scripts/` (nível
 * raiz — exclui `scripts/lib/`, `scripts/studio-ui/`, etc., onde o padrão
 * de nome não é o alvo do guard). */
export function getAddedScriptRootFiles(baseSha: string, headSha: string, spawnFn: SpawnFn = spawnSync): string[] {
  const r = spawnFn("git", ["diff", "--name-status", "--diff-filter=A", `${baseSha}..${headSha}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff failed: ${r.stderr}`);
  }
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, path] = line.split("\t");
    if (status !== "A" || !path) continue;
    // "nível raiz de scripts/" = exatamente 1 segmento depois de "scripts/".
    if (/^scripts\/[^/]+$/.test(path)) paths.push(path);
  }
  return paths;
}

/**
 * Pura — dado os paths NOVOS já filtrados pra nível-raiz de `scripts/` e um
 * `readFileFn` injetável (pra teste sem tocar disco), devolve as violações
 * (path + mensagem) pra cada arquivo que bate o padrão one-off sem marcador
 * válido. Vazio = passa.
 */
export function findOneOffValidityViolations(
  addedPaths: readonly string[],
  readFileFn: (path: string) => string,
): { path: string; message: string }[] {
  const violations: { path: string; message: string }[] = [];
  for (const path of addedPaths) {
    const name = basename(path);
    if (!isOneOffScriptFilename(name)) continue;
    let source: string;
    try {
      source = readFileFn(path);
    } catch (e) {
      violations.push({ path, message: `${path}: não foi possível ler o arquivo (${(e as Error).message}).` });
      continue;
    }
    const result = checkOneOffScriptValidity(name, source);
    if (result.status === "missing") {
      violations.push({ path, message: missingMarkerMessage(path) });
    } else if (result.status === "malformed") {
      violations.push({ path, message: malformedMarkerMessage(path, result.raw) });
    }
  }
  return violations;
}

function main(): void {
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!baseSha || !headSha) {
    console.error(`${LOG_PREFIX} env vars ausentes: BASE_SHA, HEAD_SHA são obrigatórias.`);
    process.exit(2);
  }

  let addedPaths: string[];
  try {
    addedPaths = getAddedScriptRootFiles(baseSha, headSha);
  } catch (e) {
    console.error(`${LOG_PREFIX} git diff falhou: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const violations = findOneOffValidityViolations(addedPaths, (p) => readFileSync(p, "utf8"));

  if (violations.length === 0) {
    console.log(`${LOG_PREFIX} ok — nenhum script one-off novo sem validade declarada.`);
    return;
  }

  console.error(`${LOG_PREFIX} ${violations.length} arquivo(s) novo(s) sem validade declarada:`);
  for (const v of violations) {
    console.error(`\n${v.message}`);
  }
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
