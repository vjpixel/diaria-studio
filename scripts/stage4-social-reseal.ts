#!/usr/bin/env npx tsx
/**
 * stage4-social-reseal.ts (#14116 item 2)
 *
 * Comando composto da re-humanização do social na Etapa 4 (§4d.1 passo 6,
 * receita K do cartão, exit 1/2 de §4c.2b). Na 261126 o
 * `check-humanizer-social.ts` rodou 16 vezes em chamadas separadas
 * (`--check`, `--record-run`, `--write`, mais `cp`, lints e o verify). O
 * trabalho de LLM (a Skill humanizador e a Clarice) continua no playbook; este
 * script junta os passos determinísticos de cada lado deles em 3 chamadas:
 *
 *   prepare         antes da Skill: `--check`, lê `{ legacy, changed_sections }`,
 *                   grava o snapshot `_internal/.stage4-pre-scoped-humanize.md`.
 *   after-humanizer depois da Skill, antes da Clarice: lint
 *                   `no-unanchored-opening` (aviso), snapshot
 *                   `_internal/03-social-post-humanizador.md`,
 *                   `--record-run --step humanizador` e, no fluxo scoped,
 *                   `verify-scoped-humanization.ts`.
 *   seal            depois da Clarice: `--record-run --step clarice` (ou
 *                   `--record-clarice-pending`), `--write --bypass-reason`, os 7
 *                   lints do passo 6.7 e o `--check` final.
 *
 * Só orquestra: cada passo é o script de sempre, por spawn, com os argumentos
 * que o playbook mandava rodar à mão. As travas dos scripts (recusa do
 * `--record-run` com pre = post, exit 3/4/5 do `--write`) valem iguais: o
 * composto para no passo que recusou e devolve o stderr dele.
 *
 * Uso:
 *   npx tsx scripts/stage4-social-reseal.ts prepare --edition-dir DIR
 *   npx tsx scripts/stage4-social-reseal.ts after-humanizer --edition-dir DIR [--sections a,b]
 *   npx tsx scripts/stage4-social-reseal.ts seal --edition-dir DIR --reason "motivo" \
 *     [--sections a,b] [--clarice-no-suggestions | --clarice-pending "exit e motivo"]
 *
 * `--sections` vazio = fluxo FULL-FILE (sem `--sections` no `--record-run` e
 * sem verify). `after-humanizer` recusa `--note` (exit 6, nada roda): nota não
 * prova o humanizador (#11609, restaurado no #13933 depois do #13889). Run em
 * que a Skill devolveu todo o escopo idêntico sai exit 2 (`--record-run`
 * recusou); seção única mantida de fato vai para `--write --unproven-ok` à mão,
 * fora do composto. `--clarice-no-suggestions` registra a
 * Clarice com `--note "Clarice sem sugestões"` (#11674): só quando ela rodou de
 * fato. `--clarice-pending` é a Clarice fora do ar (#13848).
 *
 * Saída: uma linha JSON no stdout. Exit codes:
 *   prepare:          0 = pronto (`state`: `sealed` nada a fazer, `changed`,
 *                     `sentinel-missing` → fluxo full-file); 1 = erro do check
 *   after-humanizer:  0 = ok (com `scope_warning` se o humanizador mexeu fora
 *                     do escopo, #3446); 2 = `--record-run` recusou;
 *                     3 = verify acusou seção-alvo não tocada (`untouchedTargets`);
 *                     7 = o verify falhou sem veredito (erro de uso/I/O dele, sem
 *                     `untouchedTargets` nem `unexpectedChanges`, texto em
 *                     `verify_error`): NUNCA é "rode o humanizador de novo"
 *   seal:             0 = selado e limpo; 2 = registro da Clarice recusado;
 *                     3 = `--write` recusou (exit do filho em `steps`);
 *                     4 = lint GATE-BLOCKING do 6.7 falhou; 5 = `--check` final ≠ 0
 *   qualquer:         6 = erro de uso ou de I/O deste script
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { realExec, parseStepJson, type ExecFn, type StepResult } from "./stage-0-run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PRE_SNAPSHOT = "_internal/.stage4-pre-scoped-humanize.md";
export const POST_HUMANIZER_SNAPSHOT = "_internal/03-social-post-humanizador.md";
export const STAGE2_PRE_HUMANIZER = "_internal/03-social-pre-humanizador.md";
export const CLARICE_NO_SUGGESTIONS_NOTE = "Clarice sem sugestões";

/** Lints do passo 6.7; `blocking` = GATE-BLOCKING por exit 1 (#4636, #4505 item 2). */
export const SEAL_LINTS: ReadonlyArray<{ check: string; blocking: boolean }> = [
  { check: "humanizer-section-coverage", blocking: false },
  { check: "relative-time", blocking: false },
  { check: "linkedin-schema", blocking: false },
  { check: "platform-headers-unicos", blocking: false },
  { check: "no-antithesis-reveal", blocking: true },
  { check: "no-trailing-editorial-hook", blocking: true },
  { check: "no-xml-artifacts", blocking: true },
];

