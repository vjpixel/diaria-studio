/**
 * analyze-h4.ts (#1619)
 *
 * H4 — ranking scorer vs CTR observado por edição.
 *
 * Por edição: lê os highlights do scorer (de `_internal/01-approved.json`) e o CTR
 * observado (`data/link-ctr-table.csv`), e computa:
 *   - Spearman rho entre ordem do scorer e ordem por CTR observado
 *   - Acerto top-1 (o #1 do scorer foi o mais clicado?)
 *   - Overlap top-3 (|scorer_top3 ∩ ctr_top3|)
 *
 * Mesma lógica de join canonicalizado e filtro Aprofunde da metodologia validada
 * em 2026-06-11 (#1619/#1567). Guard de n mínimo: edição com <4 matches NÃO entra
 * no agregado (lição do outlier 260601 — com n=3, um único destaque mal-ranqueado
 * produz rho=-1, distorcendo a média).
 *
 * Histórico append-only: `data/scorer-ctr-history.jsonl` — 1 linha por edição madura
 * (≥7d de cliques), idempotente (não recomputa edição já gravada).
 *
 * Uso:
 *   npx tsx scripts/analyze-h4.ts \
 *     --ctr data/link-ctr-table.csv \
 *     --editions-dir data/editions \
 *     [--history data/scorer-ctr-history.jsonl] \
 *     [--maturity-days 7]
 *
 * Importável pra re-análise #1567 e surfacing em update-audience.ts.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { canonicalize } from "./lib/url-utils.ts";
import { dateToEdition, type CtrRow, recordToCtrRow } from "./analyze-scorer-impact.ts";
import { isAprofundeAnchor } from "./lib/ctr-utils.ts";

const ROOT = resolve(import.meta.dirname, "..");

// Mínimo de matches entre scorer e CTR table pra incluir edição no agregado.
// Abaixo disso, n pequeno → Spearman instável (outlier 260601: n=3 → rho=-1).
export const MIN_MATCHES_FOR_AGGREGATE = 4;

// ─── Tipos públicos ─────────────────────────────────────────────────────────

export interface ScoredHighlight {
  url: string;
  score: number; // score do scorer (0-100)
}

/** Entrada de uma edição no histórico. */
export interface H4HistoryEntry {
  edition: string; // AAMMDD
  rho: number | null; // Spearman rho entre ranking-scorer e ranking-CTR; null = indefinido (zero-variância)
  top1_hit: boolean; // #1 do scorer foi o mais clicado?
  top3_overlap: number; // |scorer_top3 ∩ ctr_top3| (0-3)
  n_matches: number; // quantos destaques casaram no join
  computed_at: string; // ISO timestamp
}

/** Resultado do surfacing semanal (últimas 4 semanas). */
export interface H4Trend {
  entries: H4HistoryEntry[]; // as 4 semanas (pode ser menos se não houver)
  rho_mean: number | null; // rho médio das entradas
  top1_hit_rate: number | null; // taxa de acerto top-1 (0-1)
  alert_low_rho: boolean; // true se rho médio < 0.4 por 2 semanas consecutivas
}

// ─── Spearman rho ───────────────────────────────────────────────────────────

