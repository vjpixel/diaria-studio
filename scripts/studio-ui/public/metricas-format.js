// metricas-format.js (#9023) — formatação PURA (sem DOM) da página de
// métricas, mesmo padrão de rv-gate-format.js: metricas.js importa daqui e
// test/metricas-format.test.ts testa direto, sem harness de browser.

/** Formata `MetricResult.valor` conforme `unidade` — `null` é SEMPRE "sem
 * coleta", nunca "0" (regra de honestidade da issue #7178). `qualidade:
 * 'faixa'` mostra a faixa completa, nunca o ponto médio.
 *
 * O sufixo do teto vem de `limites.rotuloMax`, definido POR MÉTRICA no
 * registry (#9023) — antes era fixo "(até X com não-atribuídos)", que só faz
 * sentido pra aquisição e mentia no churn ("com limpeza manual") e no LTV
 * ("com churn orgânico"). Sem rótulo, mostra só "(até X)"; faixa degenerada
 * (min === max) mostra só o valor. */
export function fmtValor(result, unidade) {
  if (result.valor == null) return "sem coleta";
  const fmtNum = (n) => {
    if (unidade === "percentual") return `${n.toFixed(1)}%`;
    if (unidade === "razao") return n.toFixed(3);
    if (unidade === "brl") return `R$ ${n.toFixed(2).replace(".", ",")}`;
    if (unidade === "dias") return `${n.toFixed(1)}d`;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };
  if (result.qualidade === "faixa" && result.limites) {
    const { min, max, rotuloMax } = result.limites;
    if (min === max) return fmtNum(min);
    const sufixo = rotuloMax ? ` ${rotuloMax}` : "";
    return `${fmtNum(min)} (até ${fmtNum(max)}${sufixo})`;
  }
  const prefix = result.qualidade === "piso" ? "≥ " : "";
  return prefix + fmtNum(result.valor);
}
