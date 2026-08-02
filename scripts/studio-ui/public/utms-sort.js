// utms-sort.js (#4463) — lógica PURA de ordenação/conversão da tabela de
// Emissores (`utms.html`/`utms.js`). Separado de propósito de `utms.js`:
// nenhuma exportação abaixo toca `document` — testável com fixtures puras,
// sem harness de DOM (mesmo padrão de `revisao-guards.js`, #3668/#633).

/**
 * % conversão (cliques → assinantes), #4463. `null` quando falta qualquer um
 * dos dois números OU `clicks` é 0/negativo — dividir por zero também não é
 * "0% real", é "não dá pra calcular" (mesma convenção de `null` usada em
 * `subscribers`/`clicks`, ver `fmtNum` em `utms.js`). Cliques (Brevo, últimas
 * 20 campanhas) e Assinantes (Beehiiv, all-time) são janelas de tempo
 * DIFERENTES — o valor é um sinal direcional, pode passar de 100% (caveat
 * documentado na UI, ver o tooltip/hint da coluna em `utms.html`). @pure
 */
export function computeConversion(row) {
  if (row.subscribers === null || row.subscribers === undefined) return null;
  if (row.clicks === null || row.clicks === undefined || row.clicks <= 0) return null;
  return (row.subscribers / row.clicks) * 100;
}

/** `null`/`undefined` = mesma convenção de `fmtNum` (utms.js): "sem dado", não
 * "zero real". @pure */
export function fmtPercent(n) {
  return n === null || n === undefined ? "—" : `${n.toFixed(1)}%`;
}

/** Acessores por coluna ordenável — `conversion` sempre lê o percentual JÁ
 * CALCULADO por `computeConversion` (nunca um valor recalculado diferente
 * dentro do comparador). Uso só interno a este módulo (não exportado —
 * `sortRows` é a única superfície pública de ordenação). */
const SORT_ACCESSORS = {
  clicks: (row) => row.clicks,
  subscribers: (row) => row.subscribers,
  conversion: (row) => computeConversion(row),
};

/**
 * Ordena `rows` por `column`/`direction`. `null`/`undefined` (fetch falhou,
 * ou a base pra `%` é zero) sempre vai pro FIM da lista, em QUALQUER
 * direção — nunca se mistura com "zero real" nem inverte de lugar ao trocar
 * asc/desc. Empate (inclusive dentro do grupo "sem dado") preserva a ordem
 * natural de entrada (sort estável). Sem `column` ativa, devolve uma cópia na
 * ordem natural (identidade). @pure
 */
export function sortRows(rows, column, direction) {
  if (!column) return [...rows];
  const accessor = SORT_ACCESSORS[column];
  const withValue = rows.map((row, index) => ({ row, index, value: accessor(row) }));
  const known = withValue.filter((x) => x.value !== null && x.value !== undefined);
  const unknown = withValue.filter((x) => x.value === null || x.value === undefined);
  const dir = direction === "asc" ? 1 : -1;
  known.sort((a, b) => (a.value - b.value) * dir || a.index - b.index);
  unknown.sort((a, b) => a.index - b.index);
  return [...known, ...unknown].map((x) => x.row);
}
