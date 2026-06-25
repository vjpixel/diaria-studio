/**
 * preflight-poll-dispatch.ts (#1803, simplificado em #1186)
 *
 * Gate determinístico de poll que roda ANTES do envio da newsletter, em
 * QUALQUER entry path (incl. resume direto pro Stage 4 pós-compactação).
 *
 * Resolve o P1 #1803: num resume que entra pelo dispatch, os passos de
 * manutenção de poll do Stage 0 (§0d.bis maintain-valid-editions) não rodam,
 * e o "É IA?" quebra ao vivo (410 "não aceita mais votos") pra todos os
 * subscribers — silenciosamente. O smoke-test antigo (§4h-bis) só rodava
 * DEPOIS do envio, tarde demais.
 *
 * Desde #1186, a URL de voto usa modo merge-tag (sem sig) — `inject-poll-sig`
 * foi removido. O preflight agora roda apenas 2 passos:
 *   1. maintain-valid-editions-window --current {ed}  (garante ed no set; warn)
 *   2. smoke-test-vote --edition {ed}                 (HARD GATE — bloqueia envio)
 *
 * O primeiro é best-effort: se falhar (KV transiente), loga warn e segue —
 * o smoke-test é a fonte de verdade pro caso 410.
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
import { isWorkerReachable } from "./lib/worker-reachability.ts"; // #2551: DoH fallback p/ filtro DNS local

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadProjectEnv(); // carrega .env/.env.local antes de qualquer leitura de process.env

export type StepName =
  | "maintain-valid-editions"
  | "smoke-test-vote";

export interface StepSpec {
  name: StepName;
  script: string;
  args: string[];
  /** true = falha bloqueia o envio; false = best-effort (warn-only). */
  blocking: boolean;
}

/**
 * Ordem fixa: FIX idempotente (maintain, warn-only) → VERIFY (smoke,
 * gate duro). Pura — sem efeitos colaterais, testável.
 *
 * #1186: inject-poll-sig removido — URL de voto usa modo merge-tag (sem sig).
 */
export function planSteps(
  edition: string,
  opts: { windowDays?: number } = {},
): StepSpec[] {
  const windowDays = opts.windowDays ?? 7;
  return [
    {
      name: "maintain-valid-editions",
      script: "scripts/maintain-valid-editions-window.ts",
      args: ["--current", edition, "--window-days", String(windowDays)],
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

/**
 * Mensagem de halt por exit code do smoke-test-vote.
 * exit 2 = Worker rejeitou (410 = edição fora de valid_editions, ou outro HTTP error)
 * exit 3 = network/timeout
 * exit 1 = args inválidos ou child interrompido por sinal
 */
function haltFor(edition: string, exitCode: number): { reason: string; action: string } {
  if (exitCode === 2) {
    return {
      reason: `smoke-test-vote falhou — Worker rejeitou o voto de teste (edição ${edition} possivelmente fora de valid_editions)`,
      action: `rode 'npx tsx scripts/add-valid-edition.ts --edition ${edition}', depois retente`,
    };
  }
  if (exitCode === 3) {
    return {
      reason: `smoke-test-vote: network/timeout — não foi possível confirmar que votos são aceitos pelo Worker`,
      action: `verifique conectividade com o Worker de poll (poll.diaria.workers.dev) e retente`,
    };
  }
  // exit 1 = args inválidos ou child morto por sinal.
  return {
    reason: `smoke-test-vote: erro inesperado (args inválidos ou child interrompido). Ver stderr acima.`,
    action: `verifique o log do smoke-test acima e retente`,
  };
}

export type StepRunner = (spec: StepSpec) => StepResult;

/**
 * Resolve BEEHIIV_PUBLICATION_ID do platform.config.json se ausente no env —
 * alguns scripts de preflight precisam dele e ele pode não estar no .env.
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
    return { exitCode: 0 };
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
    return { exitCode: typeof err.status === "number" ? err.status : 1 };
  }
};

export interface PreflightRun {
  decision: PreflightDecision;
  outcomes: StepOutcome[];
}

/**
 * Roda os 2 passos em ordem (sem short-circuit no best-effort — queremos que
 * o smoke-test rode SEMPRE) e devolve a decisão. `run` é injetável pra teste.
 *
 * #1186: inject-poll-sig removido — URL de voto usa modo merge-tag (sem sig).
 */
export function runPreflight(
  edition: string,
  opts: { windowDays?: number } = {},
  run: StepRunner = defaultRunner,
): PreflightRun {
  const specs = planSteps(edition, opts);
  const outcomes: StepOutcome[] = [];
  for (const spec of specs) {
    const { exitCode } = run(spec);
    outcomes.push({ name: spec.name, exitCode, blocking: spec.blocking });
  }
  return { decision: decide(edition, outcomes), outcomes };
}

async function main(): Promise<void> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition || !isValidEditionDir(edition)) {
    console.error("Uso: preflight-poll-dispatch.ts --edition AAMMDD (data válida)");
    process.exit(1);
  }

  console.error(
    `[preflight-poll-dispatch] ${edition}: maintain-valid-editions → smoke-test-vote (gate duro)`,
  );

  // #2551: pre-check de reachability com DoH fallback — antes de correr os
  // child scripts, detecta se DNS local está filtrando poll.diaria.workers.dev.
  const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";
  const reach = await isWorkerReachable(`${POLL_WORKER_URL}/health`);
  if (!reach.up) {
    if (reach.local_dns_filtered) {
      console.error(
        `[preflight-poll-dispatch] ⚠️  DNS local filtrando ${new URL(POLL_WORKER_URL).hostname} ` +
          `— DoH resolve mas anycast não respondeu. Worker pode estar realmente down ou sem rota anycast. ` +
          `Detalhes: ${reach.error ?? "(sem detalhe)"}`,
      );
    } else {
      console.error(
        `[preflight-poll-dispatch] ⚠️  Worker inacessível (DNS + DoH ambos falharam). ` +
          `Detalhes: ${reach.error ?? "(sem detalhe)"}`,
      );
    }
    console.error(
      `[preflight-poll-dispatch] Continuando smoke-test (resultado autoritativo para gate duro)...`,
    );
  } else if (reach.local_dns_filtered) {
    console.error(
      `[preflight-poll-dispatch] ℹ️  DNS local filtra ${new URL(POLL_WORKER_URL).hostname} ` +
        `mas Worker responde via DoH/anycast (up=${reach.up}, via=${reach.via}).`,
    );
  }

  const { decision, outcomes } = runPreflight(edition);
  console.log(JSON.stringify({ edition, outcomes, decision }, null, 2));

  if (decision.warnings.length) {
    console.error(
      `[preflight-poll-dispatch] WARN: passos best-effort falharam (${decision.warnings.join(", ")}) — ` +
        `smoke-test-vote é autoritativo pro caso 410 e passou.`,
    );
  }

  if (decision.block) {
    console.error(
      "\n" +
        renderHaltBanner({
          stage: "5 — Publicação (pré-dispatch poll)",
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
  main().catch((e) => {
    console.error(`[preflight-poll-dispatch] unexpected error: ${(e as Error).message}`);
    process.exit(1);
  });
}
