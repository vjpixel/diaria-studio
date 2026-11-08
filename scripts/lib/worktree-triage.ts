/**
 * scripts/lib/worktree-triage.ts (#12374)
 *
 * Lógica pura da triagem dos worktrees que `cleanup-merged-worktrees.ts`
 * PRESERVA por terem trabalho não commitado (#7304). Até o #12374 o cleanup
 * só preservava: na rodada overnight 261106b, 25 worktrees sujos (alguns com
 * semanas e ~4.500 arquivos sujos) seguraram o disk-guard e travaram 11
 * issues elegíveis, e o editor teria que inspecionar um a um.
 *
 * Esta lib responde, por worktree: idade (última atividade), arquivos sujos
 * (rastreados × untracked), commits não enviados, estado da PR da branch
 * (aberta/mergeada/fechada/nenhuma/indeterminado), lock e uso por sessão
 * viva — e decide se ele é DESCARTÁVEL com resgate (salvar o diff antes de
 * remover) ou se fica. O CLI que lê o estado real e aplica o descarte é
 * `scripts/triage-preserved-worktrees.ts`.
 *
 * **Regra de descarte (todas precisam valer):**
 *   - registro de sessões legível e nenhuma sessão viva usando o worktree;
 *   - sem lock, OU lock de processo confirmadamente morto E parado há mais de
 *     `LOCK_STALE_THRESHOLD_MS` (o caso dos 3 `claude agent` presos há 11 dias
 *     da issue). Pid vivo ou indeterminado = lock ativo, nunca sai;
 *   - branch nomeada com PR MERGEADA ou FECHADA e nenhuma PR aberta. "Sem PR"
 *     não é descartável (trabalho que nunca foi enviado), nem "indeterminado"
 *     (`gh` falhou);
 *   - última atividade conhecida e mais velha que o piso (`minIdleMs`).
 *
 * Fail-safe em toda leitura: dado ausente (`null`) sempre vira bloqueio,
 * nunca liberação.
 */

export type PrState = "open" | "merged" | "closed" | "none" | "unknown";

export interface PrSummary {
  number: number;
  state: string;
}

/** 7 dias: lock de processo morto mais novo que isso ainda conta como recente. */
export const LOCK_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** 3 dias: piso default de inatividade antes do descarte. */
export const DEFAULT_MIN_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Resume as PRs de uma branch (`gh pr list --head B --state all`). `null`
 * (consulta falhou) = `unknown`. Qualquer PR aberta vence: a branch tem
 * trabalho vivo mesmo que outra PR dela já tenha mergeado (#8792).
 */
export function summarizePrState(prs: PrSummary[] | null): { state: PrState; prNumbers: number[] } {
  if (prs === null) return { state: "unknown", prNumbers: [] };
  const prNumbers = prs.map((p) => p.number);
  const states = new Set(prs.map((p) => String(p.state).toUpperCase()));
  if (states.has("OPEN")) return { state: "open", prNumbers };
  if (states.has("MERGED")) return { state: "merged", prNumbers };
  if (states.has("CLOSED")) return { state: "closed", prNumbers };
  if (prs.length === 0) return { state: "none", prNumbers };
  return { state: "unknown", prNumbers };
}

/**
 * Lê as razões de lock de `git worktree list --porcelain`: path → razão
 * (`null` quando a linha é só `locked`). Worktree sem lock não aparece.
 */
export function parseLockReasons(porcelain: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length).trim().replace(/\\/g, "/");
    } else if (current !== null && (line === "locked" || line.startsWith("locked "))) {
      const reason = line === "locked" ? "" : line.slice("locked ".length).trim();
      out.set(current, reason === "" ? null : reason);
    }
  }
  return out;
}

/** Pid citado na razão do lock do harness (`claude agent X (pid 1234)`), ou `null`. */
export function parseLockPid(reason: string | null): number | null {
  if (!reason) return null;
  const m = /\bpid\s+(\d+)\b/i.exec(reason);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export interface DirtySummary {
  tracked: number;
  untracked: number;
  total: number;
}

/** Conta as linhas de `git status --porcelain` (v1): `??` = untracked, o resto = rastreado. */
export function summarizePorcelainStatus(output: string): DirtySummary {
  let tracked = 0;
  let untracked = 0;
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("??")) untracked++;
    else tracked++;
  }
  return { tracked, untracked, total: tracked + untracked };
}

