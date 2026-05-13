#!/usr/bin/env tsx
/**
 * maintain-valid-editions-window.ts (#1233)
 *
 * Mantém o set `valid_editions` no KV do Worker `diar-ia-poll` cobrindo
 * **últimas N dias de edições publicadas** + edição corrente. Substitui
 * o uso direto de `add-valid-edition.ts` em Stage 0 (orchestrator-stage-0
 * §0d.bis).
 *
 * Razão (#1233): `add-valid-edition.ts` opera com Set.add() append-only.
 * Stage 0 só passa a edição corrente. Em estado degenerate (set vazio
 * por fail-open histórico), o primeiro add transforma `[]` em `[hoje]`
 * — gate fica ATIVO com APENAS hoje, rejeitando votos em todas as edições
 * arquivadas com HTTP 410.
 *
 * Caso real 2026-05-13: `/diaria-test 260517` rodou add-valid-edition
 * 260517 num set vazio. Resultado: set virou `["260517"]`, e votos em
 * 260512, 260511, 260509, 260508, 260507 (todas publicadas, todas com
 * subscribers podendo clicar de inbox arquivado) viraram 410.
 *
 * Este script:
 * 1. Lê `data/past-editions-raw.json` (mantido por `refresh-dedup.ts`)
 * 2. Filtra editions com `published_at` >= now - windowDays (default 7)
 * 3. Une com edition corrente (opt-in via --current)
 * 4. Escreve o set ordenado no KV
 * 5. Retorna diff (added / removed / unchanged)
 *
 * Uso:
 *   npx tsx scripts/maintain-valid-editions-window.ts --current 260517 [--window-days 7]
 *
 * Idempotente: re-rodar com mesmo window é no-op se o set já bate.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { readValidEditions, writeValidEditions } from "./lib/poll-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PastEdition {
  published_at: string;
  // outros campos não importam aqui
}

export interface MaintainResult {
  previous: string[];
  current: string[];
  added: string[];
  /**
   * Entries em `previous` (KV) mas FORA da janela atual. Mantidas no KV por
   * política de preservação (#1233) — editor pode ter adicionado especiais
   * manuais. Informativo only — não foram removidas.
   */
  out_of_window: string[];
  unchanged: boolean;
  window_days: number;
  current_edition: string | null;
  /**
   * Set quando read falha (wrangler down, OAuth expirado). run() aborta
   * sem escrever pra evitar destruição de entries manuais. Caller checka.
   */
  read_failed?: boolean;
}

/**
 * Converte `published_at` ISO pra string AAMMDD usando data UTC.
 */
function isoToAammdd(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getUTCFullYear()).slice(-2) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/**
 * Lê `data/past-editions-raw.json` e retorna AAMMDD das edições com
 * `published_at` dentro da janela (>= now - windowDays).
 */
export function editionsInWindow(opts: {
  pastEditionsRawPath: string;
  windowDays: number;
  now: Date;
}): string[] {
  if (!existsSync(opts.pastEditionsRawPath)) return [];
  const raw = readFileSync(opts.pastEditionsRawPath, "utf8");
  let parsed: PastEdition[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const cutoff = new Date(opts.now);
  cutoff.setUTCDate(cutoff.getUTCDate() - opts.windowDays);

  const out: string[] = [];
  for (const e of parsed) {
    if (!e?.published_at) continue;
    const t = new Date(e.published_at).getTime();
    if (isNaN(t) || t < cutoff.getTime()) continue;
    out.push(isoToAammdd(e.published_at));
  }
  return out;
}

export function diffSets(previous: string[], target: string[]): {
  added: string[];
  removed: string[];
  unchanged: boolean;
} {
  const prevSet = new Set(previous);
  const targSet = new Set(target);
  const added = [...targSet].filter((x) => !prevSet.has(x)).sort();
  const removed = [...prevSet].filter((x) => !targSet.has(x)).sort();
  return { added, removed, unchanged: added.length === 0 && removed.length === 0 };
}

/**
 * DI shape (#1234 review) — permite teste sem wrangler real.
 */
export interface RunDeps {
  readEditions: () => { editions: string[]; read_failed: boolean };
  writeEditions: (editions: string[]) => void;
}

const defaultDeps: RunDeps = {
  readEditions: readValidEditions,
  writeEditions: writeValidEditions,
};

export function run(
  opts: {
    currentEdition: string | null;
    windowDays: number;
    pastEditionsRawPath: string;
    now: Date;
  },
  deps: RunDeps = defaultDeps,
): MaintainResult {
  if (opts.currentEdition !== null && !/^\d{6}$/.test(opts.currentEdition)) {
    throw new Error(`--current deve ser AAMMDD (6 dígitos): "${opts.currentEdition}"`);
  }

  const readResult = deps.readEditions();

  // #1234 review: se read falhou, ABORT em vez de tratar como []. Caso
  // contrário, transient wrangler failure → sobrescreve KV destruindo
  // entries manuais que estavam lá.
  if (readResult.read_failed) {
    return {
      previous: [],
      current: [],
      added: [],
      out_of_window: [],
      unchanged: true,
      window_days: opts.windowDays,
      current_edition: opts.currentEdition,
      read_failed: true,
    };
  }
  const previous = readResult.editions;

  const windowEditions = editionsInWindow({
    pastEditionsRawPath: opts.pastEditionsRawPath,
    windowDays: opts.windowDays,
    now: opts.now,
  });

  const targetSet = new Set(windowEditions);
  if (opts.currentEdition) targetSet.add(opts.currentEdition);
  const target = [...targetSet].sort();

  const { added, removed } = diffSets(previous, target);

  // Política de preservação (#1233): nunca remover entries do set. Editor
  // pode ter adicionado edições especiais manualmente (debug, testes). Só
  // ADICIONAMOS o que faltar da janela — out_of_window é informativo only.
  // Resultado real escrito: união (previous ∪ target).
  const finalSet = new Set([...previous, ...target]);
  const finalArr = [...finalSet].sort();

  // changed = added.length > 0 (porque nunca removemos)
  const changed = added.length > 0;
  if (changed) {
    deps.writeEditions(finalArr);
  }

  return {
    previous,
    current: finalArr,
    added,
    out_of_window: removed, // (#1234 review) renomeado de "removed" — entries em previous mas FORA da janela, MANTIDAS.
    unchanged: !changed,
    window_days: opts.windowDays,
    current_edition: opts.currentEdition,
  };
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const current = values["current"] ?? null;
  const windowDaysStr = values["window-days"] ?? "7";
  const windowDays = parseInt(windowDaysStr, 10);
  if (isNaN(windowDays) || windowDays < 1) {
    console.error(`--window-days deve ser inteiro positivo: "${windowDaysStr}"`);
    process.exit(2);
  }

  const result = run({
    currentEdition: current,
    windowDays,
    pastEditionsRawPath: resolve(ROOT, "data/past-editions-raw.json"),
    now: new Date(),
  });

  console.log(JSON.stringify(result, null, 2));

  // #1234 review: read_failed = wrangler down OU KV vazia (ambiguidade
  // intencional — conservador). Sair com exit 2 pra orchestrator detectar
  // e logar warn. Orquestrador no playbook trata como warning (não bloqueia).
  if (result.read_failed) {
    console.error(
      "\n⚠️ readValidEditions retornou read_failed=true. KV pode estar vazia (primeira execução) OU wrangler falhou. " +
        "Pra forçar reset em KV virgem, rodar `add-valid-edition.ts --edition AAMMDD` uma vez manualmente.",
    );
    process.exit(2);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
