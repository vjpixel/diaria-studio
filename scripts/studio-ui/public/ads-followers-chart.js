// ads-followers-chart.js (#8475 Parte B, extração #8534) — lógica PURA do
// gráfico "Saldo diário de seguidores" (Instagram/Facebook) do painel
// /ads: geometria das barras, baseline zero, escala simétrica quando há
// saldo negativo.
//
// `renderFollowersChart` em `ads.js` toca `document`/monta a string SVG e
// não é importável em node:test — mesmo padrão de `ads-chart.js` (#8300)
// e `gate-badge.js` (#7050): a lógica de DECISÃO (quais datas viram barra,
// onde fica a linha zero, altura/posição de cada barra) mora aqui como
// função pura; `ads.js` só desenha o SVG a partir do modelo devolvido.
//
// Contrato coberto (os 5 invariantes do #8475 Parte B, achado #8534: os 3
// testes anteriores nunca chamavam nenhuma função real):
//   1. baseline zero é SEMPRE parte do modelo (mesmo sem saldo negativo).
//   2. saldo negativo → escala simétrica (symM = max(|min|, |max|)) e a
//      barra desenha ABAIXO da baseline (y >= zeroY).
//   3. dia sem coleta (nenhum ponto de nenhum canal nessa data) não entra
//      em `dates` — não gera barra "fantasma".
//   4. 1ª amostra sem saldo (`delta` `null`/ausente) não gera barra para
//      aquele canal naquele dia — mas o total do tile (fora deste módulo)
//      permanece, é dado avulso do `renderFollowers` (tiles).
//   5. `followers` `null` → `buildFollowersChartModel` devolve `null`
//      (fail-soft) — `ads.js` esconde o container inteiro nesse caso, sem
//      montar SVG nenhum.

/** Monta o modelo geométrico do gráfico de saldo diário a partir de
 *  `followers` (`{ instagram: { points: [...] }, facebook: { points: [...] } }`
 *  — mesmo shape de `data.followers` no painel).
 *
 *  Devolve `null` quando não há nada pra desenhar: `followers` ausente, ou
 *  nenhuma data com pelo menos 1 ponto (IG ou FB) — item 5 do contrato
 *  acima. Caso contrário devolve as coordenadas SVG já resolvidas (em vez
 *  de só números abstratos) pra que `ads.js` monte a marcação sem
 *  reimplementar a matemática de escala — mesmo motivo de `ads-chart.js`
 *  devolver índice/linhas já resolvidos em vez de só os inputs brutos.
 *
 *  @param {{instagram?: {points?: Array<{date: string, delta: number|null}>}, facebook?: {points?: Array<{date: string, delta: number|null}>}} | null} followers
 *  @param {{W?: number, H?: number, M?: {top: number, right: number, bottom: number, left: number}}} [opts]
 */
export function buildFollowersChartModel(followers, opts = {}) {
  if (!followers) return null;
  const ig = followers.instagram || { points: [] };
  const fb = followers.facebook || { points: [] };

  const byDate = new Map();
  for (const p of ig.points || []) byDate.set(p.date, { ...(byDate.get(p.date) || {}), igDelta: p.delta });
  for (const p of fb.points || []) byDate.set(p.date, { ...(byDate.get(p.date) || {}), fbDelta: p.delta });
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return null;

  const W = opts.W ?? 720;
  const H = opts.H ?? 240;
  const M = opts.M ?? { top: 24, right: 24, bottom: 32, left: 36 };
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;

  // Min/max sobre os deltas REAIS (ignora dias/canais sem coleta) — a
  // escala nunca é distorcida por um `null` tratado como zero.
  let minV = Infinity;
  let maxV = -Infinity;
  for (const d of dates) {
    const row = byDate.get(d);
    if (row == null) continue;
    if (row.igDelta != null) { minV = Math.min(minV, row.igDelta); maxV = Math.max(maxV, row.igDelta); }
    if (row.fbDelta != null) { minV = Math.min(minV, row.fbDelta); maxV = Math.max(maxV, row.fbDelta); }
  }
  if (!isFinite(minV)) minV = 0;
  if (!isFinite(maxV)) maxV = 0;
  const hasNeg = minV < 0;
  const symM = hasNeg ? Math.max(Math.abs(minV), Math.abs(maxV)) : Math.max(0, maxV);
  const scaleY = (v) => ph - ((v + (hasNeg ? symM : 0)) / (hasNeg ? 2 * symM : Math.max(1, symM))) * ph;
  const zeroYRel = hasNeg ? scaleY(0) : ph; // baseline SEMPRE calculada — invariante 1

  const groupW = pw / Math.max(1, dates.length);
  const barW = Math.max(2, groupW * 0.35);

  const bars = [];
  for (let idx = 0; idx < dates.length; idx += 1) {
    const date = dates[idx];
    const cx = M.left + idx * groupW + groupW / 2;
    const row = byDate.get(date) || {};
    if (row.igDelta != null) {
      const h = Math.abs(scaleY(row.igDelta) - zeroYRel);
      const y = row.igDelta >= 0 ? M.top + zeroYRel - h : M.top + zeroYRel;
      bars.push({ date, channel: "instagram", delta: row.igDelta, x: cx - barW, y, width: barW, height: h });
    }
    if (row.fbDelta != null) {
      const h = Math.abs(scaleY(row.fbDelta) - zeroYRel);
      const y = row.fbDelta >= 0 ? M.top + zeroYRel - h : M.top + zeroYRel;
      bars.push({ date, channel: "facebook", delta: row.fbDelta, x: cx, y, width: barW, height: h });
    }
  }

  return {
    W,
    H,
    margin: M,
    plotWidth: pw,
    plotHeight: ph,
    dates,
    hasNeg,
    symM,
    zeroY: M.top + zeroYRel, // absoluto, em coordenadas do SVG
    groupW,
    barW,
    bars,
  };
}