export interface TriageFacts {
  path: string;
  name: string;
  branch: string | null;
  locked: boolean;
  lockReason: string | null;
  /** `true`/`false` quando o pid do lock foi conferido; `null` sem pid ou sem como conferir. */
  lockPidAlive: boolean | null;
  lastActivityMs: number | null;
  /** `null` quando o `git status` falhou. */
  dirty: DirtySummary | null;
  /** Commits do HEAD fora de qualquer ref remota; `null` quando não deu para contar. */
  unpushedCommits: number | null;
  pr: { state: PrState; prNumbers: number[] };
  inUse: boolean;
  registryReadable: boolean;
}

export interface TriageDecision {
  verdict: "descartavel" | "manter";
  /** Motivos que impedem o descarte (vazio quando descartável). */
  blockers: string[];
  /** Há algo a resgatar em patch (arquivo sujo ou commit não enviado). */
  salvageable: boolean;
  idleDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function classifyForDiscard(facts: TriageFacts, nowMs: number, minIdleMs: number = DEFAULT_MIN_IDLE_MS): TriageDecision {
  const blockers: string[] = [];
  const idleMs = facts.lastActivityMs === null ? null : nowMs - facts.lastActivityMs;
  const idleDays = idleMs === null ? null : Math.floor(idleMs / DAY_MS);

  if (!facts.registryReadable) blockers.push("registro de sessões ilegível");
  if (facts.inUse) blockers.push("em uso por sessão viva");

  if (facts.locked) {
    if (facts.lockPidAlive !== false) {
      blockers.push(facts.lockPidAlive === true ? "lock ativo (processo vivo)" : "lock sem processo verificável");
    } else if (idleMs === null || idleMs < LOCK_STALE_THRESHOLD_MS) {
      blockers.push("lock recente");
    }
  }

  if (facts.branch === null) {
    blockers.push("detached HEAD, sem branch para conferir PR");
  } else {
    switch (facts.pr.state) {
      case "open":
        blockers.push("branch com PR aberta");
        break;
      case "unknown":
        blockers.push("estado da PR indeterminado");
        break;
      case "none":
        blockers.push("branch sem PR (trabalho nunca enviado)");
        break;
      default:
        break;
    }
  }

  if (idleMs === null) blockers.push("idade indeterminada");
  else if (idleMs < minIdleMs) blockers.push(`parado há menos de ${Math.round(minIdleMs / DAY_MS)} dia(s)`);

  if (facts.dirty === null) blockers.push("git status falhou");
  if (facts.unpushedCommits === null) blockers.push("não deu para contar commits não enviados");

  const salvageable = (facts.dirty?.total ?? 0) > 0 || (facts.unpushedCommits ?? 0) > 0;
  return { verdict: blockers.length === 0 ? "descartavel" : "manter", blockers, salvageable, idleDays };
}

/** Nome de diretório seguro para o resgate: `{AAAA-MM-DD}/{nome-do-worktree}`. */
export function rescueSubdirFor(name: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_") || "worktree";
  return `${day}/${safe}`;
}

function prLabel(pr: TriageFacts["pr"]): string {
  const nums = pr.prNumbers.length > 0 ? ` (${pr.prNumbers.map((n) => `#${n}`).join(", ")})` : "";
  return `${pr.state}${nums}`;
}

/** Relatório em markdown, uma linha por worktree, descartáveis primeiro. */
export function renderTriageReport(rows: Array<{ facts: TriageFacts; decision: TriageDecision }>): string {
  const sorted = [...rows].sort((a, b) => {
    if (a.decision.verdict !== b.decision.verdict) return a.decision.verdict === "descartavel" ? -1 : 1;
    return (b.decision.idleDays ?? -1) - (a.decision.idleDays ?? -1);
  });
  const discardable = rows.filter((r) => r.decision.verdict === "descartavel").length;
  const lines = [
    `# Triagem de worktrees preservados (#12374)`,
    ``,
    `${rows.length} worktree(s) avaliado(s), ${discardable} descartável(is) com resgate.`,
    ``,
    `| worktree | branch | parado (dias) | sujos (rastr./untr.) | commits não enviados | PR | lock | veredito | motivo |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const { facts, decision } of sorted) {
    const dirty = facts.dirty === null ? "?" : `${facts.dirty.total} (${facts.dirty.tracked}/${facts.dirty.untracked})`;
    const lock = facts.locked ? (facts.lockReason ?? "sim") : "-";
    lines.push(
      `| ${facts.name} | ${facts.branch ?? "(detached)"} | ${decision.idleDays ?? "?"} | ${dirty} | ${facts.unpushedCommits ?? "?"} | ` +
        `${prLabel(facts.pr)} | ${lock.replace(/\|/g, "/")} | ${decision.verdict} | ${decision.blockers.join("; ") || "-"} |`,
    );
  }
  return lines.join("\n");
}
