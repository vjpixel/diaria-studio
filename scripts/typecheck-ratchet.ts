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

/** Resultado de uma execução do `tsc`: saída combinada + como o processo
 * terminou. O `status`/`signal` é o que separa "compilou e achou erros de
 * tipo" de "o compilador nem terminou" (#12058). */
export interface TscRun {
  output: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

/** Forma mínima do retorno de `spawnSync` que o ratchet lê — permite injetar
 * um spawn falso no teste sem rodar o `tsc` real. */
export interface SpawnResultLike {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; maxBuffer: number; shell: boolean },
) => SpawnResultLike;

/** Exit codes que o `tsc` usa quando TERMINOU e reportou diagnósticos
 * (`DiagnosticsPresent_OutputsSkipped` = 1, `DiagnosticsPresent_OutputsGenerated` = 2). */
const TSC_DIAGNOSTIC_EXIT_CODES = new Set([1, 2]);

/**
 * Pura: decide se a execução do `tsc` é um resultado de compilação válido
 * para comparar com a baseline, ou uma falha de infraestrutura (#12058).
 *
 * - `status 0`, sem sinal: compilação limpa (ou com a lista parseada).
 * - `status 1|2` COM ao menos 1 diagnóstico parseável: fluxo normal do ratchet.
 * - Qualquer outro caso é abort: processo morto por sinal (`status null`,
 *   ex. SIGKILL do OOM killer), exit fora do contrato do `tsc` (134 =
 *   `FATAL ERROR: ... heap out of memory`, mesmo que tenha sobrado alguma
 *   linha de erro na saída), ou `status 1|2` sem nenhum diagnóstico
 *   parseável (ex. erro de config `error TS5058` sem arquivo, saída vazia).
 *   Ler isso como "0 erros" daria falso verde e, com `--update-baseline`,
 *   apagaria a baseline inteira.
 *
 * @pure
 */
export function assessTscRun(
  run: TscRun,
  diagnosticCount: number,
): { ok: true } | { ok: false; reason: string } {
  if (run.signal !== null) {
    return { ok: false, reason: `tsc abortou por sinal ${run.signal} (status ${run.status ?? "null"})` };
  }
  if (run.status === 0) return { ok: true };
  if (run.status === null) {
    return { ok: false, reason: "tsc terminou sem exit code nem sinal (status null)" };
  }
  if (!TSC_DIAGNOSTIC_EXIT_CODES.has(run.status)) {
    const fatal = /FATAL ERROR[^\n]*/.exec(run.output)?.[0]?.trim();
    return {
      ok: false,
      reason: `tsc abortou com exit ${run.status}${fatal ? ` (${fatal})` : ""} — exit fora do contrato do compilador (0/1/2)`,
    };
  }
  if (diagnosticCount === 0) {
    return {
      ok: false,
      reason: `tsc saiu com exit ${run.status} sem nenhum diagnóstico 'arquivo(l,c): error TSnnnn' parseável na saída`,
    };
  }
  return { ok: true };
}

/** Roda `tsc -p tsconfig.test.json --noEmit` e devolve a saída combinada
 * (stdout+stderr — o `tsc` normalmente escreve erros em stdout, mas
 * combinar os dois é fail-soft contra variação de versão/plataforma) junto
 * com `status`/`signal`. Nunca lança por causa do exit code do `tsc` (≠0 é o
 * caso NORMAL quando há erros) — quem julga abort é `assessTscRun` (#12058).
 * Só propaga se o próprio spawn falhar em executar (`error` setado, ex:
 * binário não encontrado). */
export function runTscTest(cwd: string = ROOT, spawn: SpawnLike = spawnSync as unknown as SpawnLike): TscRun {
  // `shell: true` é necessário aqui (diferente do `spawnSync("gh", [...])`
  // visto em `check-develop-label-cleared.ts`): `npx` é um wrapper `.cmd` no
  // Windows, não um executável direto, e `spawnSync` sem shell não resolve
  // isso — falha com `spawnSync npx ENOENT` (#6777). Portátil: `shell: true`
  // não quebra nada em Linux/Mac, onde `npx` já é resolvido normalmente.
  // Sem input de usuário nos argumentos (todos literais), então o não-escape
  // de array args com `shell: true` (aviso `DEP0190`) não é um risco aqui.
  const res = spawn("npx", ["tsc", "-p", TSCONFIG, "--noEmit"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (res.error) {
    throw new Error(`${LOG_PREFIX} falha ao executar 'npx tsc -p ${TSCONFIG} --noEmit': ${res.error.message}`);
  }
  return { output: `${res.stdout ?? ""}\n${res.stderr ?? ""}`, status: res.status, signal: res.signal };
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

/** Dependências injetáveis do fluxo do ratchet (teste usa spawn falso e
 * baseline em diretório temporário). */
export interface RatchetDeps {
  spawn?: SpawnLike;
  baselinePath?: string;
  cwd?: string;
}

/** Fluxo completo do CLI; devolve o exit code (0 OK, 1 regressão de tipo,
 * 2 abort do `tsc`, #12058). */
export function runRatchet(argv: readonly string[], deps: RatchetDeps = {}): number {
  const updateBaseline = hasFlag([...argv], "update-baseline");
  const baselinePath = deps.baselinePath ?? BASELINE_PATH;

  const run = runTscTest(deps.cwd ?? ROOT, deps.spawn);
  const errors = parseTscErrors(run.output);
  const assessment = assessTscRun(run, errors.length);
  if (!assessment.ok) {
    // Falha de infraestrutura (#12058): nunca comparar com a baseline nem
    // regravá-la — "0 erros" aqui é ausência de resultado, não código limpo.
    const tail = run.output.trim().split("\n").slice(-15).join("\n");
    console.error(
      `${LOG_PREFIX} FALHOU — ${assessment.reason}. Resultado descartado: baseline não comparada nem regravada. ` +
        `Rode 'npx tsc -p ${TSCONFIG} --noEmit' com memória suficiente (ex.: NODE_OPTIONS=--max-old-space-size=8192) para ver o erro.`,
    );
    if (tail) console.error(`${LOG_PREFIX} fim da saída do tsc:\n${tail}`);
    return 2;
  }
  const current = computeErrorCounts(errors);

  if (updateBaseline) {
    saveBaseline(current, baselinePath);
    console.log(
      `${LOG_PREFIX} baseline regravada em ${baselinePath} — ${errors.length} erro(s), ${Object.keys(current).length} chave(s) distinta(s).`,
    );
    return 0;
  }

  const baseline = loadBaseline(baselinePath);
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
    return 1;
  }

  console.log(`${LOG_PREFIX} OK — nenhum erro novo além da baseline.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runRatchet(process.argv.slice(2));
}
