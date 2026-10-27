/**
 * circle-stack-copy.ts (#11184)
 *
 * Texto PRÓPRIO do post semanal do Radar de Notícias Stack, escrito pela skill
 * `/diaria-stack` com o agente `stack-writer`. A decisão do editor de
 * 22/10/2026 (#10904) é que o público da Stack (alunos dos cursos de Lovable,
 * Cursor, Claude Code, n8n e Replit, perfil builder) recebe conteúdo próprio,
 * diferente do LinkedIn. O que este módulo cobre:
 *
 *   - `opening`: a abertura do post, escrita para quem constrói. Vence o resumo
 *     automático de `circleStackSummaryOpening` (`circle-stack-render.ts`).
 *   - `stackNote` de cada item de Lançamentos, Use melhor e Radar: a descrição
 *     no ângulo de quem constrói, que SUBSTITUI o `body` da diária na lista.
 *
 * Os destaques continuam iguais aos da diária (título, corpo e "Por que isso
 * importa", pedido do editor de 23/10/2026): o render ignora `stackNote` neles,
 * então o agente nem recebe destaque como item a escrever, só como contexto
 * da abertura.
 *
 * Fluxo: `buildStackWriterInput` monta o insumo do agente a partir da seleção
 * gravada; o agente grava `_internal/circle-stack-copy.json`; o humanizador
 * passa sobre os textos; `parseStackCopy` valida o arquivo inteiro contra a
 * seleção e `applyStackCopy` grava `opening`/`stackNote` na seleção. Qualquer
 * problema recusa TUDO (nada é aplicado pela metade), e a seleção segue com o
 * texto anterior.
 *
 * Fontes oficiais das ferramentas dos cursos (#10952): cada item cuja URL é de
 * blog/changelog/docs de uma dessas ferramentas leva `tool` no insumo, e o
 * agente escreve o que muda no uso dela. Lista em par com `official-domains.ts`.
 */

import type { CircleStackItem, CircleStackSelection } from "./circle-stack-render.ts";

/** Teto da abertura: 2 a 4 frases curtas. */
export const STACK_COPY_OPENING_MAX_CHARS = 600;
/** Teto da descrição de cada item de lista: 1 ou 2 frases. */
export const STACK_COPY_NOTE_MAX_CHARS = 240;

/** Seções de lista cujos itens recebem `stackNote` (destaques ficam como na diária). */
export const STACK_COPY_LIST_SECTIONS = ["lancamentos", "useMelhor", "radar"] as const;
export type StackCopyListSection = (typeof STACK_COPY_LIST_SECTIONS)[number];

/**
 * Ferramentas ensinadas nos cursos da Stack (#10952, lista conferida em
 * 22/10/2026) e os hosts oficiais delas: blog, changelog e docs. Manter em par
 * com as entradas Lovable/Cursor/n8n/Replit/Anthropic (Claude Code) de
 * `official-domains.ts` e com `seed/sources.csv`.
 */
