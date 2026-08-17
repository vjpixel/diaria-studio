/**
 * overnight-report-counts.ts (#5521)
 *
 * Confere as contagens do TÍTULO do relatório de overnight/develop contra o
 * conteúdo do próprio `report.md`.
 *
 * ## Por que isto existe
 *
 * O título passado a `register-report.ts` vira, sem transformação, o assunto do
 * e-mail que o editor recebe — e é a única parte que ele lê no celular. Até o
 * #5521 esse título era digitado à mão pelo coordenador, em prosa, sem nada que
 * o amarrasse ao relatório que ele acompanha.
 *
 * Achado que motivou o módulo (rodada 260816e, 17/08/2026): o assunto anunciou
 * `10 unidades, 13 issues fechadas` enquanto o MESMO documento trazia
 * `**Implementação** (13 unidades)`, uma tabela "Unidades mergeadas" com 13
 * linhas e a frase `Todos os 13 PRs: CI verde`. As 13 unidades cobriam 17
 * issues, das quais 16 fecharam (o relatório registrava corretamente que #5416
 * ficava aberta). Ou seja: nem o número de unidades nem o de issues batia, e o
 * mesmo valor (13) aparecia nos dois campos com significados diferentes —
 * assinatura de carry-over entre os dois slots.
 *
 * ## Por que a tabela do relatório, e não `plan.json`
 *
 * `plan.json` seria a fonte natural, mas na mesma rodada ele estava DEFASADO:
 * marcava 11 issues `mergeada` / 8 PRs distintos, enquanto o git registrava 13
 * merges (faltavam #5427, #5474, #5476, #5484, #5489, #5490 — o coordenador
 * parou de atualizar o plano no meio da rodada). Ancorar no `plan.json`
 * validaria o título contra uma terceira contagem, também errada.
 *
 * A tabela "Unidades mergeadas" do `report.md`, por outro lado, é escrita no
 * fecho, conferida contra o git, e foi a única das três fontes que bateu com a
 * realidade. Ela também é o que o editor vê ao abrir o relatório — então o
 * invariante que interessa é exatamente "assunto == relatório".
 *
 * Este módulo é PURO (string → contagem): sem I/O, sem rede, sem `gh`.
 */

/** Uma linha da tabela "Unidades mergeadas" do relatório. */
export interface UnitRow {
  /** Issues cobertas pela unidade (uma linha pode ser um lote). */
  issues: number[];
  /** PR que mergeou a unidade, quando a tabela declara um. */
  pr: number | null;
}

export interface ReportCounts {
  units: number;
  issues: number;
}

export interface TitleCounts {
  units: number | null;
  issues: number | null;
}

/**
 * Cabeçalho da seção que este módulo lê. Casado sem acento-sensibilidade
 * estrita nem nível fixo de `#` — o formato do relatório é prosa de agente e
 * varia entre rodadas.
 */
const UNITS_SECTION = /^#{1,6}\s*unidades\s+mergeadas\s*$/i;

/** Qualquer `#NNNN` (issue ou PR). */
const REF = /#(\d{2,6})/g;

/**
 * Extrai as linhas da tabela "Unidades mergeadas".
 *
 * Formato esperado (o que o SKILL do overnight produz):
 *
 * ```
 * ## Unidades mergeadas
 *
 * | Issue(s) | PR | O quê |
 * |---|---|---|
 * | #5471 | #5473 | ... |
 * | #5472 + #5416 | #5477 | ... |
 * ```
 *
 * Tolerante por desenho: a linha de cabeçalho e a de separador são descartadas,
 * e uma tabela com colunas em ordem/nome diferentes ainda funciona desde que a
 * 1ª coluna traga as issues e a 2ª o PR. Seção ausente → lista vazia, e o
 * chamador decide se isso é erro (ver `compareTitleWithReport`).
 */
export function parseUnitsTable(markdown: string): UnitRow[] {
  const lines = markdown.split(/\r?\n/);

  let i = lines.findIndex((l) => UNITS_SECTION.test(l.trim()));
  if (i === -1) return [];

  const rows: UnitRow[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i].trim();

    // Próxima seção encerra a tabela.
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;

    // Separador markdown (|---|---|).
    if (/^\|[\s:|-]+\|$/.test(line)) continue;

    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;

    const issues = [...cells[0].matchAll(REF)].map((m) => Number(m[1]));
    // Cabeçalho ("| Issue(s) | PR | O quê |") não tem nenhuma referência.
    if (issues.length === 0) continue;

    const prMatch = [...cells[1].matchAll(REF)].map((m) => Number(m[1]));
    rows.push({ issues, pr: prMatch.length > 0 ? prMatch[0] : null });
  }

  return rows;
}

