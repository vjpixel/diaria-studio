/**
 * Invariants de Stage 1 — Pesquisa (#1007 Fase 1).
 *
 * Checks rodados em 2 momentos distintos do Stage 1:
 *
 * 1. **Pré-gate** (ainda só `01-categorized.md` existe): apenas
 *    `categorized-has-eia-section` faz sentido aqui.
 *
 * 2. **Pós-gate apply** (após `apply-gate-edits.ts` escrever
 *    `_internal/01-approved.json`): `approved-has-3-highlights` +
 *    `coverage-line-present`.
 *
 * O orchestrator chama `--stage 1` no momento (2). Pré-gate é coberto
 * por `--stage 1 --rule categorized-has-eia-section` se quiser ser
 * explícito, ou simplesmente os checks pós-gate apply assumem que a
 * gate UI mostrou erros pré-aprovação.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface HighlightLike {
  bucket?: string;
  url?: string;
  title?: string;
  article?: { url?: string; title?: string; category?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: HighlightLike[];
  lancamento?: unknown[];
  pesquisa?: unknown[];
  noticias?: unknown[];
  coverage?: { line?: string };
}

/**
 * Stage 2 espera 2 ou 3 highlights. Editor pode ter aprovado com 1 ou 4+
 * (corrupção do gate UX). Falha cedo para fora do range {2,3}.
 * #2343: 2-destaque é suportado; range válido é [2,3].
 */
