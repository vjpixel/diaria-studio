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
 * cabeçalho de destaque / `---`). Corpo = tudo entre o cabeçalho e o rótulo
 * "Por que isso importa:"; o parágrafo do "Por que" é a cauda na mesma linha
 * do rótulo + o primeiro parágrafo não-vazio seguinte. RADAR, USE MELHOR e
 * demais seções ficam fora.
 */

export const PREVISAO_MARCA_RE =
  /(?<![\p{L}\p{N}_])(?:tende(?:m)? a|[àa] medida que)(?![\p{L}\p{N}_])/giu;

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

export function countPrevisaoMarcas(text: string): number {
  return [...text.matchAll(new RegExp(PREVISAO_MARCA_RE.source, PREVISAO_MARCA_RE.flags))].length;
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
          why = tail;
          j++;
        } else {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          const para: string[] = [];
          while (
            k < lines.length &&
            lines[k].trim() &&
            !SEPARATOR_RE.test(lines[k]) &&
            !DESTAQUE_HEADER_RE.test(lines[k]) &&
            !WHY_HEADER_RE.test(lines[k])
          ) {
            para.push(lines[k].trim());
            k++;
          }
          why = para.join(" ");
          j = k;
        }
        break;
      }
      if (SEPARATOR_RE.test(lines[j])) break;
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
