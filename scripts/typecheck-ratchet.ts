#!/usr/bin/env node
/**
 * scripts/typecheck-ratchet.ts (#6217)
 *
 * CLI que liga `tsconfig.test.json` (typecheck de `scripts/**` + `test/**`
 * — o `tsconfig.json` raiz usado por `npm run typecheck` cobre só
 * `scripts/**`, deixando todo guard de tipo escrito em `test/**` decorativo,
 * ver docstring de `scripts/lib/tsc-baseline.ts`) no CI **sem** reprovar o
 * master pelos ~1.062 erros pré-existentes: roda `tsc -p tsconfig.test.json
 * --noEmit`, compara contra a baseline committed (`tsc-baseline.json`,
 * root do repo) e só reprova quando aparece uma chave NOVA (arquivo+código)
 * ou uma chave conhecida ganha MAIS ocorrências que o baseline aceita — ver
 * `evaluateRatchet` pro contrato exato.
 *
 * Uso:
 *   npx tsx scripts/typecheck-ratchet.ts                 # checa contra a baseline (exit 1 se regrediu)
 *   npx tsx scripts/typecheck-ratchet.ts --update-baseline  # regrava tsc-baseline.json com o estado ATUAL
 *
 * **Como baixar a baseline quando alguém corrigir erros (#6217, "documentar
 * no README/docstring"):** depois de corrigir 1+ erros de `test/**`/
 * `workers/**`, rodar `npx tsx scripts/typecheck-ratchet.ts --update-baseline`
 * e commitar o `tsc-baseline.json` resultante junto com o fix — o diff do
 * JSON mostra exatamente quais chaves saíram (prova visual de que o fix
 * funcionou, sem precisar confiar só no exit code). Rodar sem `--update-baseline`
 * primeiro pra conferir `resolvedKeys`/`decreasedKeys` no relatório antes de
 * decidir baixar.
 *
 * **Zero teto de tempo dedicado** — `tsc -p tsconfig.test.json --noEmit`
 * sobre ~250 arquivos de erro/todo o programa pode levar dezenas de
 * segundos; isso é esperado (mesmo custo que `npm run typecheck` já paga
 * pro tsconfig menor) e não tem timeout próprio além do que o runner do CI
 * já impõe pro job inteiro.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTscErrors, computeErrorCounts, evaluateRatchet, serializeBaseline, type TscBaseline } from "./lib/tsc-baseline.ts";
import { isMainModule, hasFlag } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, "tsc-baseline.json");
const TSCONFIG = "tsconfig.test.json";
const LOG_PREFIX = "[typecheck-ratchet]";

/** Roda `tsc -p tsconfig.test.json --noEmit` e devolve a saída combinada
 * (stdout+stderr — o `tsc` normalmente escreve erros em stdout, mas
 * combinar os dois é fail-soft contra variação de versão/plataforma).
 * Nunca lança por causa do exit code do `tsc` (≠0 é o caso NORMAL quando
 * há erros) — só propaga se o próprio `spawnSync` falhar em executar
 * (`error` setado, ex: binário não encontrado). */
export function runTscTest(cwd: string = ROOT): string {
  const res = spawnSync("npx", ["tsc", "-p", TSCONFIG, "--noEmit"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`${LOG_PREFIX} falha ao executar 'npx tsc -p ${TSCONFIG} --noEmit': ${res.error.message}`);
  }
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

export function loadBaseline(path: string = BASELINE_PATH): TscBaseline {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as TscBaseline;
    return {};
  } catch {
    return {};
  }
}

export function saveBaseline(baseline: TscBaseline, path: string = BASELINE_PATH): void {
  writeFileSync(path, serializeBaseline(baseline));
}

function main(): void {
  const argv = process.argv.slice(2);
  const updateBaseline = hasFlag(argv, "update-baseline");

  const output = runTscTest();
  const errors = parseTscErrors(output);
  const current = computeErrorCounts(errors);

  if (updateBaseline) {
    saveBaseline(current);
    console.log(
      `${LOG_PREFIX} baseline regravada em ${BASELINE_PATH} — ${errors.length} erro(s), ${Object.keys(current).length} chave(s) distinta(s).`,
    );
    return;
  }

  const baseline = loadBaseline();
  const result = evaluateRatchet(current, baseline);

  console.log(
    `${LOG_PREFIX} ${errors.length} erro(s) de 'tsc -p ${TSCONFIG}' (${Object.keys(current).length} chave(s) distinta(s)); baseline tem ${Object.keys(baseline).length} chave(s).`,
  );

  if (result.newKeys.length > 0) {
    console.error(`${LOG_PREFIX} ${result.newKeys.length} chave(s) NOVA(s) (arquivo+código sem entry na baseline):`);
    for (const key of result.newKeys) console.error(`  + ${key}`);
  }
  if (result.increasedKeys.length > 0) {
    console.error(`${LOG_PREFIX} ${result.increasedKeys.length} chave(s) com MAIS ocorrências que a baseline aceita:`);
    for (const e of result.increasedKeys) console.error(`  + ${e.key} (baseline: ${e.baselineCount}, atual: ${e.currentCount})`);
  }
  if (result.resolvedKeys.length > 0) {
    console.log(`${LOG_PREFIX} ${result.resolvedKeys.length} chave(s) da baseline não reproduzem mais (candidatas a baixar o baseline):`);
    for (const e of result.resolvedKeys) console.log(`  - ${e.key} (era ${e.baselineCount})`);
  }
  if (result.decreasedKeys.length > 0) {
    console.log(`${LOG_PREFIX} ${result.decreasedKeys.length} chave(s) com MENOS ocorrências que a baseline (candidatas a baixar):`);
    for (const e of result.decreasedKeys) console.log(`  - ${e.key} (baseline: ${e.baselineCount}, atual: ${e.currentCount})`);
  }

  if (!result.ok) {
    console.error(
      `${LOG_PREFIX} FALHOU — erro de tipo NOVO detectado em 'scripts/**' ou 'test/**'. ` +
        `Se for intencional (baseline pré-existente que você decidiu não corrigir agora), ` +
        `rode 'npx tsx scripts/typecheck-ratchet.ts --update-baseline' e commite o tsc-baseline.json.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${LOG_PREFIX} OK — nenhum erro novo além da baseline.`);
}

if (isMainModule(import.meta.url)) {
  main();
}