export interface StepRun {
  step: string;
  code: number;
  /** stdout+stderr do passo, só quando ≠ 0 ou quando o texto é o que o playbook lê. */
  output?: string;
  skipped?: string;
}

export interface ResealDeps {
  exec: ExecFn;
  exists: (path: string) => boolean;
  copyFile: (from: string, to: string) => void;
}

function out(r: StepResult): string {
  return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
}

function step(name: string, r: StepResult, always = false): StepRun {
  return r.code === 0 && !always ? { step: name, code: 0 } : { step: name, code: r.code, output: out(r) };
}

const HUMANIZER = "scripts/check-humanizer-social.ts";

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export interface PrepareReport {
  state: "sealed" | "changed" | "sentinel-missing" | "error";
  flow?: "scoped" | "full-file";
  changed_sections: string[];
  snapshot?: string;
  check: StepRun;
  exit: number;
}

export function runPrepare(editionDir: string, deps: ResealDeps): PrepareReport {
  const r = deps.exec(HUMANIZER, ["--check", "--edition-dir", editionDir]);
  const check = step("check", r, r.code !== 0);
  if (r.code === 0) return { state: "sealed", changed_sections: [], check, exit: 0 };
  let flow: "scoped" | "full-file";
  let changed: string[] = [];
  let state: PrepareReport["state"];
  if (r.code === 2) {
    const parsed = parseStepJson<{ legacy?: boolean; changed_sections?: string[] }>(r.stdout);
    if (!parsed) return { state: "error", changed_sections: [], check, exit: 1 };
    state = "changed";
    flow = parsed.legacy === true ? "full-file" : "scoped";
    changed = parsed.changed_sections ?? [];
  } else if (r.code === 1 && r.stderr.includes("sentinel ausente")) {
    state = "sentinel-missing";
    flow = "full-file";
  } else {
    return { state: "error", changed_sections: [], check, exit: 1 };
  }
  const snapshot = join(editionDir, PRE_SNAPSHOT);
  deps.copyFile(join(editionDir, "03-social.md"), snapshot);
  return { state, flow, changed_sections: changed, snapshot, check, exit: 0 };
}

// ---------------------------------------------------------------------------
// after-humanizer
// ---------------------------------------------------------------------------

export interface AfterHumanizerReport {
  steps: StepRun[];
  untouched_targets: string[];
  scope_warning?: string[];
  /** Exit 7: o verify falhou sem veredito (erro de uso ou de I/O do verify). */
  verify_error?: string;
  exit: number;
}

export function runAfterHumanizer(
  editionDir: string,
  opts: { sections: string[] },
  deps: ResealDeps,
): AfterHumanizerReport {
  const social = join(editionDir, "03-social.md");
  const pre = join(editionDir, PRE_SNAPSHOT);
  const post = join(editionDir, POST_HUMANIZER_SNAPSHOT);
  const steps: StepRun[] = [];
  // Aviso apenas (#13427): o texto vai para o resumo do gate.
  steps.push(step("no-unanchored-opening", deps.exec("scripts/lint-social-md.ts", ["--check", "no-unanchored-opening", "--md", social])));
  deps.copyFile(social, post);

  const recordArgs = ["--record-run", "--step", "humanizador", "--pre", pre, "--post", post];
  if (opts.sections.length) recordArgs.push("--sections", opts.sections.join(","));
  recordArgs.push("--edition-dir", editionDir);
  const rec = deps.exec(HUMANIZER, recordArgs);
  steps.push(step("record-run-humanizador", rec));
  if (rec.code !== 0) return { steps, untouched_targets: [], exit: 2 };

  if (!opts.sections.length) return { steps, untouched_targets: [], exit: 0 };
  const verifyArgs = ["--pre", pre, "--post", post, "--sections", opts.sections.join(",")];
  const v = deps.exec("scripts/verify-scoped-humanization.ts", verifyArgs);
  steps.push(step("verify-scoped-humanization", v));
  const parsed = parseStepJson<{ untouchedTargets?: string[]; unexpectedChanges?: string[] }>(v.stdout) ?? {};
  const untouched = parsed.untouchedTargets ?? [];
  const unexpected = parsed.unexpectedChanges ?? [];
  if (v.code !== 0 && untouched.length > 0) return { steps, untouched_targets: untouched, exit: 3 };
  if (v.code !== 0 && unexpected.length === 0) {
    // Sem veredito: erro de uso/I/O do verify, nunca "alvo não tocado" (exit 3).
    return { steps, untouched_targets: [], verify_error: out(v) || `verify saiu ${v.code} sem saída`, exit: 7 };
  }
  return { steps, untouched_targets: [], ...(unexpected.length ? { scope_warning: unexpected } : {}), exit: 0 };
}

// ---------------------------------------------------------------------------
// seal
// ---------------------------------------------------------------------------

export interface SealOptions {
  reason: string;
  sections: string[];
  claricePending?: string;
  clariceNoSuggestions?: boolean;
}

export interface SealReport {
  steps: StepRun[];
  /** Lints informativos do 6.7 que acusaram algo (vão ao resumo do gate). */
  warnings: string[];
  exit: number;
}

