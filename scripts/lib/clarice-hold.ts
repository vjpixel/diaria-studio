/**
 * clarice-hold.ts (#4542)
 *
 * RESERVA de segmento: exclui de uma seleção de envio os contatos que o editor
 * está segurando para uma campanha própria (hoje: o cohort jurídico, retido
 * para uma edição especial).
 *
 * Por que existe: a retenção era só editorial — não havia NENHUMA trava no
 * pipeline. `grep juridico scripts/clarice-build-*.ts` não achava nada, e
 * `COHORT_JURIDICO` é virtual por design (só a agregação da aba Cohorts;
 * nunca escrito na coluna `cohort`), então o contato jurídico carrega a safra
 * real de cadastro e é indistinguível dos demais para a fila de envio.
 *
 * O risco era concreto, não teórico (medido em 260803): dos 124 elegíveis de
 * re-envio engajado que ainda não tinham recebido o ciclo 2607-08, **117 eram
 * jurídico**, com `priority_points` de até 370 — e `segmentEngajados` ordena
 * por `priority_points` DESC com os engajados na frente da fila. A próxima
 * build normal mandaria para eles PRIMEIRO. No 2607-08 eles escaparam só
 * porque as ondas pararam em `leads-2024h2` e nunca alcançaram as safras
 * 2023/2024h1 onde a maioria mora — sorte de ordenação, não proteção.
 *
 * Decisão de escopo: a reserva é OPT-IN por invocação (`--hold juridico`), não
 * um filtro permanente. Um segmento retido hoje é o público-alvo da campanha
 * de amanhã — embutir a exclusão no predicado do grupo tornaria o próprio
 * envio especial impossível de montar com as mesmas ferramentas.
 */

import { isJuridicoEmail } from "./clarice-sector.ts";

/**
 * Registro dos segmentos que podem ser retidos. Chave = valor aceito em
 * `--hold`; valor = predicado sobre o e-mail.
 *
 * Deliberadamente um registro (não um `if (hold === "juridico")` no call site):
 * o próximo segmento a ganhar reserva — setor, faixa de apoio, safra — entra
 * aqui sem tocar em `clarice-build-segment.ts`.
 *
 * NÃO exportado de propósito (review do PR #4564): exportar o registro deixa
 * qualquer caller fazer `HOLD_SEGMENTS[input]?.(email)` e pular a validação e a
 * mensagem de erro de `parseHoldArg`. A superfície pública é o tipo
 * `HoldSegmentName` + `holdSegmentNames()` + `parseHoldArg`/`applyHolds`.
 *
 * `satisfies` em vez de anotar `Record<string, …>`: a anotação alargava as
 * chaves pra `string`, e era por isso que `parseHoldArg` validava o nome e
 * depois jogava a validação fora ao devolver `string[]`.
 */
const HOLD_SEGMENTS = {
  juridico: isJuridicoEmail,
} satisfies Record<string, (email: string) => boolean>;

/** Nome de segmento JÁ VALIDADO — cresce sozinho quando `HOLD_SEGMENTS` cresce. */
export type HoldSegmentName = keyof typeof HOLD_SEGMENTS;

/** Nomes válidos de segmento retido, para mensagem de erro e docs. */
export function holdSegmentNames(): HoldSegmentName[] {
  return Object.keys(HOLD_SEGMENTS) as HoldSegmentName[];
}

/**
 * Parseia o valor de `--hold` (aceita lista separada por vírgula).
 *
 * Nome desconhecido LANÇA em vez de ser ignorado: um `--hold jurídico` (com
 * acento) ou `--hold legal` silenciosamente sem efeito manda justamente o
 * segmento que o operador pediu para segurar — falha exatamente no caso que a
 * flag existe para evitar.
 */
export function parseHoldArg(raw: string | null | undefined): HoldSegmentName[] {
  // `undefined`/`null` = flag genuinamente ausente (getStringArg ja lanca em
  // "presente mas sem valor"). String vazia nunca deveria chegar aqui; se
  // chegar, e erro do caller, nao "nao pediu reserva" -- lanca.
  if (raw === null || raw === undefined) return [];
  if (raw.trim() === "") {
    throw new Error("--hold recebeu valor vazio -- omita a flag pra nao reservar nada.");
  }
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  const unknown = names.filter((n) => !(n in HOLD_SEGMENTS));
  if (unknown.length > 0) {
    throw new Error(
      `--hold desconhecido: ${unknown.join(", ")}. Válidos: ${holdSegmentNames().join(", ")}.`,
    );
  }
  // Dedup preservando ordem — `--hold juridico,juridico` não deve contar 2×.
  return [...new Set(names)] as HoldSegmentName[];
}

export interface HoldResult<T> {
  /** Linhas que seguem para a seleção. */
  kept: T[];
  /** Quantos foram retidos por segmento (só segmentos com contagem > 0). */
  heldBySegment: Record<string, number>;
  /** Total retido (um contato que casa 2 segmentos conta 1× aqui). */
  heldTotal: number;
}

/**
 * Remove das linhas os contatos que casam com qualquer um dos segmentos
 * retidos. Aplicar ANTES do corte de budget — segurar depois encolheria a
 * onda abaixo do volume pedido em vez de puxar os próximos da fila.
 *
 * `heldBySegment` conta por segmento (um contato pode casar mais de um);
 * `heldTotal` conta contatos distintos. Os dois são reportados porque a soma
 * dos segmentos não fecha com o total quando há sobreposição, e um operador
 * que visse só a soma concluiria que a conta está errada.
 */
export function applyHolds<T extends { email: string }>(
  rows: T[],
  holds: HoldSegmentName[],
): HoldResult<T> {
  if (holds.length === 0) {
    return { kept: rows, heldBySegment: {}, heldTotal: 0 };
  }
  const kept: T[] = [];
  const heldBySegment: Record<string, number> = {};
  let heldTotal = 0;
  for (const row of rows) {
    let held = false;
    for (const name of holds) {
      if (HOLD_SEGMENTS[name](row.email)) {
        heldBySegment[name] = (heldBySegment[name] ?? 0) + 1;
        held = true;
      }
    }
    if (held) heldTotal++;
    else kept.push(row);
  }
  return { kept, heldBySegment, heldTotal };
}
