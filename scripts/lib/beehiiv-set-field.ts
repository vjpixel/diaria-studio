/**
 * beehiiv-set-field.ts (#1423)
 *
 * Helper pra setar Title/Subtitle no Beehiiv via execCommand atomicamente.
 * Resolve bug em que `execCommand('insertText')` sozinho **concatena** o
 * novo valor com o existente quando a seleção é invalidada entre `select()`
 * e `insertText()` (race com handlers do React, autosave, blur, etc).
 *
 * Caso real 260520: mudei o título da edição múltiplas vezes; uma das
 * mudanças produziu "Google I/O: Gemini 3.5, Omni e agentes no SearchI/O:
 * Gemini 3.5, Omni e agentes no Search" — title duplicado. Detectado só
 * ~10min depois via API check.
 *
 * Sequência atômica:
 *   1. focus()
 *   2. select()  — selecionar todo o text atual
 *   3. execCommand('delete')  — limpar a seleção (atômico, sem race)
 *   4. execCommand('insertText', false, newValue)  — inserir o valor
 *   5. blur()  — disparar autosave
 *
 * Caller deve validar via Beehiiv API que `last_test_email_sent_at` ou
 * `title`/`subtitle` está sincronizado (autosave latency #1198 — ~5s).
 */

export type BeehiivTextField = "post-title" | "post-subtitle";

/**
 * Gera JS string pra dispatch via `mcp__claude-in-chrome__javascript_tool`.
 * O JS retorna `{ localValue, error? }` — `localValue` é o valor que ficou
 * no DOM input pós-set. Caller compara com `expected` pra confirmar.
 *
 * @param fieldName "post-title" | "post-subtitle"
 * @param value     Novo valor (será JSON-encoded pra escape seguro)
 */
export function buildSetFieldJs(fieldName: BeehiivTextField, value: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(`textarea[name="${fieldName}"]`)});
      if (!el) return { error: ${JSON.stringify(`field ${fieldName} not found`)} };
      el.focus();
      el.select();
      document.execCommand('delete');
      document.execCommand('insertText', false, ${JSON.stringify(value)});
      el.blur();
      return { localValue: el.value };
    })()
  `;
}

/**
 * Pure: decide se um set field foi bem-sucedido cruzando o valor que o
 * Beehiiv API retornou contra o esperado. Trim whitespace pra tolerar
 * trailing/leading spaces. Case-sensitive (titles raramente diferem só
 * em case).
 *
 * Caller chama isso após esperar autosave (~5-8s) e fetch
 * `mcp__claude_ai_Beehiiv__get_post`.
 */
export function isFieldVerified(actual: string | null | undefined, expected: string): boolean {
  if (actual === null || actual === undefined) return false;
  return actual.trim() === expected.trim();
}
