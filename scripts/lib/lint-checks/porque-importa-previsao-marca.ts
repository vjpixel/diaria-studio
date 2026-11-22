/**
 * lint-checks/porque-importa-previsao-marca.ts (#13766)
 *
 * WARN-ONLY: limite de frequência da marca de previsão do #11073 ("tende(m) a",
 * "à medida que"). Decisão do editor (briefing do overnight 261121b, opção 3 da
 * #13766): no máximo 1 marca por destaque, e só no "Por que isso importa",
 * nunca no corpo. Medição da #13766 (22 edições, 261019 a 261119): o editor
 * removeu a marca em 16 de 26 destaques que a traziam.
 *
 * A marca continua sendo o que o fact-checker reconhece como inferência
 * editorial (não muda a lista de marcadores, só a frequência). Warn-only: o
 * texto no gate 4 já pode ser do editor (#7401), e o aviso só informa.
 *
 * Escopo: blocos `**DESTAQUE N | ...**` (D1/D2/D3). O bloco vai do cabeçalho
 * até o fim do parágrafo do "Por que isso importa:" (ou até o próximo
 * cabeçalho de destaque). Corpo = tudo entre o cabeçalho e o rótulo "Por que
 * isso importa:", menos as linhas de título (linha inteira em negrito, #13827).
 * O parágrafo do "Por que" é a cauda na mesma linha do rótulo + as linhas
 * seguintes do mesmo parágrafo; com o rótulo sozinho na linha, é o primeiro
 * parágrafo não-vazio seguinte. Um `---` dentro do corpo só encerra o
 * destaque quando o "Por que" dele não vem antes do próximo cabeçalho de
 * destaque ou de seção (#13827). RADAR, USE MELHOR, "Aprofunde:" e demais
 * seções ficam fora.
 *
 * Marcas reconhecidas (#13827): "tende(m) a/à/ao/às/aos", "tenderá(ão) a/...",
 * "à medida que" / "a medida que".
 */

/**
 * Sem flag `g` de propósito (#13827): regex exportada com `g` carrega estado em
 * `lastIndex`, e um `.test()` de outro módulo alternaria o resultado entre
 * chamadas. Quem precisa varrer o texto inteiro usa `countPrevisaoMarcas`.
 */
export const PREVISAO_MARCA_RE =
  /(?<![\p{L}\p{N}_])(?:tend(?:e|em|er[áa]|er[ãa]o)\s+(?:a|à|ao|às|aos)|[àa]\s+medida\s+que)(?![\p{L}\p{N}_])/iu;

export interface PrevisaoMarcaWarning {
  /** Número do destaque (1-based, do cabeçalho). */
  destaque: number;
  /** "corpo" = marca fora do "Por que isso importa"; "excesso" = mais de 1 no destaque. */
  kind: "corpo" | "excesso";
  /** Linha (1-based) do cabeçalho do destaque. */
  line: number;
  /** Quantas marcas no corpo / no destaque inteiro. */
  count: number;
}

export interface PrevisaoMarcaReport {
  ok: boolean;
  warnings: PrevisaoMarcaWarning[];
}

const DESTAQUE_HEADER_RE = /^\s*(?:\*\*)?DESTAQUE\s+(\d+)\b/i;
const WHY_HEADER_RE = /^\s*Por que isso importa:\s*(.*)$/i;
const SEPARATOR_RE = /^\s*---\s*$/;
/** Linha inteira em negrito: opção de título (`**[T](url)**`) ou cabeçalho de seção (`**RADAR**`). */
const BOLD_LINE_RE = /^\s*\*\*.+\*\*\s*$/;
/** Cabeçalho de seção: linha inteira em negrito que não é link (`**🚀 LANÇAMENTOS**`). */
const SECTION_HEADER_RE = /^\s*\*\*(?!\[).+\*\*\s*$/;

export function countPrevisaoMarcas(text: string): number {
  return [...text.matchAll(new RegExp(PREVISAO_MARCA_RE.source, PREVISAO_MARCA_RE.flags + "g"))].length;
}

/** O "Por que isso importa" deste destaque ainda vem depois do `---` em `sep`? */
function whyComesAfterSeparator(lines: string[], sep: number): boolean {
  for (let k = sep + 1; k < lines.length; k++) {
    if (DESTAQUE_HEADER_RE.test(lines[k]) || SECTION_HEADER_RE.test(lines[k])) return false;
    if (WHY_HEADER_RE.test(lines[k])) return true;
  }
  return false;
}

/** Linhas não-vazias contíguas a partir de `start`, até linha em branco, `---`, cabeçalho ou novo rótulo. */
function collectParagraph(lines: string[], start: number): { text: string[]; end: number } {
  const text: string[] = [];
  let k = start;
  while (
    k < lines.length &&
    lines[k].trim() &&
    !SEPARATOR_RE.test(lines[k]) &&
    !DESTAQUE_HEADER_RE.test(lines[k]) &&
    !WHY_HEADER_RE.test(lines[k])
  ) {
    text.push(lines[k].trim());
    k++;
  }
  return { text, end: k };
}

export function checkPorqueImportaPrevisaoMarca(md: string): PrevisaoMarcaReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const warnings: PrevisaoMarcaWarning[] = [];

  for (let i = 0; i < lines.length; i++) {
    const h = DESTAQUE_HEADER_RE.exec(lines[i]);
    if (!h) continue;
    const destaque = Number(h[1]);
    const headerLine = i + 1;

    const corpo: string[] = [];
    let why = "";
    let j = i + 1;
    let sawWhy = false;
    for (; j < lines.length; j++) {
      if (DESTAQUE_HEADER_RE.test(lines[j])) break;
      const w = WHY_HEADER_RE.exec(lines[j]);
      if (w) {
        sawWhy = true;
        const tail = w[1].trim();
        if (tail) {
          // #13827: a cauda pode continuar nas linhas seguintes do mesmo parágrafo.
          const cont = collectParagraph(lines, j + 1);
          why = [tail, ...cont.text].join(" ");
          j = cont.end;
        } else {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          const para = collectParagraph(lines, k);
          why = para.text.join(" ");
          j = para.end;
        }
        break;
      }
      if (SEPARATOR_RE.test(lines[j])) {
        // #13827: `---` no meio do corpo não encerra o destaque se o "Por que"
        // dele ainda vem antes do próximo cabeçalho.
        if (whyComesAfterSeparator(lines, j)) continue;
        break;
      }
      // #13827: opção de título (linha inteira em negrito) não é corpo.
      if (BOLD_LINE_RE.test(lines[j])) continue;
      corpo.push(lines[j]);
    }
    // Destaque sem "Por que isso importa" (fora do formato): só o corpo conta.
    const corpoCount = countPrevisaoMarcas(corpo.join("\n"));
    const whyCount = sawWhy ? countPrevisaoMarcas(why) : 0;

    if (corpoCount > 0) {
      warnings.push({ destaque, kind: "corpo", line: headerLine, count: corpoCount });
    }
    if (corpoCount + whyCount > 1) {
      warnings.push({ destaque, kind: "excesso", line: headerLine, count: corpoCount + whyCount });
    }
    i = Math.max(i, j - 1);
  }

  return { ok: warnings.length === 0, warnings };
}
