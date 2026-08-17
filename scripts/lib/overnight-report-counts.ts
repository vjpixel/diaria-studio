/**
 * overnight-report-counts.ts (#5521)
 *
 * Confere as contagens do TÍTULO do relatório de overnight/develop contra o
 * conteúdo do próprio `report.md`.
 *
 * ## Por que isto existe
 *
 * O título passado a `register-report.ts` vira o assunto do e-mail que o editor recebe — e é a única parte que ele lê no celular. Até o
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
 * A tabela de unidades do `report.md`, por outro lado, é escrita no fecho,
 * conferida contra o git, e foi a única das três fontes que bateu com a
 * realidade. Ela também é o que o editor vê ao abrir o relatório — então o
 * invariante que interessa é exatamente "assunto == relatório".
 *
 * Este módulo é PURO (string → contagem): sem I/O, sem rede, sem `gh`.
 */

/** Uma linha da tabela de unidades do relatório. */
export interface UnitRow {
  /**
   * Issues cobertas pela unidade (uma linha pode ser um lote).
   * Invariante do produtor (`parseUnitsTable`): sempre não-vazio — linha sem
   * nenhuma referência é descartada como cabeçalho/ruído, nunca vira `UnitRow`.
   */
  issues: number[];
  /** PR que mergeou a unidade, quando a tabela declara um. */
  pr: number | null;
}

export interface ReportCounts {
  units: number;
  issues: number;
}

export interface TitleCounts {
  /** `null` = o título não declara este número (não é erro, só não há o que conferir). */
  units: number | null;
  /** `null` = o título não declara este número. */
  issues: number | null;
}

/** Referência a issue/PR: `#5471` ou, dentro da coluna certa, `5471` cru. */
const REF = /#?(\d{2,6})/g;

export interface UnitsTable {
  /**
   * `true` quando uma tabela de unidades foi ENCONTRADA no documento —
   * independente de quantas linhas deram pra ler.
   *
   * Distinguir isto de `rows.length` é o que impede o guard de virar um no-op
   * silencioso: "relatório sem tabela" (nada a conferir, legítimo) e "tabela
   * presente mas ilegível" (formato mudou, o guard deixou de proteger) são
   * situações opostas que antes colapsavam no mesmo `[]`.
   */
  found: boolean;
  rows: UnitRow[];
}

/**
 * Marcador canônico que precede a tabela de unidades no `report.md`.
 *
 * Comentário HTML: invisível no markdown renderizado e impossível de casar por
 * acaso — diferente de título de seção ou nome de coluna, que variam demais
 * entre rodadas pra servir de âncora.
 *
 * **Por que um marcador explícito, e não detecção por heurística.** Duas
 * versões anteriores deste módulo tentaram adivinhar a tabela a partir da
 * prosa: primeiro pelo título da seção (`## Unidades mergeadas`), que
 * praticamente não se repete nos relatórios reais (`## Resolvidas`, `##
 * Resolvidas (mergeadas)`, `## Destravadas e mergeadas`, ...), deixando o
 * guard dormente; depois pelos nomes das colunas, que casava a tabela errada
 * (em `260811` a coluna rotulada "Issues fechadas" contém DESCRIÇÃO, e as
 * issues estão sob "Unidade"). Rodando a detecção heurística contra os 73
 * relatórios históricos, 12 reprovavam — quase todos off-by-one em linhas
 * genuinamente ambíguas (unidade resolvida ao vivo sem PR, linha "Fase 1.5
 * fixes" que não é issue). Um guard que acusa divergência inexistente ensina o
 * coordenador a contorná-lo, o que é pior do que não existir.
 *
 * Com marcador: zero falso positivo em relatório legado (sem marcador → nada a
 * conferir) e falha ALTA quando o marcador existe mas a tabela não lê (formato
 * quebrou). O custo é o marcador poder ser esquecido — mitigado por
 * `register-report.ts`, que AVISA alto quando um relatório de
 * overnight/develop chega sem ele, em vez de pular calado.
 */
export const UNITS_TABLE_MARKER = "<!-- unidades-mergeadas -->";

/**
 * Localiza a tabela canônica de unidades e extrai suas linhas.
 *
 * Formato esperado — o marcador, depois a tabela (a 1ª coluna traz as issues
 * da unidade, a 2ª o PR):
 *
 * ```
 * <!-- unidades-mergeadas -->
 * | Issue(s) | PR | O quê |
 * |---|---|---|
 * | #5471 | #5473 | ... |
 * | #5472 + #5416 | #5477 | ... |
 * ```
 *
 * Números crus (`5471`, sem `#`) são aceitos — a posição da coluna já resolve a
 * ambiguidade com números soltos da coluna de descrição.
 */