/**
 * Spearman rho para dois rankings numéricos de mesmo comprimento n≥2.
 * Inputs: arrays de valores (maiores = melhor). A função converte para ranks
 * com média de empates (rank 1 = maior), depois aplica a **correlação de
 * Pearson sobre os vetores de rank** — a definição geral correta do Spearman,
 * válida com ou sem ties.
 *
 * A fórmula simplificada ρ = 1 − 6Σd²/n(n²−1) é apenas uma simplificação
 * algébrica da Pearson-on-ranks que vale exclusivamente quando NÃO há empates
 * (variância dos ranks inteiros 1..n = n(n²−1)/6n). Com ranks médios
 * fracionários, a variância difere e a fórmula simplificada superestima rho em
 * até 0.375 — podendo suprimir `alert_low_rho` incorretamente.
 *
 * Retorna null se n < 2 (rho indefinido) ou se o desvio padrão for zero
 * (todos os valores empatados em pelo menos um vetor).
 *
 * Implementa ranks médios para empates:
 *   ex: [70, 70, 80] → sorted desc [80, 70, 70] → posições 1, 2, 3
 *   → empate nas posições 2 e 3 → rank médio = (2+3)/2 = 2.5
 *   → ranks finais: [2.5, 2.5, 1]
 *
 * Exemplos verificáveis à mão — sem ties (Pearson == fórmula simplificada):
 *   scorer  = [80, 60, 40] → ranks [1, 2, 3]; ctr [5,3,1] → ranks [1,2,3]
 *   mean=2; cov=((-1)(-1)+(0)(0)+(1)(1))/3=2/3; var=2/3; rho=1.000
 *
 *   scorer  = [80, 60, 40] → ranks [1,2,3]; ctr [1,3,5] → ranks [3,2,1]
 *   cov=((-1)(1)+(0)(0)+(1)(-1))/3=-2/3; rho=-1.000
 *
 * Exemplo com ties — Pearson ≠ fórmula simplificada:
 *   scorer = [70, 70, 80] → ranks [2.5, 2.5, 1]; ctr [5,3,1] → ranks [1,2,3]
 *   mean_rS=2, mean_rC=2
 *   cov=((0.5)(-1)+(0.5)(0)+(-1)(1))/3=(-0.5+0-1)/3=-0.500
 *   var_rS=(0.25+0.25+1)/3=0.5; var_rC=(1+0+1)/3=0.667
 *   rho=-0.5/sqrt(0.5×0.667)=-0.5/0.5774≈-0.866
 *   (fórmula simplificada daria 1-6×6.5/24=-0.625 — incorreto com ties)
 */
export function spearmanRho(scorerValues: number[], ctrValues: number[]): number | null {
  const n = scorerValues.length;
  if (n !== ctrValues.length || n < 2) return null;

  // Converte valores para ranks com média de empates (rank 1 = maior).
  // Algoritmo: ordena por valor desc, agrupa empates, atribui rank médio do grupo.
  const toRanks = (vals: number[]): number[] => {
    // índices ordenados do maior pro menor (sort estável via índice como tiebreak)
    const sorted = vals
      .map((v, i) => ({ v, i }))
      .sort((a, b) => b.v - a.v || a.i - b.i);

    const ranks = new Array<number>(n);
    let pos = 0;
    while (pos < n) {
      // Encontra o fim do grupo de valores empatados
      let end = pos;
      while (end + 1 < n && sorted[end + 1].v === sorted[pos].v) end++;
      // Rank médio: média das posições 1-based de pos..end
      const avgRank = (pos + 1 + end + 1) / 2; // = (pos + end + 2) / 2
      for (let k = pos; k <= end; k++) {
        ranks[sorted[k].i] = avgRank;
      }
      pos = end + 1;
    }
    return ranks;
  };

  const rS = toRanks(scorerValues);
  const rC = toRanks(ctrValues);

  // Pearson sobre os vetores de rank — definição geral do Spearman.
  // Correta com ou sem empates (ao contrário de 1−6Σd²/n(n²−1)).
  const meanS = rS.reduce((s, v) => s + v, 0) / n;
  const meanC = rC.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varS = 0, varC = 0;
  for (let i = 0; i < n; i++) {
    const ds = rS[i] - meanS;
    const dc = rC[i] - meanC;
    cov += ds * dc;
    varS += ds * ds;
    varC += dc * dc;
  }

  const denom = Math.sqrt(varS * varC);
  if (denom === 0) return null; // desvio padrão zero (todos empatados)
  return cov / denom;
}

// ─── Carrega highlights do scorer por edição ─────────────────────────────────