function checkApprovedHas3Highlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "approved-exists",
        message: `_internal/01-approved.json ausente — gate Stage 1 não foi aprovado. Rode \`/diaria-1-pesquisa {AAMMDD}\` antes.`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch (e) {
    return [
      {
        rule: "approved-parseable",
        message: `_internal/01-approved.json não parseável: ${(e as Error).message}`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  // #2343: 2-destaque é suportado — range válido {2,3}. <2 ou >3 é erro.
  if (highlights.length < 2 || highlights.length > 3) {
    return [
      {
        rule: "approved-has-3-highlights",
        message:
          `_internal/01-approved.json tem ${highlights.length} highlight(s) — ` +
          `Stage 2 aceita 2 ou 3 (D1+D2 ou D1+D2+D3). Fora desse range indica corrupção do gate.`,
        source_issue: "#2343",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `01-categorized.md` deve incluir seção "## É IA?" — Stage 2 writer lê esse
 * markdown pra extrair linha de crédito. Sem ela, writer omite É IA? do draft.
 */
function checkCategorizedHasEiaSection(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "01-categorized.md");
  if (!existsSync(path)) {
    return [
      {
        rule: "categorized-md-exists",
        message: `01-categorized.md ausente`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  const md = readFileSync(path, "utf8");
  // #1260: aceitar header strict (`## É IA?`) ou placeholder com sufixo (`## É IA? ⏳ (...)`).
  // Placeholder é inserido por render-categorized-md.ts quando 01-eia.md não existe ainda.
  if (!/^## É IA\?(\s|$)/m.test(md)) {
    return [
      {
        rule: "categorized-has-eia-section",
        message:
          `01-categorized.md sem "## É IA?" — render-categorized-md.ts não inseriu o bloco. ` +
          `Stage 2 writer não vai conseguir extrair linha de crédito.`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * Coverage line ("Para esta edição...") deve estar presente em `01-approved.json`.
 * Writer Stage 2 usa essa string como primeira linha do draft.
 */
function checkCoverageLinePresent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-has-3-highlights
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!data.coverage?.line || data.coverage.line.trim().length === 0) {
    return [
      {
        rule: "coverage-line-present",
        message:
          `_internal/01-approved.json sem coverage.line — writer vai usar fallback "???". ` +
          `Verificar se apply-gate-edits.ts rodou após o gate humano.`,
        source_issue: "#592",
        severity: "warning",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * #3436: destaques NUNCA devem vir do bucket USE MELHOR — a seção já tem
 * visibilidade garantida própria (mínimo 2 itens renderizados, #1855), então
 * promover um tutorial a destaque também é redundante e desperdiça um slot
 * editorial nobre (imagem gerada, post social próprio) que deveria ir para
 * uma notícia real de LANÇAMENTOS ou RADAR.
 *
 * Caso real: edição 260714 selecionou "Como o Copilot acha inconsistências
 * no Excel" (tutorial, `discovery: tutorial passo a passo como usar IA para`)
 * como D2.
 *
 * Backstop determinístico — a primeira linha de defesa é a instrução no
 * prompt do `scorer-select` (nunca escolher destaque de `use_melhor`); este
 * guard pega o caso de o agent ignorar a instrução, ou de o `bucket` chegar
 * corrompido por outro caminho.
 *
 * O campo `bucket` de um highlight tem 2 shapes possíveis dependendo de QUAL
 * passo do pipeline o escreveu por último:
 *   - `scorer-select`/`assemble-scored.ts` grava o bucket de SEÇÃO
 *     (`lancamento`/`radar`/`use_melhor`/`video`) — ver scorer-select.md.
 *   - `apply-gate-edits.ts` (pós-gate humano OU `--auto`) RE-ESCREVE `bucket`
 *     com a CATEGORY do artigo original (`article.category`, ex: `"tutorial"`
 *     para um item que veio do bucket use_melhor — ver `buildHighlight()` /
 *     `findArticle()` em apply-gate-edits.ts). Por isso `01-approved.json`
 *     final tipicamente tem `bucket: "tutorial"`, não `bucket: "use_melhor"`,
 *     para esse caso.
 * Checa as DUAS formas (top-level `bucket` e `article.category` nested) para
 * cobrir qualquer um dos 2 caminhos sem depender de qual escreveu por último.
 */
const USE_MELHOR_BUCKET_VALUES = new Set(["use_melhor", "tutorial"]);

function isUseMelhorHighlight(h: HighlightLike): boolean {
  if (h.bucket && USE_MELHOR_BUCKET_VALUES.has(h.bucket)) return true;
  if (h.article?.category && USE_MELHOR_BUCKET_VALUES.has(h.article.category)) return true;
  return false;
}

function checkNoUseMelhorHighlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-has-3-highlights
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // covered by approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  const offenders = highlights.filter(isUseMelhorHighlight);
  if (offenders.length === 0) return [];
  const titles = offenders
    .map((h) => h.title ?? h.article?.title ?? h.url ?? h.article?.url ?? "(sem título)")
    .join("; ");
  return [
    {
      rule: "no-use-melhor-highlights",
      message:
        `${offenders.length} destaque(s) do bucket USE MELHOR em highlights[] — ` +
        `destaques nunca devem vir de tutorial/use_melhor (#3436): ${titles}. ` +
        `Remover do Destaques (a seção USE MELHOR já garante visibilidade própria) e ` +
        `promover o próximo candidato de LANÇAMENTOS/RADAR.`,
      source_issue: "#3436",
      severity: "error",
      file: path,
    },
  ];
}

export const STAGE_1_RULES: InvariantRule[] = [
  {
    id: "approved-has-3-highlights",
    description: "01-approved.json tem 2 ou 3 highlights (#2343)",
    source_issue: "#2343",
    stage: 1,
    run: checkApprovedHas3Highlights,
  },
  {
    id: "categorized-has-eia-section",
    description: "01-categorized.md inclui seção '## É IA?' (#481)",
    source_issue: "#481",
    stage: 1,
    run: checkCategorizedHasEiaSection,
  },
  {
    id: "coverage-line-present",
    description: "01-approved.json tem coverage.line (#592)",
    source_issue: "#592",
    stage: 1,
    run: checkCoverageLinePresent,
  },
  {
    id: "no-use-melhor-highlights",
    description: "highlights[] nunca contém item do bucket USE MELHOR/tutorial (#3436)",
    source_issue: "#3436",
    stage: 1,
    run: checkNoUseMelhorHighlights,
  },
];

export {
  checkApprovedHas3Highlights,
  checkCategorizedHasEiaSection,
  checkCoverageLinePresent,
  checkNoUseMelhorHighlights,
  isUseMelhorHighlight,
};
