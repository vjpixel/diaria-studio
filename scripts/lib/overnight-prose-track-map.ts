/**
 * scripts/lib/overnight-prose-track-map.ts (#6204 item 3)
 *
 * Tabela de correspondência entre os DOIS vocabulários que classificam
 * "qual sessão trabalha esta issue" — o esquema em prosa do passo 4 de
 * `.claude/skills/diaria-overnight/SKILL.md` (e o checklist a/b/c da
 * `.claude/skills/diaria-continuo/SKILL.md`, que reusa a mesma taxonomia) e
 * os 6 valores de `ExecTrack` (`scripts/lib/issue-exec-track.ts`).
 *
 * Os dois vocabulários NÃO são o mesmo conjunto — nasceram em momentos
 * diferentes, resolvendo problemas parecidos sem se conferir (#6204). Isto
 * não reimplementa `classifyExecTrack`: é só a tabela de tradução, pra que
 * "Fase 0 roda `classifyExecTrack` e reporta divergência com a prosa"
 * (passo 4a do overnight, espelhando o 6a do develop, #5708) tenha uma
 * fonte única de qual `ExecTrack` CADA status em prosa deveria produzir —
 * em vez de o julgamento "isso bate ou não bate" ser refeito ad-hoc a cada
 * rodada.
 *
 * ## Por que a correspondência não é 1:1
 *
 * `OvernightProseStatus` tem 7 valores; `ExecTrack` tem 6. Dois motivos:
 *
 *   1. `precisa-resposta` é EFÊMERO — resolvido no próprio briefing da
 *      Fase 0 (passo 5) antes de a rodada seguir. Uma issue nesse estado
 *      nunca fica classificada `precisa-resposta` no `plan.json` final: ou
 *      vira `elegivel` (editor respondeu) ou `pulada` ("decido depois",
 *      sem `ExecTrack` correspondente — a issue simplesmente não avançou
 *      nesta rodada). Por isso `PROSE_TO_TRACK["precisa-resposta"]` é
 *      `null` — não existe UM `ExecTrack` que ele sempre resolva para.
 *   2. `not-this-week` (5º bullet do passo 4) mapeia para **dois** tracks
 *      dependendo se a rodada sabe uma data (`agendada`, via
 *      `route-issue --track agendada --until`) ou não (`bloqueada`, via
 *      `route-issue --track bloqueada`) — a mesma ambiguidade que o
 *      `DEFERRED_LABELS` de `issue-exec-track.ts` resolve por precedência
 *      (marcador `aguardando-ate:` futuro vence sobre o label vago).
 *
 * Cada entrada carrega `tracks: ExecTrack[]` (nunca vazio exceto
 * `precisa-resposta`) — a checagem de divergência aceita QUALQUER um dos
 * tracks listados como não-divergente.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md Fase 0 passo 4 (a fonte da
 *      taxonomia em prosa) e passo 4a (onde esta tabela é consultada).
 * @see .claude/skills/diaria-continuo/SKILL.md passo 3 (mesma taxonomia,
 *      reusada pelo checklist a/b/c do backlog bloqueado).
 * @see scripts/lib/issue-exec-track.ts (`ExecTrack`, `classifyExecTrack`).
 * @see test/overnight-prose-track-map.test.ts (trava a tabela).
 */

import type { ExecTrack } from "./issue-exec-track.ts";

/**
 * Os 7 desfechos de classificação em prosa do passo 4 do overnight (e do
 * checklist a/b/c do continuo, que os reusa). Literal, não derivado — é a
 * mesma lista citada pela issue #6204 mais `sem-direcao-acionavel`
 * (#5968) e `ambigua-trade-off-real` (cat. C, #2640), que a issue original
 * omitiu mas que já são status vivos na SKILL hoje.
 */
export type OvernightProseStatus =
  | "elegivel"
  | "precisa-resposta"
  | "bloqueada-externa"
  | "requer-sessao-local"
  | "not-this-week"
  | "sem-direcao-acionavel"
  | "ambigua-trade-off-real";

export interface ProseTrackMapping {
  readonly status: OvernightProseStatus;
  /** `ExecTrack`(s) que este status em prosa deveria produzir quando
   * traduzido por `classifyExecTrack` sobre o estado final (labels/corpo)
   * da issue. Array com >1 elemento = ambiguidade genuína documentada (ver
   * docstring do módulo); nunca vazio, exceto `precisa-resposta`. */
  readonly tracks: readonly ExecTrack[];
  /** Explicação curta do porquê — citada em mensagens de divergência. */
  readonly note: string;
}

export const OVERNIGHT_PROSE_TRACK_MAP: readonly ProseTrackMapping[] = [
  {
    status: "elegivel",
    tracks: ["overnight"],
    note: "direção clara, sem label de bloqueio nem marcador de data — default residual de classifyExecTrack.",
  },
  {
    status: "precisa-resposta",
    tracks: [],
    note: "efêmero — resolvido no briefing (Fase 0 passo 5) antes de persistir; sem ExecTrack correspondente por construção.",
  },
  {
    status: "bloqueada-externa",
    tracks: ["bloqueada"],
    note: "route-issue --track bloqueada aplica external-blocker (ou motivo mais específico) — BLOCKED_LABELS.",
  },
  {
    status: "requer-sessao-local",
    tracks: ["develop"],
    note: "label windows (Chrome logado/ComfyUI) — MACHINE_DEVELOP_LABELS classifica develop.",
  },
  {
    status: "not-this-week",
    tracks: ["agendada", "bloqueada"],
    note: "route-issue --track agendada --until (data conhecida) OU --track bloqueada (deferimento vago, DEFERRED_LABELS) — os dois caminhos coexistem no mesmo bullet do passo 4.",
  },
  {
    status: "sem-direcao-acionavel",
    tracks: ["fora-de-rodada"],
    note: "label sem-direcao-acionavel (#5968) — RESOLVED_BY_PROSE_LABELS classifica fora-de-rodada.",
  },
  {
    status: "ambigua-trade-off-real",
    tracks: ["develop"],
    note: "label trade-off-real — cat. C do develop (#2640), TRADE_OFF_LABEL classifica develop.",
  },
];

const MAP_BY_STATUS: ReadonlyMap<OvernightProseStatus, ProseTrackMapping> = new Map(
  OVERNIGHT_PROSE_TRACK_MAP.map((m) => [m.status, m]),
);

/** `ExecTrack`(s) esperados para um status em prosa — lança se o status não
 * for reconhecido (typo em chamador é bug, não deve degradar em silêncio). */
export function expectedTracksForProseStatus(status: OvernightProseStatus): readonly ExecTrack[] {
  const entry = MAP_BY_STATUS.get(status);
  if (!entry) {
    throw new Error(`overnight-prose-track-map: status em prosa desconhecido: "${status}"`);
  }
  return entry.tracks;
}

/**
 * `true` se `track` (o veredito de `classifyExecTrack`) é compatível com o
 * status em prosa que a rodada atribuiu à mesma issue. `precisa-resposta`
 * nunca é comparável (sempre `false`, `tracks` vazio por construção) — o
 * chamador não deveria invocar isto pra uma issue ainda `precisa-resposta`
 * no momento da checagem (ela é resolvida no briefing antes de persistir).
 */
export function isProseTrackConsistent(status: OvernightProseStatus, track: ExecTrack): boolean {
  return expectedTracksForProseStatus(status).includes(track);
}
