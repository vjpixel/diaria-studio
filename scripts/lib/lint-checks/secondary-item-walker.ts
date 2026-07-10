/**
 * lint-checks/secondary-item-walker.ts (#3242)
 *
 * Máquina de estados compartilhada para iterar itens de seção secundária
 * (LANÇAMENTOS/RADAR/USE MELHOR/PESQUISAS legado/OUTRAS NOTÍCIAS legado),
 * extraindo título+descrição de cada item. Extraída porque a mesma lógica de
 * boundary-parsing (detecção da seção alvo, encerramento de seção via
 * qualquer header real/`---`/DESTAQUE, e os 2 formatos suportados — inline
 * canônico `**[Título](URL)** Descrição` e legado de 2 linhas) estava
 * duplicada quase byte-a-byte em 4 lints:
 *   - secondary-items-have-summary.ts (#2545, original)
 *   - no-trailing-ellipsis.ts (#2881)
 *   - mid-sentence-ellipsis.ts (#3196)
 *   - no-untranslated-summary.ts (#3196)
 *
 * Fixes de bug no boundary-parsing (ex: #2918's lista de headers que fecham
 * seção) tiveram que ser aplicados em múltiplos lugares — este helper
 * garante que o próximo fix (ou o próximo lint que precisar da mesma
 * varredura) só precisa tocar um lugar.
 *
 * DIVERGÊNCIA REAL preservada de propósito (investigação #3242 confirmou que
 * NÃO é possível colapsar os 4 arquivos numa única regex/algoritmo sem mudar
 * comportamento testado):
 *
 *   1. Conjunto de headers que ENCERRAM uma seção alvo (`closingHeaderRe`):
 *      secondary-items-have-summary.ts (#2545) usa um conjunto mais estreito
 *      — sem É IA?/ERRO INTENCIONAL/SORTEIO/PARA ENCERRAR — anterior ao fix
 *      #2918 bug 2 que ampliou o conjunto nos outros 3 lints. Nunca foi
 *      retroportado pro arquivo original; preservado aqui via
 *      `legacyClosingHeaders` em vez de silenciosamente "corrigido" (esse
 *      refactor é comportamento-idêntico, não um bugfix).
 *
 *   2. Regex usada pra decidir, no lookahead de um título solo, se a PRÓXIMA
 *      linha não-vazia é ELA PRÓPRIA outro item (portanto o item atual não
 *      tem descrição) — `nextLineIsItemRe`:
 *        - no-trailing-ellipsis/mid-sentence-ellipsis/no-untranslated-summary
 *          não têm esse conceito (nunca detectam AUSÊNCIA de descrição, só
 *          avaliam conteúdo de descrições que existem) — usam o default
 *          amplo (`SAME_LINE_ITEM_RE`, tolera 0-2 asteriscos). Esse default
 *          só governa o lookahead acima — a detecção "esta linha corrente É
 *          um item inline" (branch abaixo, `raw.match(SAME_LINE_ITEM_RE)`)
 *          NÃO é parametrizada por essa opção, é sempre `SAME_LINE_ITEM_RE`
 *          pros 4 consumidores atuais (ver divergência 3).
 *        - secondary-items-have-summary.ts (#2545) PRECISA de uma regex mais
 *          restrita (só bold `**...**` nos dois lados) — regressão #2579:
 *          uma descrição que COMEÇA com um link markdown sem bold (ex:
 *          `[Fonte](url) explica que...`) é uma descrição válida do item
 *          anterior, não um novo item. Usar a regex ampla aqui faria esse
 *          caso ser mal-atribuído e o item anterior seria falso-positivo
 *          "sem descrição". Ver `BOLDED_ITEM_ONLY_RE` em
 *          secondary-items-have-summary.ts.
 *
 *   3. NÃO-divergência assumida deliberadamente: o formato inline
 *      `**[Título](URL)** Descrição` de secondary-items-have-summary.ts
 *      (pré-refactor) usava uma URL SEM tolerância a parênteses balanceados
 *      (`[^\s)]+`), mais estreita que a versão corrigida em #2918 bug 3
 *      (`URL_WITH_BALANCED_PARENS_RE_PART`, já usada pelos outros 3 lints).
 *      Esse refactor unificou pra `SAME_LINE_ITEM_RE` (com o fix) pros 4
 *      consumidores — inerte pra secondary-items-have-summary.ts hoje (esse
 *      arquivo não passa `onFound`, só `onMissing`, então o único efeito
 *      observável de matching "esta linha é um item inline" é um `continue`
 *      silencioso de qualquer forma) mas é uma mudança real de qual branch
 *      roda internamente — documentado aqui em vez de deixar implícito.
 *
 * Formato de emissão: o walker chama `onFound` para cada item cuja
 * descrição foi encontrada (inline ou 2-linhas) e `onMissing` para cada
 * título solo cuja próxima linha não-vazia NÃO é uma descrição válida
 * (usado só por secondary-items-have-summary.ts — os outros 3 não passam
 * `onMissing`).
 */

