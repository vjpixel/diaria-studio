/**
 * aquisicao-spend.ts (#5236 Parte 1)
 *
 * Import manual de custo de aquisição como peça de PRIMEIRA CLASSE, não
 * fallback envergonhado — o canal LinkedIn vai depender disto
 * PERMANENTEMENTE (não há MCP oficial pra Ads do LinkedIn, e a Marketing
 * API exige aprovação sem SLA previsível). `data/aquisicao/spend.csv`,
 * cinco colunas: `canal,mes,moeda,valor,fonte`.
 *
 * ## Formato de `valor`
 *
 * Número decimal com PONTO (`956.21`), nunca vírgula nem símbolo de moeda —
 * a coluna `moeda` já carrega o código (`BRL`) separadamente, então
 * `valor` é sempre uma string parseável por `Number()` direto. Formatar
 * como "R$ 956,21" é responsabilidade de quem RENDERIZA (cac-report.ts,
 * studio-ads.ts), nunca do CSV — mistura de locale na fonte de dado é
 * ambiguidade desnecessária (`,` é separador decimal em pt-BR mas separador
 * de milhar em en-US, e o parser não tem como adivinhar qual).
 *
 * ## Parser tolerante mas BARULHENTO (requisito explícito da issue)
 *
 * - Header faltando (qualquer uma das 5 colunas) → `parseSpendCsv` LANÇA —
 *   o arquivo inteiro é inválido, não dá pra seguir em frente adivinhando.
 * - Célula vazia numa linha específica → a linha é EXCLUÍDA do resultado
 *   (`rows`) mas registrada em `errors` com o motivo — nunca vira `0`/`""`/
 *   `null` silencioso que contaminaria uma soma sem ninguém perceber.
 * - `valor` não-numérico ou negativo → mesma disciplina (linha pra
 *   `errors`, nunca coagida pra 0).
 *
 * Callers (CLI `cac-report.ts`) são quem decide o que fazer com `errors`
 * não-vazio — este módulo nunca decide sozinho abortar ou seguir; só nunca
 * esconde o problema.
 */

import Papa from "papaparse";
import { existsSync, readFileSync } from "node:fs";

export const SPEND_CSV_HEADERS = ["canal", "mes", "moeda", "valor", "fonte"] as const;
export type SpendCsvHeader = (typeof SPEND_CSV_HEADERS)[number];

export interface SpendRow {
  canal: string;
  /** Livre — tipicamente `AAAA-MM`, mas não validado como data (algumas
   *  linhas são estimativa de janela, não mês único — ver seed abaixo). */
  mes: string;
  moeda: string;
  valor: number;
  fonte: string;
}

export interface SpendRowError {
  /** Número da linha no arquivo (1-based, header = linha 1). */
  line: number;
  reason: string;
  raw: Record<string, string>;
}

export interface ParseSpendCsvResult {
  rows: SpendRow[];
  errors: SpendRowError[];
}

/**
 * Parse puro (sem I/O) — `readSpendCsv` abaixo é quem lê do disco.
 *
 * @pure
 */
export function parseSpendCsv(content: string): ParseSpendCsvResult {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });
  const fields = parsed.meta.fields ?? [];
  const missingHeaders = SPEND_CSV_HEADERS.filter((h) => !fields.includes(h));
  if (missingHeaders.length > 0) {
    throw new Error(
      `[spend.csv] coluna(s) obrigatória(s) ausente(s) no header: ${missingHeaders.join(", ")}. ` +
        `Esperado: ${SPEND_CSV_HEADERS.join(",")}. Encontrado: ${fields.length > 0 ? fields.join(",") : "(vazio)"}.`,
    );
  }

  const rows: SpendRow[] = [];
  const errors: SpendRowError[] = [];

  parsed.data.forEach((raw, idx) => {
    const line = idx + 2; // +1 pelo header, +1 pra 1-based
    const canal = (raw.canal ?? "").trim();
    const mes = (raw.mes ?? "").trim();
    const moeda = (raw.moeda ?? "").trim();
    const fonte = (raw.fonte ?? "").trim();
    const valorRaw = (raw.valor ?? "").trim();

    const missingFields = [
      !canal && "canal",
      !mes && "mes",
      !moeda && "moeda",
      !fonte && "fonte",
      !valorRaw && "valor",
    ].filter((v): v is string => Boolean(v));

    if (missingFields.length > 0) {
      errors.push({ line, reason: `campo(s) vazio(s): ${missingFields.join(", ")}`, raw });
      return;
    }

    const valor = Number(valorRaw);
    if (!Number.isFinite(valor)) {
      errors.push({
        line,
        reason: `"valor" não é um número válido: "${valorRaw}" (use ponto decimal, ex: 956.21 — nunca vírgula ou símbolo de moeda)`,
        raw,
      });
      return;
    }
    if (valor < 0) {
      errors.push({ line, reason: `"valor" negativo: ${valor}`, raw });
      return;
    }

    rows.push({ canal, mes, moeda, valor, fonte });
  });

  return { rows, errors };
}

