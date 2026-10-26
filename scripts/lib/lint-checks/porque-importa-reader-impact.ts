/**
 * lint-checks/porque-importa-reader-impact.ts (#11073)
 *
 * WARN-ONLY: flagra o parágrafo "Por que isso importa:" que só descreve o
 * achado/risco, sem nenhuma referência ao leitor ou ao impacto atual/futuro
 * (estilo B, decisão do editor 261026 — ver context/editorial-rules.md §"Foco
 * do Por que isso importa").
 *
 * Heurística deliberadamente larga (aviso, nunca bloqueia): o parágrafo passa
 * se contiver QUALQUER marcador de efeito sobre o leitor ou de tendência:
 * "tende(m) a", "à medida que", "quem", "você", "leitor", "passa a",
 * "deixou de", "pode(m)", "vai/vão", "ainda não está claro". Os 3 exemplos
 * aprovados pelo editor (D1/D2/D3) passam.
 */

export const READER_IMPACT_MARKER =
  /(?<![\p{L}\p{N}_])(?:tende(?:m)? a|[àa] medida que|quem|voc[êe]|leitor(?:es)?|passa(?:m)? a|deixou de|deixaram de|pode(?:m)?|v[aã]o|vai|ainda n[ãa]o est[áa] claro)(?![\p{L}\p{N}_])/iu;

export interface ReaderImpactWarning {
  /** Linha (1-based) do parágrafo. */
  line: number;
  /** Início do parágrafo (até 120 chars). */
  excerpt: string;
}

export interface ReaderImpactReport {
  ok: boolean;
  warnings: ReaderImpactWarning[];
}

const HEADER_RE = /^\s*Por que isso importa:\s*(.*)$/i;

export function checkPorqueImportaReaderImpact(md: string): ReaderImpactReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const warnings: ReaderImpactWarning[] = [];

  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_RE.exec(lines[i]);
    if (!h) continue;
    let text = h[1].trim();
    let line = i + 1;
    if (!text) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      line = j + 1;
      const para: string[] = [];
      while (j < lines.length && lines[j].trim() && !HEADER_RE.test(lines[j])) {
        para.push(lines[j].trim());
        j++;
      }
      text = para.join(" ");
    }
    if (text && !READER_IMPACT_MARKER.test(text)) {
      warnings.push({ line, excerpt: text.slice(0, 120) });
    }
  }

  return { ok: warnings.length === 0, warnings };
}