/**
 * Lê `_internal/01-approved.json` e extrai os candidatos pontuados com url+score.
 *
 * Inclui `highlights[]` (top-3 selecionados) + `runners_up[]` (próximos na fila)
 * para garantir que o join scorer×CTR possa atingir n ≥ MIN_MATCHES_FOR_AGGREGATE=4.
 * Com apenas 3 highlights, o guard de n≥4 seria sempre impossível (métrica morta).
 * runners_up têm scores válidos do scorer-select — semanticamente homogêneos.
 *
 * `all_scored` é ignorado: disponível só em edições chunked-parallel antigas (#1611)
 * e semanticamente distinto (pool não-filtrado com scores de scorer-chunk, não
 * scorer-select). Manter highlights+runners_up cobre o caso real observado
 * (260423: 3+2=5; 260424: 3+3=6; 260427: 6+2=8 — suficiente para n≥4).
 *
 * Retorna null se o arquivo não existe, é inválido, ou o conjunto é vazio.
 */
export function loadScorerHighlights(
  editionsDir: string,
  edition: string,
): ScoredHighlight[] | null {
  const p = resolve(ROOT, editionsDir, edition, "_internal", "01-approved.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const candidates: ScoredHighlight[] = [];
    // Inclui highlights[] + runners_up[] para que n_matches possa atingir >=4.
    // highlights têm prioridade: runners_up só adiciona URLs ainda não vistas.
    // Dedup por URL canônica evita que mesma URL em ambos os arrays infle n_matches
    // e duplique pontos no Spearman rho (#2232).
    const seenUrls = new Set<string>();
    const sources = [...(data.highlights ?? []), ...(data.runners_up ?? [])];
    for (const h of sources) {
      const url = h.article?.url ?? h.url;
      const score = typeof h.score === "number" ? h.score : null;
      if (typeof url === "string" && url && score !== null) {
        const canonical = canonicalize(url);
        if (!seenUrls.has(canonical)) {
          seenUrls.add(canonical);
          candidates.push({ url: canonical, score });
        }
      }
    }
    // Ordena por score desc (maior = mais bem ranqueado pelo scorer)
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates : null;
  } catch {
    return null;
  }
}

// ─── Carrega CTR table ──────────────────────────────────────────────────────

/**
 * Lê e parseia o CTR CSV. Filtra rows Aprofunde (regime pré-mar/2026) — mesma
 * lógica de update-audience.ts (#1564). O filtro é aplicado ANTES da conversão
 * para CtrRow (lendo o campo `anchor` do record bruto do papaparse), pois CtrRow
 * não expõe `anchor`. Retorna lista de CtrRow ou [] se arquivo ausente.
 * Defensivo: se o CSV não existe, retorna [] com log de aviso (não crasha).
 */
export function loadCtrRowsH4(ctrPath: string): CtrRow[] {
  const abs = resolve(ROOT, ctrPath);
  if (!existsSync(abs)) {
    process.stderr.write(
      `[analyze-h4] AVISO: CTR CSV ausente em ${abs} — H4 não pode ser computado.\n`,
    );
    return [];
  }
  const csv = readFileSync(abs, "utf8");
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return data
    .filter((rec) => !isAprofundeAnchor(rec.anchor ?? "")) // filtra regime pré-mar/2026
    .map(recordToCtrRow)
    .filter((r): r is CtrRow => r !== null);
}

// ─── Computa H4 por edição ──────────────────────────────────────────────────

/**
 * Computa as métricas H4 de uma única edição.
 *
 * @param scorerHighlights - highlights do scorer, ordenados por score desc
 * @param ctrRows - todas as linhas do CTR table (filtradas de Aprofunde)
 * @param editionDate - data da edição em YYYY-MM-DD
 * @returns objeto com rho/top1/top3/n_matches, ou null se n_matches < MIN_MATCHES_FOR_AGGREGATE
 */