import { sectionHeaderRegex, ALL_SECTION_NAMES_PATTERN } from "../section-naming.ts";
import {
  INLINE_LINK_ONLY_RE,
  URL_WITH_BALANCED_PARENS_RE_PART,
} from "./section-item-format.ts";

// Seções cujos itens têm descrição — escopo idêntico nos 4 lints.
export const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Conjunto LEGADO (pré-#2918 bug 2): usado só por
// secondary-items-have-summary.ts (#2545) — ver nota de divergência 1 acima.
// `ALL_SECTION_NAMES_PATTERN` (section-naming.ts) já é EXATAMENTE esse
// conjunto (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS/PESQUISAS/OUTRAS NOTÍCIAS) —
// reusa em vez de re-digitar (#3242 code-review: 2 cópias hand-typed do
// mesmo conjunto de nomes já causaram drift real uma vez, #2918 bug 2).
const LEGACY_CLOSING_NAMES = ALL_SECTION_NAMES_PATTERN;

// Conjunto AMPLO (#2918 bug 2): qualquer header de seção real — o legado
// acima MAIS É IA? / ERRO INTENCIONAL / SORTEIO / PARA ENCERRAR — encerra o
// scan da seção alvo. Usado por no-trailing-ellipsis / mid-sentence-ellipsis
// / no-untranslated-summary (default deste módulo).
const BROAD_CLOSING_NAMES = `${ALL_SECTION_NAMES_PATTERN}|${String.raw`[ÉE]\s+IA\?|ERRO INTENCIONAL|SORTEIO|PARA ENCERRAR`}`;

export const ANY_SECTION_HEADER_RE = sectionHeaderRegex(BROAD_CLOSING_NAMES, {
  capture: "none",
  flags: "u",
});
export const LEGACY_ANY_SECTION_HEADER_RE = sectionHeaderRegex(LEGACY_CLOSING_NAMES, {
  capture: "none",
  flags: "u",
});

export const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+\d+/;

/**
 * Item com título + descrição na MESMA linha (formato canônico):
 * `**[Título](URL)** Descrição...`. Grupo 1 = título, grupo 2 = descrição.
 *
 * #2918 bug 3: URL tolera 1 nível de parênteses balanceados no path (ex:
 * Wikipedia `..._(disambiguation)`) via URL_WITH_BALANCED_PARENS_RE_PART —
 * mesma fonte que INLINE_LINK_ONLY_RE (section-item-format.ts).
 */
export const SAME_LINE_ITEM_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[([^\]]+)\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(\S.*)$`,
);

export interface SecondaryItemFound {
  section: string;
  /** Linha (1-based) do título. Igual a `descriptionLine` no formato inline. */
  titleLine: number;
  /** Linha (1-based) da descrição. Igual a `titleLine` no formato inline. */
  descriptionLine: number;
  /** Texto do título — sem colchetes/bold no formato inline (grupo capturado); raw trimmed no formato 2-linhas. */
  title: string;
  /** Texto da descrição, já trimmed. */
  description: string;
  /** true = título+descrição na mesma linha; false = formato legado 2-linhas. */
  inline: boolean;
}

export interface SecondaryItemMissing {
  section: string;
  /** Linha (1-based) do título solo sem descrição. */
  titleLine: number;
  /** Raw trimmed do título (com colchetes/bold, como aparece no MD). */
  title: string;
}

export interface SecondaryItemWalkerOptions {
  /**
   * Regex usada pra reconhecer QUALQUER header de seção real, que encerra a
   * seção alvo corrente — ver nota de divergência 1 no topo do arquivo.
   * Default `ANY_SECTION_HEADER_RE` (conjunto amplo). O único caller que
   * precisa de outro valor (secondary-items-have-summary.ts, #2545) passa
   * `LEGACY_ANY_SECTION_HEADER_RE` explicitamente — RegExp injetado em vez
   * de flag booleana pra manter as 2 opções de override (esta e
   * `nextLineIsItemRe`) na mesma forma.
   */
  closingHeaderRe?: RegExp;
  /**
   * Regex usada pra decidir se a PRÓXIMA linha não-vazia após um título solo
   * é, ela própria, outro item — ver nota de divergência 2 no topo do
   * arquivo. Só afeta esse lookahead (não afeta a detecção "esta linha
   * corrente é um item inline", sempre `SAME_LINE_ITEM_RE` — ver nota 3).
   * Default `SAME_LINE_ITEM_RE`.
   */
  nextLineIsItemRe?: RegExp;
  /** Chamado para cada item cuja descrição foi encontrada. */
  onFound?: (item: SecondaryItemFound) => void;
  /** Chamado para cada título solo sem descrição válida. */
  onMissing?: (item: SecondaryItemMissing) => void;
}

/**
 * Varre `md` linha a linha, rastreando a seção secundária alvo corrente, e
 * chama `onFound`/`onMissing` (via `opts`) para cada item detectado.
 */
export function forEachSecondaryItem(md: string, opts: SecondaryItemWalkerOptions = {}): void {
  const closingHeaderRe = opts.closingHeaderRe ?? ANY_SECTION_HEADER_RE;
  const nextLineIsItemRe = opts.nextLineIsItemRe ?? SAME_LINE_ITEM_RE;

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Detectar seção alvo
    if (TARGET_SECTION_RE.test(t)) {
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      continue;
    }

    // Qualquer outro header de seção encerra a seção alvo
    if (closingHeaderRe.test(t)) {
      currentSection = null;
      continue;
    }

    // Separador `---` encerra seção
    if (t === "---") {
      currentSection = null;
      continue;
    }

    // Seção DESTAQUE também encerra
    if (DESTAQUE_HEADER_RE.test(t)) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Formato inline: link + descrição na MESMA linha.
    const inlineMatch = raw.match(SAME_LINE_ITEM_RE);
    if (inlineMatch) {
      opts.onFound?.({
        section: currentSection,
        titleLine: i + 1,
        descriptionLine: i + 1,
        title: inlineMatch[1],
        description: inlineMatch[2].trim(),
        inline: true,
      });
      continue;
    }

    // Título sozinho na linha — lookahead pra próxima linha não-vazia.
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;

      const noDescription =
        j >= lines.length || // EOF
        INLINE_LINK_ONLY_RE.test(lines[j]) || // próxima é outro título solo
        nextLineIsItemRe.test(lines[j]) || // próxima é outro item (regex configurável)
        closingHeaderRe.test(lines[j].trim()) || // próxima é header
        DESTAQUE_HEADER_RE.test(lines[j].trim()) || // próxima é DESTAQUE
        lines[j].trim() === "---"; // próxima é separador

      if (noDescription) {
        opts.onMissing?.({ section: currentSection, titleLine: i + 1, title: t });
      } else {
        opts.onFound?.({
          section: currentSection,
          titleLine: i + 1,
          descriptionLine: j + 1,
          title: t,
          description: lines[j].trim(),
          inline: false,
        });
      }
    }
  }
}
