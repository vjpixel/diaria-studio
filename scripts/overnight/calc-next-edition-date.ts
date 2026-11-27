/**
 * SHIM de compatibilidade (#14121). Mudou para
 * `scripts/edicao-agendada/calc-next-edition-date.ts`, que imprime o AAMMDD
 * ao ser carregado; importar o módulo novo é o CLI inteiro.
 * Trava: `test/edicao-agendada-shims-14121.test.ts`.
 */
import "../edicao-agendada/calc-next-edition-date.ts";
