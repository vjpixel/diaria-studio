/**
 * scripts/lib/google-ads-csv.ts (#5503)
 *
 * Núcleo PURO (sem I/O) do parser dos exports MANUAIS do painel do Google
 * Ads (`data/aquisicao/google-ads/*.csv`) — formato incompatível com
 * `parseSpendCsv` (#5236, que espera `canal,mes,moeda,valor,fonte` sem
 * preâmbulo e número com ponto decimal):
 *
 * 1. **Preâmbulo de linhas livres** antes do header real (`Relatório de
 *    campanha` / `Todo o período`) — detectado pela PRESENÇA das colunas
 *    esperadas (`findHeaderRowIndex`), nunca por contagem fixa de linhas
 *    (arquivos diferentes do painel têm preâmbulos de tamanhos diferentes).
 * 2. **Colunas em pt-BR** (`Campanha`, `Custo`, `Palavra-chave`, `Impr.`,
 *    `Termo de pesquisa`) — casadas por regex tolerante a variação de
 *    pontuação/maiúscula, não por posição fixa.
 * 3. **Número pt-BR**: vírgula decimal (`"239,62"` → `239.62`) e ponto de
 *    milhar (`"7.936"` → `7936`, `"1.234,56"` → `1234.56`) — `parsePtBrNumber`.
 * 4. **Linhas `Total:` e células ` --`** — a primeira é DESCARTADA (somaria
 *    em dobro se ingerida crua); a segunda vira `null` (ausente), NUNCA `0`
 *    — mesma disciplina barulhenta de `aquisicao-spend.ts`: dado ausente
 *    nunca é coagido a um valor que contaminaria uma soma sem aviso.
 */

import Papa from "papaparse";
import type { SpendRow } from "./aquisicao-spend.ts";

// ---------------------------------------------------------------------------
// Normalização de número pt-BR
// ---------------------------------------------------------------------------

/**
 * `" --"` (placeholder do painel pra "sem dado") → `null`, nunca `0`.
 * `"239,62"` (vírgula decimal) → `239.62`. `"7.936"` (só ponto de milhar,
 * sem vírgula) → `7936`. `"1.234,56"` (milhar + decimal juntos) → `1234.56`.
 * Símbolos de moeda/percentual residuais (`R$`, `%`) e espaços são
 * removidos antes da conversão. String que não sobra um número válido após
 * a normalização → `null` (nunca `NaN` propagado silenciosamente).
 *
 * @pure
 */
export function parsePtBrNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "--" || trimmed === "-" || trimmed === "—") return null;

  let normalized = trimmed.replace(/[R$%\s]/g, "");
  if (normalized.includes(",")) {
    // vírgula decimal presente -> qualquer ponto é separador de milhar
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(normalized)) {
    // só pontos, no padrão de agrupamento de milhar (ex "7.936") -> remove
    normalized = normalized.replace(/\./g, "");
  }
  // senão: já é um número simples sem separador (ex "42") ou já teria ponto
  // decimal sozinho (não ocorre no export pt-BR, mas não quebra se ocorrer).

  if (normalized === "") return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Parser genérico "preâmbulo + header por presença de coluna"
// ---------------------------------------------------------------------------

export interface GoogleAdsCsvError {
  /** Linha 1-based no CONTEÚDO ORIGINAL (contando o preâmbulo). */
  line: number;
  reason: string;
}

export interface PanelCsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
  errors: GoogleAdsCsvError[];
}

/** Acha o índice (0-based) da primeira linha, dentre `rows` (já parseadas
 *  como array de células pelo CSV), que contém TODAS as colunas de
 *  `anchors` (cada `anchor` é uma regex testada contra o texto trimado de
 *  QUALQUER célula da linha) — a linha de header real, não importa quantas
 *  linhas de preâmbulo vieram antes. `-1` se nenhuma linha bater. @pure */
export function findHeaderRowIndex(rows: string[][], anchors: RegExp[]): number {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => c.trim());
    if (anchors.every((re) => cells.some((c) => re.test(c)))) return i;
  }
  return -1;
}

/**
 * Parseia um export do painel Google Ads: pula preâmbulo até achar a linha
 * de header (via `anchors`), descarta linhas `Total:` (primeira célula
 * começando com esse prefixo) e devolve o resto como registros
 * `coluna → valor cru` (sem normalização de número — isso é
 * responsabilidade de quem lê a coluna específica, ver
 * `parseGoogleAdsCampanhasCsv`/`parseGoogleAdsKeywordsCsv`/
 * `parseGoogleAdsTermosCsv` abaixo).
 *
 * Lança se nenhuma linha de header for encontrada — arquivo
 * fundamentalmente diferente do esperado, não dá pra seguir adivinhando
 * (mesma disciplina de `parseSpendCsv`: header ausente/errado é erro duro,
 * não degradação silenciosa).
 *
 * @pure
 */
