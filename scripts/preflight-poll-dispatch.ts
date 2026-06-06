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
 * loga warn e segue — o smoke-test é a fonte de verdade pro caso 410.
 *
 * Cobertura do 403 (poll_sig): o smoke-test vota como o EDITOR, cujo poll_sig é
 * permanente — então ele NÃO detecta novos subscribers sem poll_sig (causa do
 * 403). Por isso o output do inject-poll-sig é parseado: se `failed > 0` na
 * janela, emitimos um warning explícito de risco-403 (sem bloquear — §0d.ter
 * aceita que uma minoria de subs muito novos fique sem sig; bloquear 482 envios
 * por isso seria pior). Bloquear o 403 inteiro exigiria verificar o custom field
 * de um subscriber real — deferido pra #1803-followup.
 *
 * Uso:
 *   npx tsx scripts/preflight-poll-dispatch.ts --edition 260604
 *
 * Exit codes:
 *   0 — poll pronto pro dispatch (smoke-test passou)
 *   1 — args inválidos OU gate duro falhou (NÃO enviar a newsletter)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts"; // #1803 review: .env + .env.local (precedência)
import { renderHaltBanner } from "./lib/gate-banner.ts";
import { runTsx } from "./lib/run-tsx.ts"; // #1811
import { isValidEditionDir } from "./lib/edition-utils.ts"; // #1811: rejeita data inválida

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadProjectEnv(); // carrega .env/.env.local antes de qualquer leitura de process.env

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

export interface StepResult {
  exitCode: number;
  /** stdout capturado do child (pra parsear o JSON do inject-poll-sig). */
  stdout: string;
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
  // exit 1 = args/env do smoke-test; null/sinal (child morto) também cai aqui.
  return {
    reason: `smoke-test-vote: erro inesperado (config/env ausente — POLL_SECRET? — ou child interrompido). Ver stderr acima.`,
    action: `confira POLL_SECRET no .env e o log do smoke-test acima, depois retente`,
  };
}

/**
 * Detecta risco de 403 pra novos subscribers a partir do JSON do inject-poll-sig.
 * O inject sai com exit 0 mesmo com `failed > 0` (patch parcial) — então o sinal
 * só aparece no output. Retorna a contagem de patches que falharam, ou null.
 */
export function parseInjectFailed(stdout: string): { failed: number; inWindow: number } | null {
  try {
    const j = JSON.parse(stdout);
    const failed = typeof j.failed === "number" ? j.failed : 0;
    if (failed > 0) {
      return { failed, inWindow: typeof j.in_window === "number" ? j.in_window : 0 };
    }
  } catch {
    // output não-JSON (ex: child morreu antes de imprimir) → sem sinal confiável.
  }
  return null;
}

export type StepRunner = (spec: StepSpec) => StepResult;

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

/**
 * Runner real: roda cada script .ts via Node + tsx loader (cross-platform,
 * mesmo padrão de eia-compose.ts). stdout PIPED (capturado p/ parse + ecoado
 * pro stderr, mantendo o stdout do preflight limpo/parseável); stderr herdado
 * (logs do child aparecem ao vivo).
 */
const defaultRunner: StepRunner = (spec) => {
  try {
    // #1811: helper compartilhado (capture = pipa stdout pra parse).
    const stdout = runTsx(spec.script, spec.args, { cwd: ROOT, env: childEnv(), stdout: "capture" });
    if (stdout) process.stderr.write(stdout);
    return { exitCode: 0, stdout: stdout ?? "" };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string | Buffer };
    const stdout =
      typeof err.stdout === "string"
        ? err.stdout
        : err.stdout
          ? err.stdout.toString("utf8")
          : "";
    if (stdout) process.stderr.write(stdout);
    // status null (child morto por sinal) → trata como falha (1), conservador.
    return { exitCode: typeof err.status === "number" ? err.status : 1, stdout };
  }
};

export interface PreflightRun {
  decision: PreflightDecision;
  outcomes: StepOutcome[];
  /** risco de 403 detectado no inject (patch parcial) — null se ok. */
  pollSigRisk: { failed: number; inWindow: number } | null;
}

/**
 * Roda os 3 passos em ordem (sem short-circuit nos best-effort — queremos que
 * o smoke-test rode SEMPRE) e devolve a decisão. `run` é injetável pra teste.
 */
export function runPreflight(
  edition: string,
  opts: { windowDays?: number; sinceHours?: number } = {},
  run: StepRunner = defaultRunner,
): PreflightRun {
  const specs = planSteps(edition, opts);
  const outcomes: StepOutcome[] = [];
  let pollSigRisk: { failed: number; inWindow: number } | null = null;
  for (const spec of specs) {
    const { exitCode, stdout } = run(spec);
    outcomes.push({ name: spec.name, exitCode, blocking: spec.blocking });
    if (spec.name === "inject-poll-sig") {
      pollSigRisk = parseInjectFailed(stdout);
    }
  }
  return { decision: decide(edition, outcomes), outcomes, pollSigRisk };
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition || !isValidEditionDir(edition)) {
    console.error("Uso: preflight-poll-dispatch.ts --edition AAMMDD (data válida)");
    process.exit(1);
  }

  console.error(
    `[preflight-poll-dispatch] ${edition}: maintain-valid-editions → inject-poll-sig → smoke-test-vote (gate duro)`,
  );
  const { decision, outcomes, pollSigRisk } = runPreflight(edition);
  console.log(JSON.stringify({ edition, outcomes, decision, pollSigRisk }, null, 2));

  if (decision.warnings.length) {
    console.error(
      `[preflight-poll-dispatch] WARN: passos best-effort falharam (${decision.warnings.join(", ")}) — ` +
        `smoke-test-vote é autoritativo pro caso 410 e passou.`,
    );
  }
  if (pollSigRisk) {
    console.error(
      `[preflight-poll-dispatch] ⚠️ RISCO 403: inject-poll-sig falhou em ${pollSigRisk.failed} de ${pollSigRisk.inWindow} subscribers da janela — ` +
        `eles podem receber a newsletter com poll_sig vazio e levar 403 ao votar. ` +
        `Considere re-rodar 'npx tsx scripts/inject-poll-sig.ts --since-hours 96' antes de enviar.`,
    );
  }

  if (decision.block) {
    console.error(
      "\n" +
        renderHaltBanner({
          stage: "4 — Publicação (pré-dispatch poll)",
          reason: decision.haltReason ?? "poll preflight falhou",
          action: decision.haltAction ?? "corrija e retente",
        }),
    );
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