/**
 * Contagens canônicas derivadas da tabela.
 *
 * - `units` = linhas da tabela (um lote é UMA unidade, é assim que a tabela e o
 *   custo em tokens já são organizados).
 * - `issues` = issues DISTINTAS cobertas por todas as linhas. Distintas porque
 *   uma issue pode legitimamente aparecer em duas linhas (escopo residual
 *   retomado por outra unidade) sem virar duas issues.
 *
 * Ressalva deliberada: isto conta issues ENDEREÇADAS, não necessariamente
 * fechadas — o relatório do 260816e listava #5416 numa linha e dizia no texto
 * que ela ficava aberta. Confirmar fechamento exigiria `gh` (rede) e tornaria
 * este módulo não-puro; o campo `issuesNote` de `compareTitleWithReport`
 * carrega esse aviso pro chamador em vez de fingir precisão que não temos.
 */
export function deriveCounts(rows: UnitRow[]): ReportCounts {
  const issues = new Set<number>();
  for (const r of rows) for (const n of r.issues) issues.add(n);
  return { units: rows.length, issues: issues.size };
}

/**
 * Lê os números anunciados no título.
 *
 * Aceita as formas que o overnight/develop usam na prática:
 *   "— 10 unidades, 13 issues fechadas (2 P1), 2 reviews limpos"
 *   "— 12 resolvidas, 19 puladas, 0 findings"
 *   "— 3 PRs mergeadas (P0 + refactor grande), 6 issues avançadas"
 *
 * `null` num campo = o título não declara aquele número (não é erro; só não há
 * o que conferir). "resolvidas"/"mergeadas" sem substantivo de unidade contam
 * como UNIDADES — é como o título histórico sempre foi lido.
 */
export function parseTitleCounts(title: string): TitleCounts {
  const num = (re: RegExp): number | null => {
    const m = title.match(re);
    return m ? Number(m[1]) : null;
  };

  const issues = num(/(\d+)\s+issues?\b/i);
  const units =
    num(/(\d+)\s+unidades?\b/i) ??
    num(/(\d+)\s+PRs?\b/i) ??
    num(/(\d+)\s+(?:resolvidas?|mergeadas?)\b/i);

  return { units, issues };
}

export interface TitleCheck {
  ok: boolean;
  /** `true` quando o relatório não traz a tabela — nada a conferir. */
  skipped: boolean;
  expected: ReportCounts | null;
  found: TitleCounts;
  /** Divergências em texto, prontas pra stderr. */
  problems: string[];
  /** Sufixo canônico sugerido, derivado da tabela. */
  suggestion: string | null;
  issuesNote: string | null;
}

/**
 * Confere título × relatório.
 *
 * Só reprova o que é CONTRADIÇÃO verificável: um número declarado no título que
 * diverge do que a tabela do relatório mostra. Título que simplesmente não
 * declara um dos números passa — a política aqui é impedir que o assunto minta,
 * não obrigar um formato único de assunto.
 */
export function compareTitleWithReport(title: string, markdown: string): TitleCheck {
  const rows = parseUnitsTable(markdown);
  const found = parseTitleCounts(title);

  if (rows.length === 0) {
    return {
      ok: true,
      skipped: true,
      expected: null,
      found,
      problems: [],
      suggestion: null,
      issuesNote: null,
    };
  }

  const expected = deriveCounts(rows);
  const problems: string[] = [];

  if (found.units !== null && found.units !== expected.units) {
    problems.push(
      `título anuncia ${found.units} unidade(s), mas a tabela "Unidades mergeadas" tem ${expected.units} linha(s)`,
    );
  }
  if (found.issues !== null && found.issues !== expected.issues) {
    problems.push(
      `título anuncia ${found.issues} issue(s), mas a tabela cobre ${expected.issues} issue(s) distinta(s)`,
    );
  }

  return {
    ok: problems.length === 0,
    skipped: false,
    expected,
    found,
    problems,
    suggestion: `${expected.units} unidades, ${expected.issues} issues`,
    issuesNote:
      "a tabela conta issues ENDEREÇADAS; se alguma ficou aberta (escopo residual), diga isso no título em vez de baixar o número em silêncio",
  };
}
