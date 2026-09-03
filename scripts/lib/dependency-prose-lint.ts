/**
 * scripts/lib/dependency-prose-lint.ts (#7137 item 4)
 *
 * Guard de AUDITORIA (não bloqueia nada — ver `scripts/check-dependency-prose-lint.ts`
 * pra onde/como isto roda): casa prosa de dependência entre issues
 * ("pré-requisito", "depende do #N", "depois que #N", "só depois") contra o
 * corpo de issues abertas que NÃO carregam o marcador estruturado
 * `<!-- depends-on: #N -->` (`scripts/lib/issue-depends-on.ts`).
 *
 * ─── O incidente que motivou (mesmo da #7137, item 4 do escopo) ───────────
 *
 * Ao escrever as 17 issues-filhas do #7112, a própria sessão que abriu a
 * #7137 declarou dependências em PROSA — "depende do #7113", "só depois do
 * #6798", "etapa 1 antes da etapa 2" — sem usar o marcador que o item 2 da
 * mesma issue construiu. `classifyExecTrack` não lê prosa; as 17 nasceram
 * `overnight` por default, elegíveis pra uma rodada pegar fora de ordem.
 * O erro foi cometido por quem estava, no mesmo instante, escrevendo a
 * issue *sobre* esse problema — evidência de que revisão manual sozinha não
 * basta; precisa de um lint que rode em toda issue aberta, sempre.
 *
 * ─── O que este módulo NÃO é ────────────────────────────────────────────
 *
 * Mesma filosofia de `scripts/lib/decision-label-drift.ts` (#5589): não é
 * NLP, é casamento de regex contra um catálogo pequeno de frases-gatilho
 * observadas ao vivo, com precisão baixa DE PROPÓSITO — falso positivo
 * custa uma linha de achado ignorada pelo coordenador; falso negativo é a
 * mesma lacuna que este módulo existe pra reduzir. Não tenta decidir QUAL
 * issue é a dependência real (não extrai o número referenciado na prosa
 * pra sugerir automaticamente o marcador) — quem lê o achado decide se é
 * dependência genuína (adiciona `depends-on:`) ou falso positivo (ignora).
 *
 * ─── Por que isto NUNCA bloqueia (ao contrário do gate de drift de label) ──
 *
 * `check-decision-label-drift-gate.ts` bloqueia a compilação do relatório
 * porque a correção de um achado é MECÂNICA e sem ambiguidade: aplicar a
 * label estrutural específica que o padrão já nomeia. Aqui a correção
 * exige JULGAMENTO — decidir se a prosa casada é de fato uma dependência
 * declarada (e, se for, QUAL número de issue vai no marcador) ou uma frase
 * comum sem relação nenhuma ("antes de publicar", "depende do resultado do
 * teste"). Nenhum mecanismo aqui infere isso com segurança — forçar um
 * gate bloqueante sobre uma heurística ambígua trocaria "issue presa por
 * falta de marcador" (o incidente original) por "rodada presa por causa de
 * uma frase comum sem relação com dependência nenhuma" (pior). Por isso o
 * CLI (`check-dependency-prose-lint.ts`) é sempre AUDITORIA — roda
 * automaticamente (armado, não follow-up — item 1 da #7137), imprime
 * achados no relatório da rodada, nunca sai com `exit 1`.
 *
 * ─── Dedup ───────────────────────────────────────────────────────────────
 *
 * No máximo 1 achado por issue — o primeiro padrão do catálogo que casar,
 * na ordem declarada. Uma issue pode citar duas frases-gatilho diferentes
 * (ex: "pré-requisito" e "só depois"); reportar as duas não muda a ação
 * corretiva (adicionar o marcador cobre ambas), só infla a lista.
 *
 * Puro: sem I/O, sem rede, sem `gh` — recebe number+body já buscados.
 *
 * @see scripts/lib/issue-depends-on.ts (parseDependsOn, o marcador que este módulo cobra a ausência de)
 * @see scripts/lib/decision-label-drift.ts (stripHtmlComments, mesmo padrão de catálogo regex + docstring)
 * @see scripts/check-dependency-prose-lint.ts (CLI)
 * @see context/overnight-dispatch-rules.md item 26 (onde o coordenador roda isto)
 */