export function computeEditionH4(
  scorerHighlights: ScoredHighlight[],
  ctrRows: CtrRow[],
  editionDate: string,
): Omit<H4HistoryEntry, "edition" | "computed_at"> | null {
  // Filtra linhas do CTR da edição
  const editionCtrRows = ctrRows.filter((r) => r.date === editionDate);
  if (editionCtrRows.length === 0) return null;

  // Monta mapa url_canônica → clicks e opens acumulados (soma quando URL aparece
  // em múltiplas linhas do CTR — ex: seções diferentes da mesma edição).
  const clicksByUrl = new Map<string, { clicks: number; opens: number }>();
  for (const r of editionCtrRows) {
    const key = canonicalize(r.base_url);
    const prev = clicksByUrl.get(key) ?? { clicks: 0, opens: 0 };
    clicksByUrl.set(key, {
      clicks: prev.clicks + r.unique_verified_clicks,
      opens: prev.opens + r.unique_opens,
    });
  }
  // Converte para CTR percentual
  const ctrByUrl = new Map<string, number>();
  for (const [url, { clicks, opens }] of clicksByUrl) {
    ctrByUrl.set(url, opens > 0 ? (clicks / opens) * 100 : 0);
  }

  // Join scorer ↔ CTR pela URL canônica — inclui url para top-1/top-3
  // (unificado: evita 2 loops independentes que podem divergir com canonicalização).
  const matched: Array<{ url: string; scorerScore: number; ctr: number }> = [];
  for (const h of scorerHighlights) {
    const ctr = ctrByUrl.get(h.url);
    if (ctr !== undefined) {
      matched.push({ url: h.url, scorerScore: h.score, ctr });
    }
  }

  const n = matched.length;
  if (n < MIN_MATCHES_FOR_AGGREGATE) return null;

  const scorerValues = matched.map((m) => m.scorerScore);
  const ctrValues = matched.map((m) => m.ctr);

  // Do NOT substitute null with 0 (#2243): null means "undefined correlation"
  // (zero-variance CTR — all links had 0 clicks). Storing 0.0 conflates undefined
  // with zero, falsely counting this edition toward alert_low_rho.
  // Return null here; computeH4Trend skips null-rho entries from rho_mean.
  const rho = spearmanRho(scorerValues, ctrValues);

  // Guard: when rho is null (zero-variance CTR — all links had 0 clicks), top1_hit
  // and top3_overlap are not meaningful. A stable sort on equal CTR values makes
  // topCtrUrl === topScorerUrl by coincidence, inflating top1_hit_rate with noise.
  // Return zeroed values so the caller can exclude or aggregate correctly (#2243).
  if (rho === null) {
    return { rho, top1_hit: false, top3_overlap: 0, n_matches: n };
  }

  // Top-1 e Top-3: derivados de `matched[]` (loop unificado, O(1) por lookup).
  // matched[] já contém só os pares casados, ordenados por score desc (herda a
  // ordem de scorerHighlights que é sorted by score desc antes do join).

  // Top-1 scorer (maior score entre casados) = matched[0].url (já em ordem desc).
  const topMatchedScorerUrl = matched[0]?.url;
  const topCtrUrl = matched
    .slice() // cópia para não mutuar
    .sort((a, b) => b.ctr - a.ctr)[0]?.url;
  const top1Hit = !!(topMatchedScorerUrl && topCtrUrl && topMatchedScorerUrl === topCtrUrl);

  // Overlap top-3: interseção dos top-3 do scorer vs top-3 por CTR — ambos do subset casado.
  const scorerTop3 = new Set(matched.slice(0, 3).map((m) => m.url));
  const ctrTop3 = new Set(
    matched
      .slice()
      .sort((a, b) => b.ctr - a.ctr)
      .slice(0, 3)
      .map((m) => m.url),
  );
  const top3Overlap = [...scorerTop3].filter((u) => ctrTop3.has(u)).length;

  return { rho, top1_hit: top1Hit, top3_overlap: top3Overlap, n_matches: n };
}

// ─── Histórico append-only ──────────────────────────────────────────────────

/**
 * Carrega as edições já gravadas no histórico JSONL.
 * Retorna Set de edition strings (AAMMDD). Defensivo: arquivo ausente → Set vazio.
 */
export function loadHistoryEditions(historyPath: string): Set<string> {
  const abs = resolve(ROOT, historyPath);
  if (!existsSync(abs)) return new Set();
  const lines = readFileSync(abs, "utf8").split("\n").filter(Boolean);
  const editions = new Set<string>();
  for (const line of lines) {
    try {
      const entry: H4HistoryEntry = JSON.parse(line);
      if (entry.edition) editions.add(entry.edition);
    } catch {
      /* linha malformada — ignora */
    }
  }
  return editions;
}

