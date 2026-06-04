/**
 * preflight-poll-dispatch.ts (#1803)
 *
 * Gate determinístico de poll que roda ANTES do envio da newsletter, em
 * QUALQUER entry path (incl. resume direto pro Stage 4 pós-compactação).
 *
 * Resolve o P1 #1803: num resume que entra pelo dispatch, os passos de
 * manutenção de poll do Stage 0 (§0d.bis maintain-valid-editions, §0d.ter
 * inject-poll-sig) não rodam, e o "É IA?" quebra ao vivo (410 "não aceita
 * mais votos" / 403 "sig inválida") pra todos os subscribers — silenciosamente.
 * O smoke-test antigo (§4h-bis) só rodava DEPOIS do envio, tarde demais.
 *
 * Estratégia: best-effort FIX primeiro (idempotente, warn-only), depois
 * VERIFY como gate duro:
 *   1. maintain-valid-editions-window --current {ed}  (garante ed no set; warn)
 *   2. inject-poll-sig --since-hours 96               (garante poll_sig; warn)
 *   3. smoke-test-vote --edition {ed}                 (HARD GATE — bloqueia envio)
 *
 * Os dois primeiros são best-effort: se falharem (KV transiente, Beehiiv 5xx),
 * loga warn e segue — o smoke-test é a fonte de verdade. Se o smoke-test
 * falhar (410/403/network), exit 1 + halt banner → o orchestrator NÃO envia.
 *
 * Uso:
 *   npx tsx scripts/preflight-poll-dispatch.ts --edition 260604
 *
 * Exit codes:
 *   0 — poll pronto pro dispatch (smoke-test passou)
 *   1 — args inválidos OU gate duro falhou (NÃO enviar a newsletter)
 */

import "dotenv/config";

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type StepName =
  | "maintain-valid-editions"
  | "inject-poll-sig"
  | "smoke-test-vote";

export interface StepSpec {
  name: StepName;
  script: string;
  args: string[];
  /** true = falha bloqueia o envio; false = best-effort (warn-only). */
  blocking: boolean;
}

/**
 * Ordem fixa: FIX idempotente (maintain + inject, warn-only) → VERIFY (smoke,
 * gate duro). Pura — sem efeitos colaterais, testável.
 */
export function planSteps(
  edition: string,
  opts: { windowDays?: number; sinceHours?: number } = {},
): StepSpec[] {
  const windowDays = opts.windowDays ?? 7;
  const sinceHours = opts.sinceHours ?? 96;
  return [
    {
      name: "maintain-valid-editions",
      script: "scripts/maintain-valid-editions-window.ts",
      args: ["--current", edition, "--window-days", String(windowDays)],
      blocking: false,
    },
    {
      name: "inject-poll-sig",
      script: "scripts/inject-poll-sig.ts",
      args: ["--since-hours", String(sinceHours)],
      blocking: false,
    },
    {
      name: "smoke-test-vote",
      script: "scripts/smoke-test-vote.ts",
      args: ["--edition", edition],
      blocking: true,
    },
  ];
}

export interface StepOutcome {
  name: StepName;
  exitCode: number;
  blocking: boolean;
}

export interface PreflightDecision {
  ok: boolean;
  /** true → o orchestrator deve abortar o envio da newsletter. */
  block: boolean;
  warnings: StepName[];
  blockingStep: StepName | null;
  haltReason: string | null;
  haltAction: string | null;
}

/**
 * Mapeia os exit codes dos passos → decisão de envio. Pura e testável.
 * Qualquer passo blocking com exit ≠ 0 bloqueia; passos best-effort viram warn.
 */
export function decide(edition: string, outcomes: StepOutcome[]): PreflightDecision {
  const warnings = outcomes
    .filter((o) => !o.blocking && o.exitCode !== 0)
    .map((o) => o.name);
  const blocker = outcomes.find((o) => o.blocking && o.exitCode !== 0) ?? null;
  if (!blocker) {
    return {
      ok: true,
      block: false,
      warnings,
      blockingStep: null,
      haltReason: null,
      haltAction: null,
    };
  }
  const { reason, action } = haltFor(edition, blocker.exitCode);
  return {
    ok: false,
    block: true,
    warnings,
    blockingStep: blocker.name,
    haltReason: reason,
    haltAction: action,
  };
}