import { stripHtmlComments } from "./decision-label-drift.ts";
import { parseDependsOn } from "./issue-depends-on.ts";

/** Um padrão de prosa de dependência, e a frase-gatilho que o identifica. */
export interface DependencyProsePattern {
  /** Identificador estável — aparece no output do CLI e nos testes. */
  id: string;
  /** Explicação curta do que o padrão detecta, pro output do CLI. */
  description: string;
  re: RegExp;
}

/**
 * Catálogo extraído literalmente das frases-gatilho citadas no corpo da
 * #7137 como exemplo do próprio incidente que a issue documenta ("depende
 * do #7113", "só depois do #6798", "etapa 1 antes da etapa 2",
 * "pré-requisitos explícitos"). Cada padrão roda isoladamente contra o
 * corpo (com marcadores HTML já removidos) — casamento é `RegExp.exec`
 * simples, sem lookaround complexo, pra manter o catálogo legível e fácil
 * de estender.
 */
export const DEPENDENCY_PROSE_PATTERNS: readonly DependencyProsePattern[] = [
  {
    id: "prerequisito",
    description: '"pré-requisito"/"pre-requisito" (com ou sem hífen/acento)',
    re: /pr[ée]-?requisito/i,
  },
  {
    id: "depende-de",
    description: '"depende do/da #N" ou "dependia do/da #N"',
    re: /depend(?:e|ia)\s+(?:d[eo]|da)\s+#?\d+/i,
  },
  {
    id: "so-depois",
    description: '"só depois" / "somente depois"',
    re: /s[óo](?:mente)?\s+depois/i,
  },
  {
    id: "depois-de-issue",
    description: '"depois que #N" / "depois d[eoa] #N" — referenciando issue',
    re: /depois\s+(?:que\s+)?(?:d[eo]|da)?\s*#\d+/i,
  },
  {
    id: "antes-de-issue",
    description: '"antes d[eoa] #N" — referenciando issue',
    re: /antes\s+d[eoa]?\s+#\d+/i,
  },
];

/** Um achado: uma issue aberta cita prosa de dependência sem carregar o
 * marcador `depends-on:` que cobriria a declaração. */
export interface DependencyProseFinding {
  issueNumber: number;
  patternId: string;
  description: string;
  /** Trecho do corpo (marcadores já removidos) em torno do match. */
  excerpt: string;
}

const EXCERPT_RADIUS = 60;

function buildExcerpt(prose: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - EXCERPT_RADIUS);
  const end = Math.min(prose.length, match.index + match[0].length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < prose.length ? "…" : "";
  return `${prefix}${prose.slice(start, end).trim().replace(/\s+/g, " ")}${suffix}`;
}

/**
 * Varre um conjunto de issues (já buscadas) e reporta as que citam prosa de
 * dependência SEM nenhum marcador `depends-on:` válido no corpo. Issue com
 * marcador presente (mesmo declarando uma dependência diferente da citada
 * em prosa) nunca gera achado — checagem simples de "existe o marcador?",
 * não de "o marcador cobre a mesma dependência que a prosa cita" (mesma
 * simplicidade deliberada do escopo original da #7137 item 4).
 */
export function detectDependencyProseWithoutMarker(
  issues: ReadonlyArray<{ number: number; body: string | null }>,
): DependencyProseFinding[] {
  const findings: DependencyProseFinding[] = [];
  for (const issue of issues) {
    const rawBody = issue.body ?? "";
    if (parseDependsOn(rawBody, issue.number).length > 0) continue; // já declarado
    const stripped = stripHtmlComments(rawBody);
    for (const pattern of DEPENDENCY_PROSE_PATTERNS) {
      // Nova instância a cada issue — evita estado de `lastIndex` vazado
      // caso um padrão ganhe a flag `g` no futuro (nenhum tem hoje).
      const re = new RegExp(pattern.re.source, pattern.re.flags);
      const match = re.exec(stripped);
      if (match) {
        findings.push({
          issueNumber: issue.number,
          patternId: pattern.id,
          description: pattern.description,
          excerpt: buildExcerpt(stripped, match),
        });
        break; // 1 achado por issue (dedup) — o 1º padrão do catálogo que casar
      }
    }
  }
  return findings;
}