/**
 * Carrega todas as entradas do histórico JSONL.
 * Retorna array de H4HistoryEntry. Defensivo: arquivo ausente → [].
 *
 * Deduplica por edition: em caso de race (dois processos escrevem a mesma
 * edição antes que qualquer um releia), a ÚLTIMA linha ganha — preserva o
 * comportamento mais recente. Complementa a idempotência de appendHistory.
 */
export function loadHistory(historyPath: string): H4HistoryEntry[] {
  const abs = resolve(ROOT, historyPath);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, "utf8").split("\n").filter(Boolean);
  // Map<edition, entry>: dedup por edição — última linha vence.
  const byEdition = new Map<string, H4HistoryEntry>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as H4HistoryEntry;
      if (entry.edition) byEdition.set(entry.edition, normalizeHistoryEntry(entry));
    } catch {
      /* linha malformada — ignora */
    }
  }
  return [...byEdition.values()];
}

/**
 * Normaliza uma entrada do histórico para corrigir o efeito do bug antigo que
 * gravava `rho: 0.0` em vez de `rho: null` para edições zero-variância no CTR
 * (via `spearmanRho() ?? 0` — corrigido em #2243).
 *
 * Assinatura do bug: `rho === 0` EXATO + `top1_hit === false` + `top3_overlap === 0`.
 * Com rho verdadeiramente zero (correlação real nula), esperaríamos top1_hit e
 * top3_overlap com valores variados; rho=0 + top1_hit=false + top3_overlap=0
 * simultaneamente é o fingerprint da edição zero-CTR (todos os 0 cliques produzem
 * desvio padrão 0 → spearmanRho=null → antigo ?? 0 → rho=0.0 gravado).
 *
 * Entradas legítimas com rho≈0 verdadeiro teriam normalmente top3_overlap>0 (por
 * acaso) ou top1_hit=true (score alto casou com CTR alto por coincidência), mas a
 * combinação rho=0+top1=false+overlap=0 é altamente improvável sem zero-CTR.
 * False-positive residual: improvável e não-destrutivo (trataria uma correlação
 * real nula como indefinida — subestimaria levemente o count de definedRhoEntries).
 */
function normalizeHistoryEntry(entry: H4HistoryEntry): H4HistoryEntry {
  if (entry.rho === 0 && entry.top1_hit === false && entry.top3_overlap === 0) {
    // Likely a poisoned zero written by the old `spearmanRho() ?? 0` bug.
    // Treat as null (undefined correlation) to avoid contaminating rho_mean
    // and spuriously triggering alert_low_rho (#2243).
    return { ...entry, rho: null };
  }
  return entry;
}

/**
 * Append idempotente a nível de arquivo: re-lê as edições já gravadas antes de
 * escrever qualquer nova linha, ignorando entradas de edições já presentes.
 *
 * O guard no caller (computeNewH4Entries) protege o caso normal, mas dois
 * processos concorrentes podem derivar o mesmo `alreadyComputed` e ambos chamar
 * appendHistory para a mesma edição. Ao re-ler o arquivo aqui (just-in-time),
 * o processo mais lento detecta que a edição já foi escrita pelo processo mais
 * rápido e pula — evitando linhas duplicadas no JSONL.
 *
 * Nota: não usa lock de arquivo (Node não tem flock portável) mas a re-leitura
 * elimina duplicatas para o padrão de concorrência do cron (processos separados,
 * não threads compartilhando memória). Race window residual (leitura simultânea
 * antes de qualquer write) é improvável e sem consequência grave — a linha extra
 * seria detectada na próxima leitura por loadHistory.
 */
export function appendHistory(historyPath: string, entries: H4HistoryEntry[]): void {
  if (entries.length === 0) return;
  const abs = resolve(ROOT, historyPath);
  // Re-lê as edições já no arquivo (just-in-time) para filtrar duplicatas
  const alreadyInFile = loadHistoryEditions(historyPath);
  const toWrite = entries.filter((e) => !alreadyInFile.has(e.edition));
  for (const e of toWrite) {
    appendFileSync(abs, JSON.stringify(e) + "\n", "utf8");
  }
}

