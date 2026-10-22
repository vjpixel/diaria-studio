/**
 * #9463 — issue `pulada` por `requer-sessao-local` ou `guard-de-execucao`
 * (guard de arquivo sensível, etc.) precisa estar roteada pra trilha Develop
 * (label `develop-track` ou `windows`), senão `classifyExecTrack` continua
 * a mostrando como Overnight e a rodada seguinte a pega de novo.
 */
import { classifyExecTrack } from "./issue-exec-track.ts";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import {
  compareIssueKeys,
  issueKeyOfPlanEntry,
  requireStudioIssueNumber,
  studioNumberOfIssueKey,
  type IssueKey,
} from "./issue-key.ts";

export interface SkippedPlanIssue {
  number?: number;
  status?: unknown;
  motivo?: unknown;
  [key: string]: unknown;
}

/** Motivos (prefixo, antes de `:`) que exigem roteamento pra Develop. */
export const DEVELOP_ROUTED_MOTIVOS = ["requer-sessao-local", "guard-de-execucao"] as const;

export function requiresDevelopRouting(issue: SkippedPlanIssue): boolean {
  if (issue?.status !== "pulada" || typeof issue.motivo !== "string") return false;
  const head = issue.motivo.split(":")[0].trim();
  return (DEVELOP_ROUTED_MOTIVOS as readonly string[]).includes(head);
}

export interface IssueSnapshot {
  labels: string[];
  body: string;
  /** `state` cru do `gh api` (`open`/`closed`) — opcional (#9516). */
  state?: string | null;
}

/** Pure: devolve os números de issues puladas por guard/sessão-local cujo
 * track classificado continua `overnight` (seria repescada na próxima rodada).
 * Track `bloqueada`/`agendada`/`fora-de-rodada` (inclui issue fechada) NÃO é
 * acusada — a correção sugerida (`route-issue --track develop`) apagaria um
 * bloqueio legítimo (#9516). Issue sem snapshot é ignorada (fail-soft). */
export function findUnroutedSkips(
  issues: SkippedPlanIssue[],
  snapshots: ReadonlyMap<number, IssueSnapshot>,
): number[] {
  const out: number[] = [];
  for (const issue of issues) {
    if (!requiresDevelopRouting(issue) || typeof issue.number !== "number") continue;
    // #10618 (fatia 3): `snapshots` é do diaria-studio (chave = número). A
    // entrada de outro repo tem `number` preenchido pela chave
    // `owner/repo#N` (normalizeIssues) e casaria com a studio#N — fica de
    // fora; o caminho multi-repo é `findUnroutedSkipKeys`.
    const key = issueKeyOfPlanEntry(issue);
    if (!key || studioNumberOfIssueKey(key) === null) continue;
    const snap = snapshots.get(issue.number);
    if (!snap) continue;
    const track = classifyExecTrack({
      labels: snap.labels,
      body: snap.body,
      state: snap.state ? snap.state.toUpperCase() : undefined,
    });
    if (track === "overnight") out.push(issue.number);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Números do diaria-studio das entradas que exigem roteamento — API legada,
 * só-studio. **#10618 (fatia 3): lança `ForeignIssueNumberError`** quando uma
 * dessas entradas é de outro repo (ou de identidade desconhecida): devolver o
 * `number` dela faria o chamador consultar a studio#N com o número da
 * design#N. Plano multi-repo usa `planIssueKeysRequiringRouting`. Entrada sem
 * número nem `ref` segue ignorada, como sempre.
 */
export function planIssuesRequiringRouting(plan: IssuesBearing<SkippedPlanIssue>): number[] {
  return normalizeIssues(plan)
    .filter(requiresDevelopRouting)
    .filter((i) => Number.isInteger(i.number) || typeof (i as { ref?: unknown }).ref === "string")
    .map((i) => requireStudioIssueNumber(i, "planIssuesRequiringRouting"));
}

/**
 * #10618 (fatia 3) — como `findUnroutedSkips`, mas por `IssueKey`: cada
 * issue é cruzada com o snapshot do repo DELA (`snapshots` chaveado por
 * `owner/repo#N`), então a design#21 nunca é julgada pelo estado da
 * studio#21. Entrada de identidade desconhecida é ignorada (o CLI a conta
 * como não verificada).
 */
export function findUnroutedSkipKeys(
  issues: SkippedPlanIssue[],
  snapshots: ReadonlyMap<IssueKey, IssueSnapshot>,
): IssueKey[] {
  const out = new Set<IssueKey>();
  for (const issue of issues) {
    if (!requiresDevelopRouting(issue)) continue;
    const key = issueKeyOfPlanEntry(issue);
    if (!key) continue;
    const snap = snapshots.get(key);
    if (!snap) continue;
    const track = classifyExecTrack({
      labels: snap.labels,
      body: snap.body,
      state: snap.state ? snap.state.toUpperCase() : undefined,
    });
    if (track === "overnight") out.add(key);
  }
  return [...out].sort(compareIssueKeys);
}

/** #10618 (fatia 3) — entradas que exigem roteamento, como `IssueKey` (todos
 * os repos), e quantas têm identidade desconhecida (não verificáveis). */
export function planIssueKeysRequiringRouting(plan: IssuesBearing<SkippedPlanIssue>): {
  keys: IssueKey[];
  unknownIdentity: number;
} {
  const keys = new Set<IssueKey>();
  let unknownIdentity = 0;
  for (const issue of normalizeIssues(plan).filter(requiresDevelopRouting)) {
    const key = issueKeyOfPlanEntry(issue);
    if (key) keys.add(key);
    else unknownIdentity++;
  }
  return { keys: [...keys].sort(compareIssueKeys), unknownIdentity };
}
