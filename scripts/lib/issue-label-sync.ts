/**
 * issue-label-sync.ts (#10618, fatia 4)
 *
 * Quais labels de ISSUE o tooling das rodadas (`classifyExecTrack`,
 * `route-issue.ts`, a triagem, o gate de prioridade) precisa encontrar num
 * repo da allowlist `issue_repos`, e o plano para criar as que faltam.
 *
 * A lista NÃO é escrita à mão: sai das mesmas constantes que o roteador e o
 * classificador usam (`ROUTABLE_LABELS`, `MOTIVO_LABEL`, `TRACK_ADD_LABEL`,
 * `ENGAVETADAS_LABELS`, `BLOCKED_LABELS_SET`), mais prioridade (`P0`-`P3`,
 * regra "sempre indicar prioridade ao criar issues") e tipo (`bug`,
 * `enhancement`). Label nova numa dessas constantes entra aqui sozinha.
 *
 * Sem a label no repo, `gh issue edit --add-label` falha alto (nunca cria em
 * silêncio), então `route-issue.ts --issue vjpixel/diaria-design#N` não
 * consegue rotear lá. O CLI `scripts/sync-issue-labels.ts` cria as que faltam,
 * copiando cor e descrição do diaria-studio (a fonte de verdade visual).
 *
 * Pura — nenhum I/O.
 */

import { BLOCKED_LABELS_SET, ENGAVETADAS_LABELS } from "./issue-exec-track.ts";
import { MOTIVO_LABEL, ROUTABLE_LABELS, TRACK_ADD_LABEL } from "./issue-route.ts";

/** Prioridade (CLAUDE.md: toda issue nasce com 1 de `P0`..`P3`). */
export const PRIORITY_LABELS: readonly string[] = ["P0", "P1", "P2", "P3"];

/** Tipo de issue que o tooling lê (`--bugs`, onda 1a do develop). */
export const TYPE_LABELS: readonly string[] = ["bug", "enhancement"];

/** Pure: o conjunto de labels de issue que o tooling das rodadas usa, ordenado e sem repetição. */
export function requiredIssueLabels(): string[] {
  const all = new Set<string>([
    ...PRIORITY_LABELS,
    ...TYPE_LABELS,
    ...ROUTABLE_LABELS,
    ...Object.values(MOTIVO_LABEL),
    ...Object.values(TRACK_ADD_LABEL).filter((l): l is string => typeof l === "string"),
    ...ENGAVETADAS_LABELS,
    ...BLOCKED_LABELS_SET,
  ]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export interface LabelInfo {
  name: string;
  color?: string;
  description?: string;
}

export interface LabelToCreate {
  name: string;
  color: string;
  description: string;
  /** `true` quando cor/descrição vieram do repo de origem; `false` = default. */
  fromSource: boolean;
}

export interface LabelSyncPlan {
  /** Labels que faltam no repo-alvo, com cor/descrição a usar. */
  create: LabelToCreate[];
  /** Labels exigidas que o repo-alvo já tem (comparação sem diferenciar caixa, como o GitHub). */
  present: string[];
}

/** Cor neutra para label que nem o repo de origem tem. */
export const DEFAULT_LABEL_COLOR = "ededed";

/**
 * Pure: o que falta no repo-alvo. Idempotente — rodar de novo depois de
 * aplicar devolve `create: []`. O GitHub trata nome de label sem diferenciar
 * caixa, então `p2` existente cobre `P2`.
 */
export function planLabelSync(
  required: readonly string[],
  target: readonly LabelInfo[],
  source: readonly LabelInfo[],
): LabelSyncPlan {
  const targetNames = new Set(target.map((l) => l.name.toLowerCase()));
  const sourceByName = new Map(source.map((l) => [l.name.toLowerCase(), l]));
  const create: LabelToCreate[] = [];
  const present: string[] = [];
  for (const name of required) {
    if (targetNames.has(name.toLowerCase())) {
      present.push(name);
      continue;
    }
    const src = sourceByName.get(name.toLowerCase());
    const color = (src?.color ?? "").replace(/^#/, "");
    create.push({
      name,
      color: /^[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_LABEL_COLOR,
      description: src?.description ?? "",
      fromSource: src !== undefined,
    });
  }
  return { create, present };
}