// ─── Computa edições recém-maduras (incremental) ─────────────────────────────

/**
 * Descobre edições maduras (≥maturityDays de cliques desde a data da edição) que
 * ainda não estão no histórico, e computa H4 para cada uma.
 *
 * @param ctrRows - rows do CTR (já filtradas de Aprofunde)
 * @param editionsDir - diretório base das edições (ex: "data/editions")
 * @param alreadyComputed - set de edições já no histório (para idempotência)
 * @param maturityDays - mínimo de dias após a data da edição (default 7)
 * @param now - data de referência (default hoje)
 * @returns novas entradas computadas (pode ser [])
 */
export function computeNewH4Entries(
  ctrRows: CtrRow[],
  editionsDir: string,
  alreadyComputed: Set<string>,
  maturityDays = 7,
  now: Date = new Date(),
): H4HistoryEntry[] {
  // Descobre edições distintas no CTR table
  const editionDates = new Map<string, string>(); // edition → date YYYY-MM-DD
  for (const r of ctrRows) {
    const ed = dateToEdition(r.date);
    if (!ed) {
      // Data malformada no CTR (dateToEdition retorna "" para input invalido)
      // — loga e ignora a linha.
      process.stderr.write(
        `[analyze-h4] AVISO: dateToEdition vazio para data "${r.date}" — linha ignorada.
`,
      );
      continue;
    }
    if (!editionDates.has(ed)) {
      editionDates.set(ed, r.date);
    }
  }

  const newEntries: H4HistoryEntry[] = [];
  const computedAt = now.toISOString();

  for (const [edition, edDate] of editionDates) {
    // Já computado → skip (idempotência)
    if (alreadyComputed.has(edition)) continue;

    // Maturidade: ≥maturityDays desde a data da edição
    const edDateObj = new Date(edDate);
    const daysSince = (now.getTime() - edDateObj.getTime()) / 86400000;
    if (daysSince < maturityDays) continue;

    // Carrega highlights do scorer
    const scorerHighlights = loadScorerHighlights(editionsDir, edition);
    if (!scorerHighlights) continue;

    // Computa H4
    const result = computeEditionH4(scorerHighlights, ctrRows, edDate);
    if (!result) continue; // n < MIN_MATCHES ou sem CTR

    newEntries.push({ edition, ...result, computed_at: computedAt });
  }

  return newEntries;
}

// ─── Surfacing: trend das últimas 4 semanas ──────────────────────────────────

/**
 * Computa o trend H4 das últimas 4 entradas do histórico.
 * Alerta se o rho médio móvel cair abaixo de 0.4 por 2 semanas consecutivas.
 */
export const H4_RHO_ALERT_THRESHOLD = 0.4;

export function computeH4Trend(entries: H4HistoryEntry[], windowSize = 4): H4Trend {
  // Ordena por edition (AAMMDD lexicalmente) e pega as últimas windowSize
  const sorted = [...entries].sort((a, b) => a.edition.localeCompare(b.edition));
  const recent = sorted.slice(-windowSize);

  // Skip entries with rho===null when computing rho_mean (#2243):
  // null means "undefined correlation" (zero-variance CTR), not zero.
  // Including them as 0 would falsely drag down the mean and trigger alert_low_rho.
  const definedRhoEntries = recent.filter((e) => e.rho !== null);
  const rhoMean =
    definedRhoEntries.length > 0
      ? definedRhoEntries.reduce((s, e) => s + (e.rho as number), 0) / definedRhoEntries.length
      : null;

  const top1HitRate =
    recent.length > 0
      ? recent.filter((e) => e.top1_hit).length / recent.length
      : null;

  // Alerta: rho < threshold por 2 semanas consecutivas dentro da janela (recent).
  // Usa recent.slice(-2) — não sorted.slice(-2) — para respeitar o parâmetro
  // windowSize: se recent já é um subconjunto da janela, comparar contra o histórico
  // completo (sorted) ignoraria o windowSize e poderia acionar (ou suprimir) o alerta
  // com dados fora da janela de trend configurada.
  // Entries with rho===null are excluded from the alert (undefined != low) (#2243).
  //
  // Asymmetric case: last2=[{low_rho},{null}] — alert does NOT fire.
  // Both entries must satisfy (rho !== null && rho < threshold). A null-rho entry
  // breaks the consecutive sequence: we can't infer the correlation was low just
  // because it was undefined (zero-CTR editions carry no signal about scorer quality).
  // This is intentionally conservative: prefer false-negative (miss a real low-rho
  // streak with a null interleaved) over false-positive (alert on noise from zero-CTR).
  const last2 = recent.slice(-2);
  const alertLowRho =
    last2.length === 2 &&
    last2.every((e) => e.rho !== null && e.rho < H4_RHO_ALERT_THRESHOLD);

  return { entries: recent, rho_mean: rhoMean, top1_hit_rate: top1HitRate, alert_low_rho: alertLowRho };
}

