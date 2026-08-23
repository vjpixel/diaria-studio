/**
 * weekly-linkedin-swap-checkpoint.ts (#5974)
 *
 * A troca automática de candidato do #5538 (manchete `kind === "section"`
 * com fonte inacessível troca sozinha, sem reabrir o gate do Passo 3) é
 * correta como princípio — mas até o #5974 o editor só descobria a troca
 * DEPOIS do artefato final publicado (aviso só no rodapé da entrega,
 * Passo 8). Este módulo é o checkpoint INFORMATIVO síncrono: dado o
 * `ln-selection.json` já processado por `verify-linkedin-weekly-sources.ts`
 * (Passo 4), decide se houve 1+ troca e renderiza um banner que o Passo 4
 * mostra ANTES do Passo 5 (Clarice/humanizador) e do Passo 7
 * (render/publicação) — não uma pergunta bloqueante (`AskUserQuestion`,
 * o #5538 continua automático), só um aviso que precisa ficar visível
 * antes do artefato existir, mesmo padrão do banner "Data não informada —
 * assumindo..." (CLAUDE.md, "Data da edição é sempre explícita").
 *
 * Puro — sem I/O. `scripts/render-linkedin-swap-checkpoint.ts` é o wrapper
 * de CLI que lê `ln-selection.json` do disco e imprime o banner.
 */
import { renderGateBanner } from "./gate-banner.ts";

export interface HeadlineSwapRecord5538 {
  originalTitle: string;
  originalEditionDate?: string;
  originalVerdict: string;
  replacementTitle: string;
  replacementEditionDate?: string;
  replacementKind?: string;
}

/**
 * True quando `selection.headlineSwaps5538` tem 1+ troca aplicada nesta
 * rodada de `verify-linkedin-weekly-sources.ts` — o único sinal que o
 * checkpoint precisa pra decidir se mostra o banner. Campo ausente (nenhuma
 * troca aconteceu, mesmo padrão de `selection.warnings` — só escrito quando
 * há algo a dizer) ou array vazio → sem checkpoint.
 */
export function hasHeadlineSwaps5538(selection: { headlineSwaps5538?: unknown }): boolean {
  return Array.isArray(selection.headlineSwaps5538) && selection.headlineSwaps5538.length > 0;
}

/**
 * Renderiza o banner de checkpoint — 1 linha por troca + o lembrete de que
 * é aviso, não pergunta. Puro (nenhum `console.log`/I/O aqui).
 */
export function renderSwapCheckpointBanner(swaps: HeadlineSwapRecord5538[]): string {
  const lines: string[] = swaps.map((s, i) => {
    const original = s.originalEditionDate ? `${s.originalTitle} (${s.originalEditionDate})` : s.originalTitle;
    const replacementDate = s.replacementEditionDate ? `, ${s.replacementEditionDate}` : "";
    const replacementKind = s.replacementKind ? `, ${s.replacementKind}` : "";
    return `${i + 1}. "${original}" [${s.originalVerdict}] → "${s.replacementTitle}"${replacementDate}${replacementKind}`;
  });
  lines.push("");
  lines.push("Troca automática do #5538 — decisão já tomada, sem reabrir o gate do Passo 3.");
  lines.push("Isto é um aviso, não uma pergunta: a skill segue para o Passo 5 em seguida.");

  return renderGateBanner(`🔄  MANCHETE(S) TROCADA(S) — #5538  (${swaps.length})  🔄`, lines, 70);
}
