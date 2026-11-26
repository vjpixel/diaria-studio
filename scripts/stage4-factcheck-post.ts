#!/usr/bin/env npx tsx
/**
 * stage4-factcheck-post.ts (#14116 item 1)
 *
 * Comando composto do §4c.6/§4c.6b/§4c.6c da Etapa 4: roda numa chamada só
 * a sequência que o orchestrator fazia em 4 a 10 chamadas separadas depois de
 * o subagente `fact-checker` gravar o JSON. Cada turno da Etapa 4 carrega uns
 * 300k de contexto, então juntar a sequência corta 1 ou 2 turnos por ciclo.
 *
 * Só orquestra: cada passo é o script de sempre, por spawn, com os mesmos
 * argumentos que o playbook mandava rodar à mão. Nenhuma regra é reimplementada
 * aqui.
 *
 *   1. (opcional) `--copy-from` copia o JSON que o agente gravou fora da
 *      edição (fallback de ENOENT da junction, #5083) para o caminho de entrada.
 *   2. `run-fact-checker.ts --input-json X [--merge-partial] --check-blocking`.
 *      Exit ≠ 0 para aqui (o autofix só roda sobre um fact-check válido).
 *   3. `apply-factcheck-autofix.ts` e leitura de `_internal/fact-check-autofix.json`.
 *   4. Se o autofix tocou a newsletter: `lint-newsletter-md --check callout-placement`.
 *      Se tocou o social: `check-humanizer-social --check` + os 5 lints de §4c.6c.
 *
 * O re-render/re-serve dos previews e o re-publish dos Artifacts seguem no
 * playbook (precisam do top-level); o JSON diz quais refazer em `rerender`.
 *
 * Uso:
 *   npx tsx scripts/stage4-factcheck-post.ts --edition-dir {EDITION_DIR}/ \
 *     [--input-json PATH] [--merge-partial] [--copy-from PATH]
 *
 * `--input-json` default: `_internal/fact-check.json`, ou
 * `_internal/fact-check.partial.json` com `--merge-partial`.
 *
 * Saída: uma linha JSON no stdout (`FactCheckPostReport`), com o resumo do
 * gate (`fact_check.summary`) e os avisos (`fact_check.stderr`) inteiros.
 *
 * Exit codes (mesma leitura do playbook, um por desfecho):
 *   0 = fact-check ok, autofix aplicado ou nada a aplicar, re-checagens limpas
 *   1 = fact-check indisponível (pré-condição, arquivo ausente) — não bloqueia
 *   2 = GATE-BLOCKING: claim NOT_FOUND_IN_SOURCE (#4361)
 *   3 = FACT-CHECK DEFASADO (#11685): re-despachar o fact-checker uma vez
 *   4 = `--merge-partial` recusado (#14035): refazer o fact-check COMPLETO
 *   5 = GATE-BLOCKING: o autofix quebrou um lint estrutural ou o selo do
 *       humanizador (§4c.6c) — ver `checks[]`
 *   6 = erro de uso ou de I/O deste script
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { realExec, type ExecFn, type StepResult } from "./stage-0-run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STALE_MARKER = "FACT-CHECK DEFASADO (#11685)";
export const PARTIAL_REFUSED_MARKER = "--merge-partial recusado";

/** Lints de §4c.6c quando o autofix mexeu em `03-social.md`. */
export const SOCIAL_POST_AUTOFIX_LINTS = [
  "post_pixel-matches-d1",
  "linkedin-page-link",
  "platform-headers-unicos",
  "no-antithesis-reveal",
  "no-trailing-editorial-hook",
] as const;

export type FactCheckPostOutcome =
  | "ok"
  | "unavailable"
  | "blocking"
  | "stale"
  | "partial-refused"
  | "post-autofix-broken";

export const OUTCOME_EXIT: Record<FactCheckPostOutcome, number> = {
  ok: 0,
  unavailable: 1,
  blocking: 2,
  stale: 3,
  "partial-refused": 4,
  "post-autofix-broken": 5,
};

export interface CheckRun {
  name: string;
  code: number;
  /** stdout+stderr só quando o check falhou (o verde não precisa de texto). */
  output?: string;
}

export interface FactCheckPostReport {
  outcome: FactCheckPostOutcome;
  exit: number;
  input_json: string;
  copied_from?: string;
  fact_check: { code: number; summary: string; stderr: string };
  autofix?: {
    code: number;
    applied: number;
    social_modified: boolean;
    social_residual_sections: string[];
    stdout: string;
    stderr?: string;
  };
  /** Previews a refazer no playbook (§4c.6b): newsletter se `applied > 0`, social se `social_modified`. */
  rerender: { newsletter: boolean; social: boolean };
  checks: CheckRun[];
}

export interface FactCheckPostDeps {
  exec: ExecFn;
  readText: (path: string) => string | undefined;
  copyFile: (from: string, to: string) => void;
}

export interface FactCheckPostOptions {
  editionDir: string;
  inputJson?: string;
  mergePartial?: boolean;
  copyFrom?: string;
}

