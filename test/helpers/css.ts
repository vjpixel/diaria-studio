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
 *
 * **Consciente de string.** Um `/*` DENTRO de literal (`content: "/*"`) não
 * abre comentário. A versão ingênua (um `String.replace` com
 * `/\/\*[\s\S]*?\*\//g`) tratava isso como abertura e apagava tudo até o
 * próximo `*\/` de verdade — engolindo declarações reais no meio, o que faria
 * um hex cru ou um `var()` órfão escaparem das DUAS invariantes sem deixar
 * rastro. Silenciar o detector é pior que o defeito que ele procura, então
 * vale os poucos estados a mais.
 *
 * Escopo: aspas simples e duplas, com escape por barra invertida. Não trata
 * `url()` sem aspas nem string não-terminada (nenhum dos dois aparece no CSS
 * do Studio, e ambos degradam pro comportamento antigo, nunca pior).
 */
export function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  /** `null` fora de string; senão, a aspa que a abriu. */
  let quote: string | null = null;

  while (i < css.length) {
    const c = css[i];

    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < css.length) {
        // Escape: consome o próximo caractere sem interpretá-lo como aspa.
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && css[i + 1] === "*") {
      const fim = css.indexOf("*/", i + 2);
      const trecho = fim === -1 ? css.slice(i) : css.slice(i, fim + 2);
      // Preserva as quebras de linha, some com o resto.
      out += trecho.replace(/[^\n]/g, " ");
      i += trecho.length;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}