/**
 * Formata o surfacing H4 pra impressão no terminal (update-audience.ts).
 * Retorna string markdown-lite pronta pro console.log.
 */
export function formatH4Trend(trend: H4Trend): string {
  const lines: string[] = ["", "## H4 — Scorer × CTR (trend semanal)"];

  if (trend.entries.length === 0) {
    lines.push("  Sem histórico H4 disponível (aguardando edições maduras ≥7d).");
    return lines.join("\n");
  }

  lines.push(
    `  Últimas ${trend.entries.length} edições no histórico:`,
    "",
  );
  for (const e of trend.entries) {
    const hitStr = e.top1_hit ? "✓" : "✗";
    lines.push(
      `  ${e.edition}  rho=${e.rho !== null ? e.rho.toFixed(3) : "—(undef)"}  top1=${hitStr}  top3_overlap=${e.top3_overlap}  n=${e.n_matches}`,
    );
  }

  // Use count of entries with defined rho (same subset used for rho_mean),
  // not trend.entries.length (which includes null-rho editions that don't
  // contribute to the mean — wrong label would show "4 edições" when only 3 informed the mean).
  const definedRhoCount = trend.entries.filter((e) => e.rho !== null).length;
  lines.push("", `  Rho médio (${definedRhoCount} edições com rho definido): ${trend.rho_mean?.toFixed(3) ?? "—"}`);
  lines.push(`  Top-1 hit rate: ${trend.top1_hit_rate !== null ? `${(trend.top1_hit_rate * 100).toFixed(0)}%` : "—"}`);

  if (trend.alert_low_rho) {
    lines.push(
      "",
      "  ⚠️  ALERTA H4: rho médio < 0.4 por 2 semanas consecutivas — scorer pode estar pesando sinal editorial demais em relação ao CTR observado. Considerar re-análise dos pesos.",
    );
  }

  return lines.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const ctrPath = args.ctr ?? "data/link-ctr-table.csv";
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const historyPath = args.history ?? "data/scorer-ctr-history.jsonl";
  const maturityDays = parseInt(args["maturity-days"] ?? "7", 10);

  const ctrRows = loadCtrRowsH4(ctrPath);
  if (ctrRows.length === 0) {
    process.stderr.write("[analyze-h4] Nenhuma row de CTR carregada — abortando.\n");
    process.exit(1);
  }

  const alreadyComputed = loadHistoryEditions(historyPath);
  process.stderr.write(
    `[analyze-h4] ${alreadyComputed.size} edições já no histórico; verificando novas (maturidade ≥${maturityDays}d)...\n`,
  );

  const newEntries = computeNewH4Entries(
    ctrRows,
    editionsDir,
    alreadyComputed,
    maturityDays,
  );

  if (newEntries.length > 0) {
    appendHistory(historyPath, newEntries);
    process.stderr.write(`[analyze-h4] +${newEntries.length} entradas novas gravadas em ${historyPath}\n`);
  } else {
    process.stderr.write("[analyze-h4] Nenhuma edição nova madura encontrada.\n");
  }

  // Surfacing
  const allEntries = loadHistory(historyPath);
  const trend = computeH4Trend(allEntries);
  process.stdout.write(formatH4Trend(trend) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