interface AutofixJson {
  summary?: { applied?: number };
  social_modified?: boolean;
  entries?: Array<{ social_residual_sections?: string[] }>;
}

function joinOutput(r: StepResult): string {
  return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
}

export function defaultInputJson(editionDir: string, mergePartial: boolean): string {
  return join(editionDir, "_internal", mergePartial ? "fact-check.partial.json" : "fact-check.json");
}

/** Classifica o exit do `--check-blocking` pelo código e pelos marcadores do stderr. */
export function classifyCheckBlocking(r: StepResult): FactCheckPostOutcome {
  if (r.code === 0) return "ok";
  if (r.code === 2) return "blocking";
  if (r.stderr.includes(STALE_MARKER)) return "stale";
  if (r.stderr.includes(PARTIAL_REFUSED_MARKER)) return "partial-refused";
  return "unavailable";
}

export function runFactCheckPost(opts: FactCheckPostOptions, deps: FactCheckPostDeps): FactCheckPostReport {
  const editionDir = opts.editionDir;
  const mergePartial = opts.mergePartial === true;
  const inputJson = opts.inputJson ?? defaultInputJson(editionDir, mergePartial);
  const report: Omit<FactCheckPostReport, "outcome" | "exit" | "fact_check"> = {
    input_json: inputJson,
    rerender: { newsletter: false, social: false },
    checks: [],
  };
  if (opts.copyFrom) {
    deps.copyFile(opts.copyFrom, inputJson);
    report.copied_from = opts.copyFrom;
  }

  const fcArgs = ["--edition-dir", editionDir, "--input-json", inputJson];
  if (mergePartial) fcArgs.push("--merge-partial");
  fcArgs.push("--check-blocking");
  const fc = deps.exec("scripts/run-fact-checker.ts", fcArgs);
  const fact_check = { code: fc.code, summary: fc.stdout.trim(), stderr: fc.stderr.trim() };
  const fcOutcome = classifyCheckBlocking(fc);
  if (fcOutcome !== "ok") {
    return { ...report, outcome: fcOutcome, exit: OUTCOME_EXIT[fcOutcome], fact_check };
  }

  const af = deps.exec("scripts/apply-factcheck-autofix.ts", ["--edition-dir", editionDir]);
  let applied = 0;
  let socialModified = false;
  const residual = new Set<string>();
  if (af.code === 0) {
    const raw = deps.readText(join(editionDir, "_internal", "fact-check-autofix.json"));
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as AutofixJson;
        applied = parsed.summary?.applied ?? 0;
        socialModified = parsed.social_modified === true;
        for (const e of parsed.entries ?? []) for (const s of e.social_residual_sections ?? []) residual.add(s);
      } catch {
        // JSON ilegível: trata como nada aplicado; o stdout do autofix vai no relatório.
      }
    }
  }
  report.autofix = {
    code: af.code,
    applied,
    social_modified: socialModified,
    social_residual_sections: [...residual],
    stdout: af.stdout.trim(),
    ...(af.code !== 0 ? { stderr: af.stderr.trim() } : {}),
  };
  report.rerender = { newsletter: applied > 0, social: socialModified };

  const runCheck = (name: string, script: string, args: string[]) => {
    const r = deps.exec(script, args);
    report.checks.push(r.code === 0 ? { name, code: 0 } : { name, code: r.code, output: joinOutput(r) });
  };
  if (applied > 0) {
    runCheck("callout-placement", "scripts/lint-newsletter-md.ts", [
      "--check", "callout-placement", "--md", join(editionDir, "02-reviewed.md"),
    ]);
  }
  if (socialModified) {
    runCheck("humanizer-social-check", "scripts/check-humanizer-social.ts", ["--check", "--edition-dir", editionDir]);
    for (const lint of SOCIAL_POST_AUTOFIX_LINTS) {
      runCheck(lint, "scripts/lint-social-md.ts", ["--check", lint, "--md", join(editionDir, "03-social.md")]);
    }
  }
  const broken = report.checks.some((c) => c.code !== 0);
  const outcome: FactCheckPostOutcome = broken ? "post-autofix-broken" : "ok";
  return { ...report, outcome, exit: OUTCOME_EXIT[outcome], fact_check };
}

export function realDeps(rootDir: string = ROOT): FactCheckPostDeps {
  return {
    exec: realExec(rootDir),
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
    copyFile: (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    },
  };
}

function main(): number {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: stage4-factcheck-post.ts --edition-dir DIR [--input-json PATH] [--merge-partial] [--copy-from PATH]");
    return 6;
  }
  try {
    const report = runFactCheckPost(
      {
        editionDir: resolve(editionDirArg),
        inputJson: values["input-json"] ? resolve(values["input-json"]) : undefined,
        mergePartial: flags.has("merge-partial"),
        copyFrom: values["copy-from"] ? resolve(values["copy-from"]) : undefined,
      },
      realDeps(),
    );
    console.log(JSON.stringify(report));
    return report.exit;
  } catch (e) {
    console.error(`[stage4-factcheck-post] ERRO: ${(e as Error).message}`);
    return 6;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
