/**
 * lint-checks/banned-lexicon.ts (#7260)
 *
 * Backstop editorial pra vocabulário PROIBIDO — palavra errada existe, palavra
 * certa existe, decisão do editor é permanente e não tem exceção legítima.
 * Diferente de `title-mentions-ia.ts` (#4825, warn-only por ter exceções
 * reais — nome próprio, citação, manchete sobre a categoria), aqui não há
 * ambiguidade: a forma banida NUNCA é a palavra certa. Por isso GATE-BLOCKING,
 * não warning.
 *
 * ## Origem (#7260)
 *
 * "Agentivo" (termo de linguística — papel temático do agente numa oração)
 * reincidiu 7 vezes em 4 meses (260510, 260515, 260518, 260625, 260731,
 * 260821, 260903) em vez de "agêntico" (termo do domínio de IA, correspondente
 * a *agentic*). Varredura em `data/editions/` achou a forma errada em 32
 * arquivos publicados (`02-reviewed.md`/`newsletter-final.html` inclusos)
 * contra 177 arquivos com a forma certa — o vocabulário certo já é dominante,
 * a forma errada escapa de forma intermitente. Exatamente o padrão que um
 * guard mecânico resolve e atenção humana não.
 *
 * ## Desenho: tabela de substituições, não check dedicado a 1 termo
 *
 * `BANNED_LEXICON` é uma lista `errado → certo` (sugestão da própria issue) —
 * um 2º termo banido no futuro só precisa de 1 entrada nova aqui, não de um
 * módulo novo nem de fiação nova em `lint-newsletter-md.ts`/`lint-social-md.ts`.
 *
 * ## Escopo: só texto PUBLICADO
 *
 * Roda sobre `02-reviewed.md` e `03-social.md` (os 2 artefatos gate-facing
 * que o leitor de fato recebe) — nunca sobre `01-categorized.json`,
 * `tmp-scored.json` ou qualquer outro artefato interno com prosa de LLM em
 * campo de raciocínio (a varredura do #7260 achou "compreensão agentiva" em
 * exatamente esse tipo de campo — ruído de saída de modelo, não erro
 * editorial visível ao leitor). Ver docstring de `runStage4LintReport`
 * (`lint-newsletter-md.ts`) e `runStage4SocialLintReport`
 * (`lint-social-md.ts`) pra onde este check é de fato disparado.
 *
 * ## Falso positivo
 *
 * Cada entrada casa por `\b...\b` (word boundary nos dois lados) — nunca
 * casa a sequência banida como substring de uma palavra maior. Nenhuma
 * palavra legítima do português conhecida contém "agentiv" como
 * substring — não há colisão conhecida (coberto por teste de regressão).
 */

export interface BannedLexiconEntry {
  /** Identificador estável da entrada (usado em relatório/teste). */
  id: string;
  /**
   * Regex que casa a(s) flexão(ões) da forma BANIDA. Sempre `\b...\b`,
   * sempre `i` (case-insensitive) — a forma errada é errada em qualquer
   * capitalização.
   */
  pattern: RegExp;
  /** Forma correta a sugerir (singular, referência — não tenta casar flexão 1:1). */
  correct: string;
  /** Issue que originou a proibição. */
  sourceIssue: string;
}

// #7260: "agentivo" é termo de linguística (papel temático do agente numa
// oração), nunca o termo certo num texto sobre sistemas de IA que agem
// sozinhos — o termo do domínio é "agêntico" (de *agentic*). Radical
// "agentiv" cobre as 4 flexões (agentivo/agentiva/agentivos/agentivas) sem
// precisar enumerar cada uma.
export const BANNED_LEXICON: BannedLexiconEntry[] = [
  {
    id: "agentivo-agentico",
    pattern: /\bagentiv[ao]s?\b/gi,
    correct: "agêntico",
    sourceIssue: "#7260",
  },
];

export interface BannedLexiconError {
  id: string;
  correct: string;
  sourceIssue: string;
  line: number;
  /** Trecho exato casado no texto (preserva a capitalização original). */
  matched: string;
  /** Contexto da linha (até 120 chars), pra o editor localizar sem abrir o arquivo. */
  excerpt: string;
}

export interface BannedLexiconReport {
  ok: boolean;
  errors: BannedLexiconError[];
}

/**
 * Varre `md` inteiro (qualquer linha, sem parsing estrutural de seção — a
 * proibição vale em qualquer lugar do documento publicado) contra
 * `BANNED_LEXICON`. GATE-BLOCKING: `ok: false` deve abortar o gate — ver
 * docstring do módulo pra por que (sem exceção legítima conhecida).
 */
export function checkBannedLexicon(md: string): BannedLexiconReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: BannedLexiconError[] = [];

  lines.forEach((line, idx) => {
    for (const entry of BANNED_LEXICON) {
      // `pattern` é global (`g`) — precisa resetar `lastIndex` a cada linha,
      // senão `matchAll` numa regex `g` compartilhada entre iterações do
      // `for` externo acumula estado stale.
      const re = new RegExp(entry.pattern.source, entry.pattern.flags);
      for (const m of line.matchAll(re)) {
        errors.push({
          id: entry.id,
          correct: entry.correct,
          sourceIssue: entry.sourceIssue,
          line: idx + 1,
          matched: m[0],
          excerpt: line.trim().slice(0, 120),
        });
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
