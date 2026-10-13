/**
 * clarice-toggle-audit.ts (#10105)
 *
 * Rastro de quem/onde/por que um kill switch da Clarice mudou —
 * `data/clarice-envio-enabled.json` (rampa) e `data/clarice-novos-enabled.json`
 * (cadastros novos).
 *
 * Incidente que motivou: em 01/10/2026 o toggle da rampa foi reescrito pra
 * `enabled: true` contra uma decisão registrada do editor (pausa até 07/10,
 * #8099), e o arquivo só guardava `{enabled, updatedAt}` — nenhuma máquina,
 * sessão ou motivo, nada em `run-log.jsonl`. A rampa enviou ~12 dias sem
 * ninguém ver de onde veio a reativação.
 *
 * Três peças, todas usadas pelos dois módulos de toggle:
 *   - `resolveToggleAudit` — `machine` (hostname), `sessionId`
 *     (`CLAUDE_CODE_SESSION_ID`, quando a escrita parte de uma sessão do
 *     Claude Code) e `reason` (texto livre);
 *   - `logToggleChange` — evento em `data/run-log.jsonl` (fail-soft, mesma
 *     disciplina de `logEvent`: logging nunca derruba a escrita do toggle);
 *   - `parseToggleCli` — `--set enabled|disabled` passa a EXIGIR `--reason`.
 *     Sem motivo o CLI recusa a escrita (exit 2): uma troca de kill switch de
 *     envio real sem motivo declarado é exatamente o que o incidente mostrou
 *     ser impossível de auditar depois.
 */

import { getMachineId } from "./machine-id.ts";
import { logEvent, type RunLogEvent } from "./run-log.ts";
import { parseArgs } from "./cli-args.ts";

export type ClariceToggleName = "clarice-envio-enabled" | "clarice-novos-enabled";

export interface ToggleAudit {
  /** Hostname da máquina que escreveu. `null` quando ilegível. */
  machine: string | null;
  /** `CLAUDE_CODE_SESSION_ID` da sessão que escreveu; `null` fora do Claude Code (terminal, systemd). */
  sessionId: string | null;
  /** Motivo declarado. `null` só em escrita programática sem motivo (o CLI exige). */
  reason: string | null;
}

export interface ResolveToggleAuditOptions {
  reason?: string | null;
  machine?: string | null;
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function resolveToggleAudit(opts: ResolveToggleAuditOptions = {}): ToggleAudit {
  const env = opts.env ?? process.env;
  return {
    machine: opts.machine !== undefined ? nonEmpty(opts.machine) : nonEmpty(getMachineId()),
    sessionId: opts.sessionId !== undefined ? nonEmpty(opts.sessionId) : nonEmpty(env.CLAUDE_CODE_SESSION_ID),
    reason: nonEmpty(opts.reason),
  };
}

/** Lê os 3 campos de proveniência de um objeto já parseado do arquivo do
 * toggle. Campo ausente/de tipo errado simplesmente não aparece — arquivo
 * escrito antes do #10105 continua válido. `null` gravado (ex.: sessão
 * ausente) é preservado como `null`. */
export function readToggleAudit(raw: Record<string, unknown>): Partial<ToggleAudit> {
  const out: Partial<ToggleAudit> = {};
  for (const k of ["machine", "sessionId", "reason"] as const) {
    const v = raw[k];
    if (typeof v === "string" || v === null) out[k] = v;
  }
  return out;
}

/** Evento estruturado da troca, pronto pra `logEvent`. Puro — exposto pra teste. */
export function buildToggleChangeEvent(
  toggle: ClariceToggleName,
  state: { enabled: boolean; updatedAt: string | null } & ToggleAudit,
): RunLogEvent {
  return {
    edition: null,
    stage: null,
    agent: toggle,
    // Religar envio real é o lado que o incidente do #10105 mostrou ser
    // perigoso sem rastro — `warn` pra aparecer em `/diaria-log ... warn`.
    level: state.enabled ? "warn" : "info",
    message:
      `${toggle} → ${state.enabled ? "enabled" : "disabled"}` +
      ` (máquina: ${state.machine ?? "desconhecida"}, sessão: ${state.sessionId ?? "nenhuma"}, motivo: ${state.reason ?? "não informado"})`,
    details: {
      toggle,
      enabled: state.enabled,
      updatedAt: state.updatedAt,
      machine: state.machine,
      sessionId: state.sessionId,
      reason: state.reason,
    },
  };
}

/** Grava o evento em `run-log.jsonl` sob `rootDir`. Fail-soft (devolve `false`, nunca lança). */
export function logToggleChange(
  rootDir: string,
  toggle: ClariceToggleName,
  state: { enabled: boolean; updatedAt: string | null } & ToggleAudit,
  logFn: (e: RunLogEvent, root: string) => boolean = (e, root) => logEvent(e, root),
): boolean {
  try {
    return logFn(buildToggleChangeEvent(toggle, state), rootDir);
  } catch {
    return false;
  }
}

export type ToggleCliCommand =
  | { kind: "read" }
  | { kind: "set"; enabled: boolean; reason: string }
  | { kind: "error"; message: string };

/**
 * `[]` → leitura; `--set enabled|disabled --reason "..."` → escrita.
 * `--set` sem `--reason` (ou com motivo vazio) e `--set` com valor inválido
 * viram `error` — o CLI imprime a mensagem e sai com exit 2, sem escrever.
 */
export function parseToggleCli(argv: string[], toggle: ClariceToggleName): ToggleCliCommand {
  const { values, flags } = parseArgs(argv);
  if (!("set" in values) && !flags.has("set")) return { kind: "read" };
  const set = values.set;
  if (set !== "enabled" && set !== "disabled") {
    return { kind: "error", message: `[${toggle}] --set aceita só "enabled" ou "disabled" (recebido: ${JSON.stringify(set ?? "")}).` };
  }
  const reason = nonEmpty(values.reason);
  if (!reason) {
    return {
      kind: "error",
      message:
        `[${toggle}] --set ${set} exige --reason "..." (#10105) — toda troca deste kill switch grava ` +
        `máquina, sessão e motivo, e a reativação de 01/10/2026 sem rastro é o motivo da exigência. ` +
        `Ex.: --set ${set} --reason "decisão do editor em #NNNN"`,
    };
  }
  return { kind: "set", enabled: set === "enabled", reason };
}