export function parsePanelCsv(content: string, anchors: RegExp[]): PanelCsvParseResult {
  const parsed = Papa.parse<string[]>(content, { skipEmptyLines: true });
  const allRows = parsed.data;

  const headerIdx = findHeaderRowIndex(allRows, anchors);
  if (headerIdx === -1) {
    throw new Error(
      `[google-ads-csv] header não encontrado — nenhuma linha contém todas as colunas esperadas ` +
        `(${anchors.map((r) => r.source).join(", ")}). Arquivo pode ter mudado de formato.`,
    );
  }

  const headers = allRows[headerIdx].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  const errors: GoogleAdsCsvError[] = [];

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const cells = allRows[i];
    const line = i + 1; // 1-based
    const first = (cells[0] ?? "").trim();
    if (first === "") continue; // linha vazia residual
    if (first.startsWith("Total:")) continue; // linha de total — descartada, nunca somada

    if (cells.length < headers.length) {
      errors.push({ line, reason: `linha com menos colunas (${cells.length}) que o header (${headers.length})` });
      continue;
    }

    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (cells[idx] ?? "").trim();
    });
    rows.push(record);
  }

  return { headers, rows, errors };
}

function findColumn(headers: string[], pattern: RegExp): string | undefined {
  return headers.find((h) => pattern.test(h));
}

// ---------------------------------------------------------------------------
// campanhas-*.csv → { campanha, custo }
// ---------------------------------------------------------------------------

export interface GoogleAdsCampanhaRow {
  campanha: string;
  /** `null` quando a célula era ` --` (ausente) — nunca `0`. */
  custo: number | null;
}

const CAMPANHA_ANCHORS = [/^Campanha$/, /^Custo$/];

/** @pure */
export function parseGoogleAdsCampanhasCsv(content: string): { rows: GoogleAdsCampanhaRow[]; errors: GoogleAdsCsvError[] } {
  const parsed = parsePanelCsv(content, CAMPANHA_ANCHORS);
  const campanhaCol = findColumn(parsed.headers, /^Campanha$/)!;
  const custoCol = findColumn(parsed.headers, /^Custo$/)!;

  const rows: GoogleAdsCampanhaRow[] = [];
  const errors: GoogleAdsCsvError[] = [...parsed.errors];

  parsed.rows.forEach((raw, idx) => {
    const campanha = (raw[campanhaCol] ?? "").trim();
    if (!campanha) {
      errors.push({ line: idx + 1, reason: "coluna Campanha vazia" });
      return;
    }
    rows.push({ campanha, custo: parsePtBrNumber(raw[custoCol] ?? "") });
  });

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Sub-canal (#5503 item 6) — reusa EXATAMENTE `SpendRow.subcanal` do #5496,
// nunca inventa um mecanismo novo de separação.
// ---------------------------------------------------------------------------

export type GoogleAdsCsvSubcanal = "PMax" | "Search" | "Outros";

/** Classifica o NOME da campanha em PMax/Search/Outros por heurística de
 *  substring — confirmado contra os 2 nomes reais do export #5254
 *  (`"Pesquisa 260113"` → Search, `"Max"` → PMax, análise #4466/#5496).
 *  Campanha que não bate nenhum padrão cai em "Outros" — nunca descartada
 *  silenciosamente, nunca adivinhada como um dos dois conhecidos. @pure */
export function classifyCampanhaSubcanal(campanhaNome: string): GoogleAdsCsvSubcanal {
  const n = campanhaNome.toLowerCase();
  if (/\bpmax\b|performance\s*max|\bmax\b/.test(n)) return "PMax";
  if (/pesquisa|\bsearch\b/.test(n)) return "Search";
  return "Outros";
}

export interface BuildSpendRowsFromCampanhasOptions {
  canal: string;
  mes: string;
  moeda: string;
  fonteLabel: string;
}

/**
 * Agrupa `GoogleAdsCampanhaRow[]` por sub-canal (`classifyCampanhaSubcanal`)
 * e produz `SpendRow[]` — 1 linha por sub-canal PRESENTE nos dados (nunca
 * uma linha "Outros" vazia se não houver campanha nesse balde). Linha com
 * `custo: null` (célula ` --`) é EXCLUÍDA da soma (nunca contada como 0,
 * mesma disciplina do módulo inteiro).
 *
 * `mes` é responsabilidade do CALLER (#5503: os exports do painel vêm em
 * "Todo o período", sem coluna de data — não há como este módulo derivar
 * `mes` sozinho; o CLI exige `--mes` explícito, nunca adivinha).
 *
 * @pure
 */
export function buildSpendRowsFromCampanhas(
  rows: GoogleAdsCampanhaRow[],
  opts: BuildSpendRowsFromCampanhasOptions,
): SpendRow[] {
  const bySubcanal = new Map<GoogleAdsCsvSubcanal, number>();
  for (const r of rows) {
    if (r.custo == null) continue;
    const sub = classifyCampanhaSubcanal(r.campanha);
    bySubcanal.set(sub, (bySubcanal.get(sub) ?? 0) + r.custo);
  }
  return [...bySubcanal.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subcanal, valor]) => ({
      canal: opts.canal,
      subcanal,
      mes: opts.mes,
      moeda: opts.moeda,
      valor: Math.round(valor * 100) / 100,
      fonte: `${opts.fonteLabel} — sub-canal ${subcanal}, import manual de CSV do painel`,
    }));
}

