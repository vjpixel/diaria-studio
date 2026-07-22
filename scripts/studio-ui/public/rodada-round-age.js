// rodada-round-age.js (#3889) — lógica PURA de idade/staleness pro
// acompanhamento de rodada (rodada.js): idade de uma unidade "em andamento"
// na timeline + decisão do badge de "possível stall" no rótulo geral
// "atualizado". Mesmo padrão de edicao-stage-age.js (#3871): nenhuma chamada
// a document/fetch aqui — testável com fixtures puras via node:test, sem
// harness de DOM.
//
// Motivação (#3889, auditoria #3866): `rodada.js` tinha 3 problemas de
// observabilidade — (1) o rótulo "atualizado" usava `new Date()` do CLIENTE
// (avançava a cada fetch, mesmo com o plan.json parado de escrever — a
// rodada podia estar travada há horas e a tela continuava dizendo
// "atualizado agora"); (2) a linha da timeline cuja unidade está "em
// andamento" não tinha NENHUM destaque visual nem indicação de há quanto
// tempo está nesse estado — impossível distinguir progredindo de travada só
// olhando a tela; (3) o EventSource de SSE não tinha indicador de conexão —
// uma queda congelava a timeline sem aviso (item 3 é tratado só em
// rodada.js/rodada.html, não tem lógica pura própria).
//
// Este módulo resolve (1) e (2), reusando `computeStageAge` (o MESMO motor
// de cálculo de idade/staleness/limiar do cockpit, #3871) em vez de
// reimplementar essa lógica. `computeStageAge(stage, logBuffer, now)` foi
// escrito pra filtrar um `logBuffer` de eventos de run-log por `stage` —
// aqui não há um logBuffer real por unidade/rodada, então sintetizamos um
// array de exatamente 1 evento por chamada (a `stage` só precisa ser uma
// chave estável entre os dois argumentos daquela chamada, sem outro papel
// semântico) pra reusar a MESMA formatação/limiar sem duplicá-la.

import { computeStageAge } from "./edicao-stage-age.js";

/**
 * Idade de uma unidade de timeline "em andamento", a partir do
 * `ultimoEventoISO` já computado no servidor
 * (`render-overnight-timeline.ts::getLastEventISO`, #3889 — o timestamp MAIS
 * RECENTE entre dispatch/pr_opened/fix_iteration_N/ci_green da unidade, não
 * só `dispatch`: uma unidade que já avançou via pr_opened/fix_iteration_N
 * depois do dispatch original teria a idade SUPERESTIMADA se usássemos só
 * dispatch, gerando falso alarme de stall).
 *
 * Retorna o mesmo shape de `computeStageAge`: `{ ageMinutes, label, stale }`.
 * `row.unidade` só serve de chave estável pro filtro interno de
 * `computeStageAge` (cada chamada sintetiza seu próprio array de 1 evento,
 * então não há risco de colisão entre unidades mesmo com chaves iguais).
 */
export function unitAge(row, now = Date.now()) {
  const ts = row && row.ultimoEventoISO ? row.ultimoEventoISO : null;
  const key = (row && row.unidade) || "unidade";
  return computeStageAge(key, ts ? [{ stage: key, timestamp: ts }] : [], now);
}

/**
 * Decide o texto/estado do rótulo "atualizado" a partir do payload de
 * `/api/round/:kind` (`studio-round.ts::RoundPayload`): usa `data.updatedAt`
 * (mtime REAL do plan.json no servidor) em vez de `new Date()` local — se o
 * arquivo não mudou entre duas chamadas, `updatedAt` também não muda, então
 * o rótulo não avança sozinho (corrige o falso-frescor).
 *
 * `stale` (badge de "possível stall") só liga quando HÁ alguma unidade "em
 * andamento" na timeline E a idade desde `updatedAt` excede o limiar de
 * `computeStageAge` — uma rodada já concluída não escreve mais plan.json por
 * definição, então sinalizar stall pra sempre depois do fim seria ruído
 * (dado não-acionável, sem nenhuma unidade viva pra realmente estar travada).
 *
 * `data` ausente ou sem `updatedAt` (sessão não encontrada, fetch falhou)
 * retorna `updatedAt: null` — o chamador decide o texto de fallback.
 */
export function roundFreshness(data, now = Date.now()) {
  if (!data || !data.updatedAt) {
    return { updatedAt: null, stale: false, ageLabel: null };
  }
  const timelineRows = Array.isArray(data.timeline) ? data.timeline : [];
  const hasRunningUnit = timelineRows.some((r) => r && r.fim === "em andamento");
  const age = computeStageAge("round", [{ stage: "round", timestamp: data.updatedAt }], now);
  return {
    updatedAt: data.updatedAt,
    stale: hasRunningUnit && age.stale,
    ageLabel: age.label,
  };
}
