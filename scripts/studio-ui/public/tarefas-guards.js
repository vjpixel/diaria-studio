// tarefas-guards.js (#4799) — lógica PURA da página de Tarefas
// (`tarefas.html`/`tarefas.js`): predicado do filtro de status + formatação
// de duração. Nenhuma das exportações toca `document`/`fetch` — mesmo
// padrão de `triagem-filters.js` (#4809)/`revisao-guards.js` (#3668/#633):
// separado de propósito pra ficar testável com fixtures puras, sem harness
// de DOM.

/** Um item de `TasksSnapshot.tasks` (ver `scripts/studio-ui/studio-tasks.ts`)
 * casa com o filtro de status selecionado. `""` (Todos) sempre casa. @pure */
export function matchesStatusFilter(task, filter) {
  if (!filter) return true;
  if (filter === "overdue") return Boolean(task.overdue);
  if (filter === "not_armed") return task.armed?.state === "not_armed";
  if (filter === "disabled") return task.armed?.state === "disabled";
  if (filter === "failed") return task.lastRun?.outcome === "failed";
  return true;
}

/** Formata uma duração em ms num rótulo curto pt-BR ("7s", "2min 5s",
 * "1h 3min"). `null`/negativo -> "—". @pure */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}min ${seconds}s` : `${totalMinutes}min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
}