/** Mensagem de halt por exit code do smoke-test-vote (2 = 410/403, 3 = net). */
function haltFor(edition: string, exitCode: number): { reason: string; action: string } {
  if (exitCode === 2) {
    return {
      reason: `smoke-test-vote falhou (410/403) — edição ${edition} fora de valid_editions OU sig HMAC inválida`,
      action: `rode 'npx tsx scripts/add-valid-edition.ts --edition ${edition}' (e confira POLL_SECRET no .env), depois retente`,
    };
  }
  if (exitCode === 3) {
    return {
      reason: `smoke-test-vote: network/timeout — não foi possível confirmar que votos são aceitos pelo Worker`,
      action: `verifique conectividade com o Worker de poll (poll.diaria.workers.dev) e retente`,
    };
  }
  return {
    reason: `smoke-test-vote: erro de configuração (args/env — POLL_SECRET ausente?)`,
    action: `confira POLL_SECRET no .env e retente`,
  };
}

export type StepRunner = (spec: StepSpec) => number;

/**
 * Resolve BEEHIIV_PUBLICATION_ID do platform.config.json se ausente no env —
 * inject-poll-sig.ts precisa dele e ele NÃO mora no .env (§0d.ter exporta na mão).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.BEEHIIV_PUBLICATION_ID) {
    try {
      const cfgPath = resolve(ROOT, "platform.config.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const id = cfg?.beehiiv?.publicationId;
        if (id) env.BEEHIIV_PUBLICATION_ID = id;
      }
    } catch {
      // best-effort — inject-poll-sig é warn-only; smoke-test não depende disso.
    }
  }
  return env;
}

/** Runner real: roda cada script .ts via Node + tsx loader (cross-platform). */
const defaultRunner: StepRunner = (spec) => {
  try {
    execFileSync(process.execPath, ["--import", "tsx", spec.script, ...spec.args], {
      cwd: ROOT,
      stdio: "inherit",
      env: childEnv(),
    });
    return 0;
  } catch (e) {
    const status = (e as { status?: number | null }).status;
    return typeof status === "number" ? status : 1;
  }
};

/**
 * Roda os 3 passos em ordem (sem short-circuit nos best-effort — queremos que
 * o smoke-test rode SEMPRE) e devolve a decisão. `run` é injetável pra teste.
 */
export function runPreflight(
  edition: string,
  opts: { windowDays?: number; sinceHours?: number } = {},
  run: StepRunner = defaultRunner,
): { decision: PreflightDecision; outcomes: StepOutcome[] } {
  const specs = planSteps(edition, opts);
  const outcomes: StepOutcome[] = [];
  for (const spec of specs) {
    const exitCode = run(spec);
    outcomes.push({ name: spec.name, exitCode, blocking: spec.blocking });
  }
  return { decision: decide(edition, outcomes), outcomes };
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("Uso: preflight-poll-dispatch.ts --edition AAMMDD");
    process.exit(1);
  }

  console.error(
    `[preflight-poll-dispatch] ${edition}: maintain-valid-editions → inject-poll-sig → smoke-test-vote (gate duro)`,
  );
  const { decision, outcomes } = runPreflight(edition);
  console.log(JSON.stringify({ edition, outcomes, decision }, null, 2));

  if (decision.warnings.length) {
    console.error(
      `[preflight-poll-dispatch] WARN: passos best-effort falharam (${decision.warnings.join(", ")}) — ` +
        `smoke-test-vote é autoritativo e passou.`,
    );
  }

  if (decision.block) {
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/render-halt-banner.ts",
          "--stage",
          "4 — Publicação (pré-dispatch poll)",
          "--reason",
          decision.haltReason ?? "poll preflight falhou",
          "--action",
          decision.haltAction ?? "corrija e retente",
        ],
        { cwd: ROOT, stdio: "inherit" },
      );
    } catch {
      // banner é informativo; nunca mascarar o exit 1 do gate.
    }
    process.exit(1);
  }

  console.error(`[preflight-poll-dispatch] OK — poll pronto pro dispatch.`);
}

// CLI guard portável (Windows + Unix) — só roda main() em execução direta.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
