/**
 * skill-section.ts (#14119) — extrai de um SKILL.md só a seção marcada por uma
 * âncora estável, para uma skill que orquestra outras (`/diaria-pacote-semanal`)
 * ler o passo citado em vez do arquivo inteiro.
 *
 * Convenção da âncora: um comentário HTML `<!-- anchor: nome -->` na linha
 * imediatamente anterior ao título (`#`..`######`) do passo. O comentário não
 * aparece no render e não muda o texto do passo; o nome é estável mesmo que o
 * título mude de redação.
 *
 * A seção vai do título até o próximo título de nível igual ou menor (fora de
 * bloco de código cercado), então uma âncora num `## Passo 8` inclui os
 * `### 8a`..`### 8d`, e uma âncora no `### 8a` para no `### 8b`. As linhas de
 * âncora e as linhas em branco no fim da seção (que pertencem à seção
 * seguinte) são cortadas.
 *
 * Tudo aqui é puro; o CLI é `scripts/read-skill-section.ts`.
 */

export const ANCHOR_RE = /^<!--\s*anchor:\s*([a-z0-9][a-z0-9-]*)\s*-->\s*$/;
const HEADING_RE = /^(#{1,6})\s+\S/;
const FENCE_RE = /^\s*(```|~~~)/;

export interface SkillAnchor {
  name: string;
  /** Índice (0-based) da linha do título que a âncora marca. */
  headingLine: number;
  level: number;
  heading: string;
}

export class SkillSectionError extends Error {}

/** Marca, para cada linha, se ela está dentro de um bloco de código cercado. */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = line.match(FENCE_RE);
    if (open) {
      out.push(true);
      if (m && m[1] === open) open = null;
    } else if (m) {
      out.push(true);
      open = m[1];
    } else {
      out.push(false);
    }
  }
  return out;
}

/**
 * Lista as âncoras de um markdown. Lança `SkillSectionError` para âncora
 * duplicada ou âncora que não esteja na linha imediatamente antes de um título:
 * as duas deixariam a extração ambígua ou vazia.
 */
export function listAnchors(md: string): SkillAnchor[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  const anchors: SkillAnchor[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].match(ANCHOR_RE);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) throw new SkillSectionError(`âncora duplicada: ${name}`);
    seen.add(name);
    const next = lines[i + 1];
    const h = next !== undefined && !fenced[i + 1] ? next.match(HEADING_RE) : null;
    if (!h) {
      throw new SkillSectionError(
        `âncora ${name} (linha ${i + 1}) não está imediatamente antes de um título`,
      );
    }
    anchors.push({ name, headingLine: i + 1, level: h[1].length, heading: next.trim() });
  }
  return anchors;
}

/**
 * Devolve o texto da seção marcada por `anchorName` (título incluído). Lança
 * `SkillSectionError` se a âncora não existir; nunca devolve vazio em silêncio.
 */
export function extractAnchoredSection(md: string, anchorName: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  const anchors = listAnchors(md);
  const a = anchors.find((x) => x.name === anchorName);
  if (!a) {
    const known = anchors.map((x) => x.name).join(", ") || "(nenhuma)";
    throw new SkillSectionError(`âncora não encontrada: ${anchorName}. Âncoras disponíveis: ${known}`);
  }
  let end = lines.length;
  for (let i = a.headingLine + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    const h = lines[i].match(HEADING_RE);
    if (h && h[1].length <= a.level) {
      end = i;
      break;
    }
  }
  while (end > a.headingLine + 1 && (lines[end - 1].trim() === "" || ANCHOR_RE.test(lines[end - 1]))) {
    end--;
  }
  return lines.slice(a.headingLine, end).join("\n") + "\n";
}