export function runSeal(editionDir: string, opts: SealOptions, deps: ResealDeps): SealReport {
  const social = join(editionDir, "03-social.md");
  const post = join(editionDir, POST_HUMANIZER_SNAPSHOT);
  const steps: StepRun[] = [];
  const warnings: string[] = [];

  let clariceArgs: string[];
  if (opts.claricePending !== undefined) {
    clariceArgs = ["--record-clarice-pending", "--reason", "clarice_unavailable", "--detail", opts.claricePending];
    if (opts.sections.length) clariceArgs.push("--sections", opts.sections.join(","));
  } else {
    clariceArgs = ["--record-run", "--step", "clarice", "--pre", post, "--post", social];
    if (opts.clariceNoSuggestions) clariceArgs.push("--note", CLARICE_NO_SUGGESTIONS_NOTE);
  }
  clariceArgs.push("--edition-dir", editionDir);
  const c = deps.exec(HUMANIZER, clariceArgs);
  steps.push(step(opts.claricePending !== undefined ? "record-clarice-pending" : "record-run-clarice", c));
  if (c.code !== 0) return { steps, warnings, exit: 2 };

  const w = deps.exec(HUMANIZER, ["--write", "--bypass-reason", opts.reason, "--edition-dir", editionDir]);
  steps.push(step("write", w));
  if (w.code !== 0) return { steps, warnings, exit: 3 };

  let blockingFailed = false;
  for (const lint of SEAL_LINTS) {
    let args: string[];
    if (lint.check === "humanizer-section-coverage") {
      const stage2Pre = join(editionDir, STAGE2_PRE_HUMANIZER);
      if (!deps.exists(stage2Pre)) {
        steps.push({ step: lint.check, code: 0, skipped: `${STAGE2_PRE_HUMANIZER} ausente` });
        continue;
      }
      // #3947: contra o snapshot pós-humanizador, nunca o 03-social.md final.
      args = ["--check", lint.check, "--pre", stage2Pre, "--md", deps.exists(post) ? post : social];
    } else {
      args = ["--check", lint.check, "--md", social];
    }
    const r = deps.exec("scripts/lint-social-md.ts", args);
    steps.push(step(lint.check, r));
    if (r.code !== 0) {
      if (lint.blocking) blockingFailed = true;
      else warnings.push(lint.check);
    }
  }
  if (blockingFailed) return { steps, warnings, exit: 4 };

  const k = deps.exec(HUMANIZER, ["--check", "--edition-dir", editionDir]);
  steps.push(step("check", k));
  return { steps, warnings, exit: k.code === 0 ? 0 : 5 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function realDeps(rootDir: string = ROOT): ResealDeps {
  return { exec: realExec(rootDir), exists: existsSync, copyFile: copyFileSync };
}

function splitSections(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const USAGE =
  "Uso: stage4-social-reseal.ts prepare|after-humanizer|seal --edition-dir DIR " +
  "[--sections a,b] [--reason M] [--clarice-no-suggestions | --clarice-pending D]";

export function main(argv: string[], deps: ResealDeps = realDeps()): number {
  const { values, flags, positional } = parseArgs(argv);
  const cmd = positional[0];
  const dirArg = values["edition-dir"];
  if (!cmd || !dirArg) {
    console.error(USAGE);
    return 6;
  }
  const editionDir = resolve(dirArg);
  const sections = splitSections(values["sections"]);
  try {
    if (cmd === "prepare") {
      const r = runPrepare(editionDir, deps);
      console.log(JSON.stringify(r));
      return r.exit;
    }
    if (cmd === "after-humanizer") {
      if (values["note"] !== undefined || flags.has("note")) {
        console.error(
          "after-humanizer não aceita --note: nota não prova o humanizador (#11609, #13933). " +
            'Re-rode a Skill no escopo; seção única que ela manteve vai para --write --unproven-ok "<motivo>".',
        );
        return 6;
      }
      const r = runAfterHumanizer(editionDir, { sections }, deps);
      console.log(JSON.stringify(r));
      return r.exit;
    }
    if (cmd === "seal") {
      const reason = values["reason"];
      const pending = values["clarice-pending"];
      if (!reason) {
        console.error("seal exige --reason (vai como --bypass-reason do --write).");
        return 6;
      }
      if (pending !== undefined && flags.has("clarice-no-suggestions")) {
        console.error("--clarice-pending e --clarice-no-suggestions são exclusivos.");
        return 6;
      }
      if (flags.has("clarice-pending")) {
        console.error("--clarice-pending exige o desfecho (exit e motivo do stderr).");
        return 6;
      }
      const r = runSeal(
        editionDir,
        { reason, sections, claricePending: pending, clariceNoSuggestions: flags.has("clarice-no-suggestions") },
        deps,
      );
      console.log(JSON.stringify(r));
      return r.exit;
    }
  } catch (e) {
    console.error(`[stage4-social-reseal] ERRO: ${(e as Error).message}`);
    return 6;
  }
  console.error(USAGE);
  return 6;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