export const STACK_COURSE_TOOLS: readonly { tool: string; patterns: readonly RegExp[] }[] = [
  { tool: "Lovable", patterns: [/^lovable\.dev\/blog\//, /^docs\.lovable\.dev\//] },
  { tool: "Cursor", patterns: [/^cursor\.com\/(blog|changelog|docs)(\/|$)/, /^docs\.cursor\.com\//] },
  { tool: "Claude Code", patterns: [/^code\.claude\.com\//, /^github\.com\/anthropics\/claude-code(\/|$)/] },
  { tool: "n8n", patterns: [/^blog\.n8n\.io\//, /^docs\.n8n\.io\//] },
  { tool: "Replit", patterns: [/^replit\.com\/blog\//, /^blog\.replit\.com\//, /^docs\.replit\.com\//] },
];

/** Pure: ferramenta de curso da Stack cuja fonte oficial é a URL, ou null. */
export function stackCourseTool(url: string): string | null {
  let full: string;
  try {
    const u = new URL(url);
    full = u.hostname.replace(/^www\./, "") + u.pathname;
  } catch {
    return null;
  }
  for (const t of STACK_COURSE_TOOLS) {
    if (t.patterns.some((p) => p.test(full))) return t.tool;
  }
  return null;
}

export interface StackWriterItem {
  section: StackCopyListSection;
  url: string;
  title: string;
  body: string;
  why: string;
  /** Ferramenta de curso da Stack quando a fonte é oficial dela (#10952). */
  tool: string | null;
  /** Descrição já gravada na seleção (rodada anterior ou editada à mão). */
  currentNote: string | null;
}

export interface StackWriterDestaque {
  url: string;
  title: string;
  body: string;
  why: string;
  tool: string | null;
}

/** Insumo do agente `stack-writer` (impresso por `circle-stack-copy.ts --manifest`). */
export interface StackWriterInput {
  cycle: string;
  /** Onde o agente grava a resposta. */
  copyPath: string;
  limits: { openingMaxChars: number; noteMaxChars: number };
  currentOpening: string | null;
  destaques: StackWriterDestaque[];
  items: StackWriterItem[];
}

/** Pure: monta o insumo do agente a partir da seleção gravada. URL repetida entre seções entra uma vez. */
export function buildStackWriterInput(sel: CircleStackSelection, copyPath: string): StackWriterInput {
  const seen = new Set<string>();
  const items: StackWriterItem[] = [];
  for (const section of STACK_COPY_LIST_SECTIONS) {
    for (const it of sel[section]) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push({
        section,
        url: it.url,
        title: it.title,
        body: it.body,
        why: it.why,
        tool: stackCourseTool(it.url),
        currentNote: it.stackNote?.trim() ? it.stackNote.trim() : null,
      });
    }
  }
  return {
    cycle: sel.cycle,
    copyPath,
    limits: { openingMaxChars: STACK_COPY_OPENING_MAX_CHARS, noteMaxChars: STACK_COPY_NOTE_MAX_CHARS },
    currentOpening: typeof sel.opening === "string" && sel.opening.trim() ? sel.opening.trim() : null,
    destaques: sel.destaques.map((d) => ({ url: d.url, title: d.title, body: d.body, why: d.why, tool: stackCourseTool(d.url) })),
    items,
  };
}

/**
 * Pure: problemas de um texto que vai ao post (regras de
 * `context/editorial-rules.md` e do CLAUDE.md). O texto entra no Markdown do
 * post como frase corrida, então qualquer marcação, link ou URL seria um
 * pedaço que o editor não revisou como texto.
 */
export function stackCopyTextProblems(text: string, maxChars: number): string[] {
  const problems: string[] = [];
  const s = text.trim();
  if (!s) return ["vazio"];
  if (s.length > maxChars) problems.push(`${s.length} caracteres (teto ${maxChars})`);
  if (/[→←]/.test(s)) problems.push("tem seta (→/←)");
  if (/\*\*|__|`|\[[^\]]*\]\(|^\s*(#{1,6}\s|[-*]\s|\d+\.\s)/m.test(s)) problems.push("tem markdown");
  if (/https?:\/\/|www\./i.test(s)) problems.push("tem URL (os links já vêm da seleção)");
  if (/\bagentiv[oa]s?\b/i.test(s)) problems.push('usa "agentivo" (é "agêntico")');
  if (/\p{Extended_Pictographic}/u.test(s)) problems.push("tem emoji");
  return problems;
}

export interface StackCopy {
  cycle: string;
  opening: string;
  notes: { url: string; stackNote: string }[];
}

/**
 * Pure: valida o `circle-stack-copy.json` inteiro contra a seleção. Devolve a
 * cópia normalizada (textos com `trim`) e a lista de problemas; lista não
 * vazia = nada pode ser aplicado. Exige uma descrição para cada item de lista
 * da seleção, nenhuma URL a mais e o mesmo ciclo (cópia de outra semana, ou
 * escrita antes de um `--reselect`, é recusada).
 */
export function parseStackCopy(raw: string, sel: CircleStackSelection): { copy: StackCopy | null; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { copy: null, problems: [`JSON ilegível: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { copy: null, problems: ["esperado um objeto JSON"] };
  const rec = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (rec.cycle !== sel.cycle) problems.push(`ciclo ${JSON.stringify(rec.cycle)} diferente da seleção (${sel.cycle})`);
  if (typeof rec.opening !== "string") problems.push("opening ausente ou não é texto");
  else for (const p of stackCopyTextProblems(rec.opening, STACK_COPY_OPENING_MAX_CHARS)) problems.push(`opening: ${p}`);
  if (!Array.isArray(rec.notes)) problems.push("notes ausente (esperada uma lista)");

  const expected = new Set(buildStackWriterInput(sel, "").items.map((i) => i.url));
  const notes: { url: string; stackNote: string }[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.notes)) {
    rec.notes.forEach((n: unknown, i: number) => {
      const nr = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
      if (typeof nr.url !== "string" || typeof nr.stackNote !== "string") {
        problems.push(`notes[${i}]: url e stackNote precisam ser texto`);
        return;
      }
      if (!expected.has(nr.url)) problems.push(`notes[${i}]: URL fora dos itens de lista da seleção (${nr.url})`);
      if (seen.has(nr.url)) problems.push(`notes[${i}]: URL repetida (${nr.url})`);
      seen.add(nr.url);
      for (const p of stackCopyTextProblems(nr.stackNote, STACK_COPY_NOTE_MAX_CHARS)) problems.push(`notes[${i}] (${nr.url}): ${p}`);
      notes.push({ url: nr.url, stackNote: nr.stackNote.trim() });
    });
  }
  for (const url of expected) if (!seen.has(url)) problems.push(`sem stackNote para ${url}`);

  if (problems.length > 0) return { copy: null, problems };
  return { copy: { cycle: sel.cycle, opening: (rec.opening as string).trim(), notes }, problems };
}

/**
 * Pure: grava a abertura e as descrições na seleção. Destaques e o resto dos
 * campos ficam como estão; o `stackNote` de um destaque (que o render ignora)
 * não é tocado.
 */
export function applyStackCopy<S extends CircleStackSelection>(sel: S, copy: StackCopy): S {
  if (copy.cycle !== sel.cycle) throw new Error(`Cópia do ciclo ${copy.cycle} aplicada na seleção ${sel.cycle}`);
  const byUrl = new Map(copy.notes.map((n) => [n.url, n.stackNote]));
  const withNote = (items: CircleStackItem[]): CircleStackItem[] =>
    items.map((it) => (byUrl.has(it.url) ? { ...it, stackNote: byUrl.get(it.url) as string } : it));
  return {
    ...sel,
    opening: copy.opening,
    lancamentos: withNote(sel.lancamentos),
    useMelhor: withNote(sel.useMelhor),
    radar: withNote(sel.radar),
  };
}
