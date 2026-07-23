// caixas-guards.js (#3924) — lógica PURA do guard de conflito de save da
// seção "Caixas" (`caixas.html`/`caixas.js`). Mesmo padrão de
// revisao-guards.js (#3668/#3729): nenhuma exportação toca `document`/`fetch`
// — testável com fixtures puras, sem harness de DOM (#633).
//
// Mesmo mecanismo de mtime de studio-review.ts (#3729): o server responde
// 409 quando o mtime em disco diverge do `expectedModifiedAt` que o client
// viu no último GET — aqui o cenário típico é 2 abas/sessões do Studio
// editando a MESMA caixa (nenhum stage de pipeline escreve em
// `context/snippets/` automaticamente, ao contrário de `02-reviewed.md`).

/** Mensagem do `confirm()` disparado por `saveCurrentBox()` quando o server
 * responde 409 — nunca "Tem certeza?" genérico (R6 de
 * docs/studio-ui-ux-guidelines.md): descreve o risco real e as duas saídas
 * (sobrescrever com force, ou recarregar do disco). */
export const BOX_SAVE_CONFLICT_CONFIRM_MESSAGE =
  "Esta caixa foi modificada desde que você abriu o editor — provavelmente salva por outra aba/sessão do " +
  "Studio. Clique OK para SOBRESCREVER com a sua versão mesmo assim, ou Cancelar para RECARREGAR a versão " +
  "mais recente do disco (suas edições não salvas aqui serão perdidas).";