export function parseUnitsTable(markdown: string): UnitsTable {
  const lines = markdown.split(/\r?\n/);
  const markerAt = lines.findIndex((l) => l.trim().toLowerCase() === UNITS_TABLE_MARKER);
  if (markerAt === -1) return { found: false, rows: [] };

  const rows: UnitRow[] = [];
  let seenTable = false;

  for (let i = markerAt + 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line.startsWith("|")) {
      if (seenTable) break; // tabela terminou
      if (line === "") continue; // linha em branco entre marcador e tabela
      break; // qualquer outra coisa: o marcador não precede uma tabela
    }

    seenTable = true;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separador

    const cells = splitRow(line);
    const issues = refsIn(cells[0]);
    if (issues.length === 0) continue; // cabeçalho ou linha sem referência

    const prs = refsIn(cells[1]);
    rows.push({ issues, pr: prs.length > 0 ? prs[0] : null });
  }

  return { found: true, rows };
}

function splitRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function refsIn(cell: string | undefined): number[] {
  if (!cell) return [];
  return [...cell.matchAll(REF)].map((m) => Number(m[1]));
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
 * Só reconhece formas **inequívocas**:
 *   - unidades → `"N unidades"` ou `"N PRs"`
 *   - issues   → `"N issues"`
 *
 * `"N resolvidas"` / `"N mergeadas"` (sem substantivo) são DELIBERADAMENTE
 * ignoradas. A primeira versão deste módulo as lia como unidades, e a
 * convenção real do projeto é o contrário: nos títulos históricos
 * (`data/reports/index.jsonl`) "resolvidas" sempre contou ISSUES — `"28 issues
 * resolvidas (26 PRs)"` deixa explícito que 28 é issue e 26 é unidade. Ler
 * como unidade produzia falso positivo justamente no cenário de lote (mais
 * issues que PRs), que é o que motivou o #5521. Como o termo é genuinamente
 * ambíguo entre rodadas, a escolha aqui é não conferir em vez de conferir
 * errado — um guard que acusa divergência inexistente ensina a ignorá-lo.
 *
 * `null` num campo = o título não declara aquele número.
 */
export function parseTitleCounts(title: string): TitleCounts {
  const num = (re: RegExp): number | null => {
    const m = title.match(re);
    return m ? Number(m[1]) : null;
  };

  return {
    units: num(/(\d+)\s+unidades?\b/i) ?? num(/(\d+)\s+PRs?\b/i),
    issues: num(/(\d+)\s+issues?\b/i),
  };
}

/**
 * Resultado da conferência, como união discriminada — os três desfechos são
 * mutuamente exclusivos e cada um carrega só os campos que fazem sentido nele.
 * Um registro plano com `expected`/`suggestion` opcionais permitiria estados
 * impossíveis (ex: "pulado" com contagem esperada preenchida).
 */
export type TitleCheck =
  /** Nenhuma tabela de unidades no documento — nada a conferir, segue o baile. */
  | { kind: "skipped"; found: TitleCounts }
  /**
   * Tabela ENCONTRADA mas sem nenhuma linha legível. Reprova de propósito: é
   * sinal de que o formato do relatório mudou e o guard parou de proteger.
   * Tratar como `skipped` faria o guard passar em silêncio exatamente quando
   * deixou de funcionar — parecendo protegido sem estar, que é pior do que não
   * existir.
   */
  | { kind: "unreadable"; found: TitleCounts; problems: string[] }
  /** Tabela lida; `problems` vazio = título coerente. */
  | {
      kind: "checked";
      found: TitleCounts;
      expected: ReportCounts;
      problems: string[];
      /** Sufixo canônico derivado da tabela. */
      suggestion: string;
      issuesNote: string;
    };

/** O título passou? (`problems` vazio nos desfechos que conferem algo.) */
export function isTitleOk(check: TitleCheck): boolean {
  return check.kind === "skipped" || check.problems.length === 0;
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
  const table = parseUnitsTable(markdown);
  const found = parseTitleCounts(title);

  if (!table.found) return { kind: "skipped", found };

  if (table.rows.length === 0) {
    return {
      kind: "unreadable",
      found,
      problems: [
        'tabela de unidades encontrada, mas nenhuma linha reconhecida — o formato do relatório mudou e a conferência de contagem deixou de funcionar (esperado: coluna de issue com "#NNNN" e coluna de PR)',
      ],
    };
  }

  const expected = deriveCounts(table.rows);
  const problems: string[] = [];

  if (found.units !== null && found.units !== expected.units) {
    problems.push(
      `título anuncia ${found.units} unidade(s), mas a tabela de unidades tem ${expected.units} linha(s)`,
    );
  }
  if (found.issues !== null && found.issues !== expected.issues) {
    problems.push(
      `título anuncia ${found.issues} issue(s), mas a tabela cobre ${expected.issues} issue(s) distinta(s)`,
    );
  }

  return {
    kind: "checked",
    found,
    expected,
    problems,
    suggestion: `${expected.units} unidades, ${expected.issues} issues`,
    issuesNote:
      "a tabela conta issues ENDEREÇADAS; se alguma ficou aberta (escopo residual), diga isso no título em vez de baixar o número em silêncio",
  };
}
