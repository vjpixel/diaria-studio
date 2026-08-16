/**
 * test/helpers/css.ts (#5480)
 *
 * Utilitário compartilhado pelas duas invariantes de CSS do Studio
 * (`studio-css-no-raw-hex`, #4674, e `studio-css-var-defined`, #5480).
 *
 * As duas varrem `scripts/studio-ui/public/*.css` procurando padrões em
 * DECLARAÇÕES — e as duas tropeçaram no mesmo falso positivo: um comentário
 * que CITA o padrão proibido (tipicamente explicando por que ele foi
 * removido) contava como ocorrência real. Aconteceu ao vivo no #5480: o
 * comentário que documenta a correção do badge "Fora de rodada" menciona
 * tanto `var(--fg-dim, …)` quanto o hex `#EBE5D0`, e derrubou as duas.
 *
 * Comentário não pinta nada. Vive aqui, e não duplicado nos dois testes, pra
 * que a definição de "o que o parser ignora" seja uma só.
 */

/**
 * Remove comentários `/* … *\/` preservando a contagem de linhas — cada
 * caractere não-quebra vira espaço, então números de linha reportados a quem
 * lê a falha continuam apontando pro lugar certo no arquivo original.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
