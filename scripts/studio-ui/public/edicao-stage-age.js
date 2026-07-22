// edicao-stage-age.js (#3871) — lógica PURA de idade do último evento de um
// stage "current" no cockpit (`edicao.js`). Separado de propósito, mesmo
// padrão de revisao-guards.js (#3668): nenhuma chamada a document/fetch
// aqui — testável com fixtures puras via node:test, sem harness de DOM.
//
// Motivação (#3871): `renderTimeline` desenhava `status-${status}` +
// `current` sem indicar HÁ QUANTO TEMPO desde o último evento do stage — um
// stage "current" há 2min e um "current" há 2h renderizavam idêntico, só
// dava pra saber abrindo o terminal. O espelho remoto já resolve isso certo
// (`renderStudioSnapshotHtml`, workers/diaria-dashboard/src/index.ts, #3565):
// idade em minutos a partir de um timestamp, escalando pra um banner ⚠
// acima de um limiar. Este módulo replica o mesmo cálculo localmente, a
// partir do `logBuffer` já em memória (sem depender de nenhum snapshot).

// Limiar (minutos) acima do qual a idade do último evento é considerada
// suspeita o bastante pra promover o texto a um aviso mais visível (mesmo
// tratamento do banner ⚠ do espelho remoto). Valor sugerido na própria
// issue #3871; não precisa ser igual a STUDIO_SNAPSHOT_STALE_MINUTES (10,
// no Worker) — contextos diferentes (push de snapshot vs log em memória).
export const STAGE_AGE_STALE_MINUTES = 15;

/**
 * Calcula a idade do evento de log mais recente pertencente a `stage`, a
 * partir de `logBuffer` (array de eventos do run-log já filtrado pela
 * edição corrente — ver `pushLogEvents` em edicao.js). `now` é injetável
 * (ms epoch) pra teste determinístico — mesmo padrão de
 * `renderStudioSnapshotHtml(snapshot, now)`.
 *
 * Retorna `{ ageMinutes, label, stale }`:
 *   - `ageMinutes` é `null` quando não há nenhum evento válido pro stage
 *     (situação MAIS suspeita — sem timestamp pra calcular nada).
 *   - `label` é o texto pronto pra exibir; quando `ageMinutes` é `null`,
 *     preferimos "sem eventos registrados ainda" a esconder o campo (#3871,
 *     proposta original da issue).
 *   - `stale` é `true` quando não há eventos OU quando `ageMinutes` excede
 *     `STAGE_AGE_STALE_MINUTES` — o chamador usa isso pra decidir o
 *     tratamento visual (classe CSS de alerta).
 */
export function computeStageAge(stage, logBuffer, now = Date.now()) {
  const stageEvents = Array.isArray(logBuffer) ? logBuffer.filter((e) => e && e.stage === stage) : [];

  let lastTs = -Infinity;
  for (const ev of stageEvents) {
    const t = ev.timestamp ? new Date(ev.timestamp).getTime() : NaN;
    if (!Number.isNaN(t) && t > lastTs) lastTs = t;
  }

  if (!Number.isFinite(lastTs)) {
    return { ageMinutes: null, label: "sem eventos registrados ainda", stale: true };
  }

  const ageMinutes = Math.max(0, Math.round((now - lastTs) / 60_000));
  const label = ageMinutes === 0 ? "último evento agora mesmo" : `último evento há ${ageMinutes}min`;
  return { ageMinutes, label, stale: ageMinutes > STAGE_AGE_STALE_MINUTES };
}