// ---------------------------------------------------------------------------
// palavras-chave-*.csv → keywords com zero impressão
// ---------------------------------------------------------------------------

export interface GoogleAdsKeywordRow {
  palavraChave: string;
  /** `null` quando a célula era ` --` — nunca `0` por coação; keywords
   *  genuinamente com 0 impressões vêm como `0` explícito do painel. */
  impressoes: number | null;
}

const KEYWORD_ANCHORS = [/Palavra-chave/, /Impr/];

/** @pure */
export function parseGoogleAdsKeywordsCsv(content: string): { rows: GoogleAdsKeywordRow[]; errors: GoogleAdsCsvError[] } {
  const parsed = parsePanelCsv(content, KEYWORD_ANCHORS);
  const kwCol = findColumn(parsed.headers, /Palavra-chave/)!;
  const imprCol = findColumn(parsed.headers, /Impr/)!;

  const rows: GoogleAdsKeywordRow[] = [];
  const errors: GoogleAdsCsvError[] = [...parsed.errors];

  parsed.rows.forEach((raw, idx) => {
    const palavraChave = (raw[kwCol] ?? "").trim();
    if (!palavraChave) {
      errors.push({ line: idx + 1, reason: "coluna Palavra-chave vazia" });
      return;
    }
    rows.push({ palavraChave, impressoes: parsePtBrNumber(raw[imprCol] ?? "") });
  });

  return { rows, errors };
}

/** Keywords com impressão explicitamente 0 — `null` (ausente/` --`) NÃO
 *  entra aqui, é um caso diferente (dado faltando, não "zero medido"). @pure */
export function zeroImpressionKeywords(rows: GoogleAdsKeywordRow[]): GoogleAdsKeywordRow[] {
  return rows.filter((r) => r.impressoes === 0);
}

// ---------------------------------------------------------------------------
// termos-de-pesquisa-*.csv → termos com custo > 0
// ---------------------------------------------------------------------------

export interface GoogleAdsTermoRow {
  termoDePesquisa: string;
  /** `null` quando a célula era ` --` — nunca `0`. */
  custo: number | null;
}

const TERMO_ANCHORS = [/Termo de pesquisa/, /^Custo$/];

/** @pure */
export function parseGoogleAdsTermosCsv(content: string): { rows: GoogleAdsTermoRow[]; errors: GoogleAdsCsvError[] } {
  const parsed = parsePanelCsv(content, TERMO_ANCHORS);
  const termoCol = findColumn(parsed.headers, /Termo de pesquisa/)!;
  const custoCol = findColumn(parsed.headers, /^Custo$/)!;

  const rows: GoogleAdsTermoRow[] = [];
  const errors: GoogleAdsCsvError[] = [...parsed.errors];

  parsed.rows.forEach((raw, idx) => {
    const termoDePesquisa = (raw[termoCol] ?? "").trim();
    if (!termoDePesquisa) {
      errors.push({ line: idx + 1, reason: "coluna Termo de pesquisa vazia" });
      return;
    }
    rows.push({ termoDePesquisa, custo: parsePtBrNumber(raw[custoCol] ?? "") });
  });

  return { rows, errors };
}

/** Termos com custo > 0 — exclui `null` (ausente) e `0` explícito. @pure */
export function termsWithCost(rows: GoogleAdsTermoRow[]): GoogleAdsTermoRow[] {
  return rows.filter((r) => r.custo != null && r.custo > 0);
}