/** Lê e parseia `path`. Arquivo ausente lança com instrução explícita de
 *  como criar o seed — nunca degrada silenciosamente pra lista vazia (uma
 *  lista vazia por "arquivo não existe" seria indistinguível de "existe e
 *  não tem gasto nenhum", que é um estado real e diferente). */
export function readSpendCsv(path: string): ParseSpendCsvResult {
  if (!existsSync(path)) {
    throw new Error(
      `[spend.csv] arquivo não encontrado: ${path}. Rode "npx tsx scripts/seed-spend-csv.ts" pra criar o ` +
        `seed inicial, ou crie manualmente (colunas: ${SPEND_CSV_HEADERS.join(",")}).`,
    );
  }
  return parseSpendCsv(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Seed inicial — histórico completo de gasto conhecido em 260814 (#5236)
// ---------------------------------------------------------------------------

/**
 * As 3 linhas do histórico inteiro de gasto de aquisição conhecido em
 * 14/08/2026. `mes`/`fonte` são estimativa documentada (issue #5236 autoriza
 * explicitamente "melhor estimativa" quando o dado exato não está
 * disponível) — nenhum dos 3 valores é um `AAAA-MM` medido direto de um
 * relatório de cobrança mensal:
 *
 * - **Google Ads (R$ 956,21)**: campanha rodou dez/2025–fev/2026 (pausada
 *   ~06/fev/2026), gasto TOTAL acumulado do período inteiro, apurado no
 *   painel em 29/jul/2026 (#4466). `mes: "2026-02"` marca o mês de
 *   encerramento da campanha (última data em que o valor poderia ter
 *   mudado) — não "o mês em que o gasto ocorreu", que foi na verdade 3
 *   meses.
 * - **Beehiiv Boosts (R$ 397,08)**: acumulado histórico de Recommendations
 *   pagas, sem data de início registrada em nenhuma issue encontrada;
 *   `mes: "2026-07"` marca quando o valor foi MEDIDO (análise de #4466,
 *   03/ago/2026) — mesma disciplina de "melhor estimativa documentada",
 *   não "quando o gasto ocorreu".
 * - **LinkedIn (R$ 0)**: nenhum gasto real até 14/ago/2026 — linha
 *   placeholder deliberada (issue #5236, Parte 3: "implementar junto com o
 *   relatório, mesmo sabendo que os três canais estão com gasto zero
 *   hoje") pra manter os 3 canais visíveis desde o início, em vez do canal
 *   aparecer do nada quando o 1º gasto real acontecer. `mes: "2026-08"` é
 *   o mês de criação desta linha.
 *
 * Nenhum destes 3 é reconciliável com uma fatura mensal exata — se/quando
 * dados por mês precisos aparecerem (ex: export do #5254), a linha
 * correspondente deve ser SUBSTITUÍDA (ou uma linha nova adicionada pro mês
 * certo), não silenciosamente mantida como está.
 */
export const SPEND_SEED_ROWS: SpendRow[] = [
  {
    canal: "Google Ads",
    mes: "2026-02",
    moeda: "BRL",
    valor: 956.21,
    fonte:
      "painel Google Ads, campanha dez/2025-fev/2026 (pausada ~06/fev/2026), gasto total acumulado do período, apurado 29/jul/2026 — issues #4466/#5254",
  },
  {
    canal: "Beehiiv Boosts",
    mes: "2026-07",
    moeda: "BRL",
    valor: 397.08,
    fonte:
      "painel Beehiiv Recommendations, gasto total acumulado histórico, medido em análise de 03/ago/2026 — issue #4466",
  },
  {
    canal: "LinkedIn",
    mes: "2026-08",
    moeda: "BRL",
    valor: 0,
    fonte:
      "nenhum gasto realizado até 14/ago/2026 — linha placeholder deliberada pra manter os 3 canais visíveis desde o início (issue #5236)",
  },
];

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serializa linhas no formato `spend.csv` (header + linhas), CRLF-free.
 *  @pure */
export function formatSpendCsv(rows: SpendRow[] = SPEND_SEED_ROWS): string {
  const header = SPEND_CSV_HEADERS.join(",");
  const lines = rows.map((r) =>
    [r.canal, r.mes, r.moeda, String(r.valor), r.fonte].map(csvEscape).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
