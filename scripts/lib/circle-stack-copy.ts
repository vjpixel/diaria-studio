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
 * Vídeo da semana (#12549 item 6, decisão do editor de 10/11/2026): quando a
 * seleção tem `video`, o agente escreve também `videoDescription`, só com os
 * fatos do destaque que o vídeo comenta (o D1 da edição do vídeo). Vai para
 * `video.description` na seleção, que o render e a prévia já mostram.
 *
 * Fontes oficiais das ferramentas dos cursos (#10952): cada item cuja URL é de
 * blog/changelog/docs de uma dessas ferramentas leva `tool` no insumo, e o
 * agente escreve o que muda no uso dela. Lista em par com `official-domains.ts`.
 */

import type { CircleStackItem, CircleStackSelection } from "./circle-stack-render.ts";

/**
 * Teto da abertura (#11783): o alvo é ~200 caracteres em 2 ou 3 frases curtas.
 * No ciclo 26w44 o editor recusou duas aberturas de ~560 caracteres como
 * confusas e aprovou uma de 200; o teto deixa folga sobre o alvo, não o repete.
 */
export const STACK_COPY_OPENING_TARGET_CHARS = 200;
export const STACK_COPY_OPENING_MAX_CHARS = 280;
/** Teto da descrição de cada item de lista: 1 ou 2 frases. */
export const STACK_COPY_NOTE_MAX_CHARS = 240;
/** Teto da descrição do vídeo da semana (#12549 item 6): 1 a 3 frases curtas. */
export const STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS = 280;

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

/** #12549 item 6: o destaque que o vídeo da semana comenta (D1 da edição do vídeo). */
export interface StackVideoDestaque {
  editionDate: string;
  url: string;
  title: string;
  body: string;
  why: string;
}

/** #12549 item 6: o vídeo da semana no insumo do agente. */
export interface StackWriterVideo {
  title: string;
  url: string;
  editionDate: string;
  /** Única fonte de fatos da descrição. */
  destaque: StackVideoDestaque;
  /** Descrição já gravada na seleção (rodada anterior ou editada à mão). */
  currentDescription: string | null;
}

/** Insumo do agente `stack-writer` (impresso por `circle-stack-copy.ts --manifest`). */
export interface StackWriterInput {
  cycle: string;
  /** Onde o agente grava a resposta. */
  copyPath: string;
  limits: { openingTargetChars: number; openingMaxChars: number; noteMaxChars: number; videoDescriptionMaxChars: number };
  currentOpening: string | null;
  destaques: StackWriterDestaque[];
  items: StackWriterItem[];
  /**
   * Vídeo da semana a descrever, ou `null` (seleção sem vídeo, ou sem o
   * destaque que ele comenta: sem fato, sem descrição).
   */
  video: StackWriterVideo | null;
}

/** Pure: a seleção tem vídeo da semana utilizável (o render só mostra com url e título). */
export function hasStackVideo(sel: CircleStackSelection): boolean {
  return !!sel.video && !!sel.video.url?.trim() && !!sel.video.title?.trim();
}

/**
 * Pure: o D1 da edição do vídeo, quando ele está em alguma seção da seleção
 * (destaque diário guarda `destaqueN`, mesmo se caiu no Radar). `null` quando
 * não está: aí o CLI lê o `02-reviewed.md` da edição.
 */
export function videoDestaqueFromSelection(sel: CircleStackSelection): StackVideoDestaque | null {
  if (!hasStackVideo(sel)) return null;
  const date = (sel.video as NonNullable<CircleStackSelection["video"]>).editionDate;
  for (const section of ["destaques", ...STACK_COPY_LIST_SECTIONS] as const) {
    const it = sel[section].find((i) => i.editionDate === date && i.destaqueN === 1);
    if (it) return { editionDate: it.editionDate, url: it.url, title: it.titleOriginal ?? it.title, body: it.body, why: it.why };
  }
  return null;
}

/**
 * Pure: monta o insumo do agente a partir da seleção gravada. URL repetida
 * entre seções entra uma vez. `videoDestaque` é o D1 que o vídeo comenta
 * (default: procurado na própria seleção).
 */
export function buildStackWriterInput(
  sel: CircleStackSelection,
  copyPath: string,
  videoDestaque: StackVideoDestaque | null = videoDestaqueFromSelection(sel),
): StackWriterInput {
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
    limits: {
      openingTargetChars: STACK_COPY_OPENING_TARGET_CHARS,
      openingMaxChars: STACK_COPY_OPENING_MAX_CHARS,
      noteMaxChars: STACK_COPY_NOTE_MAX_CHARS,
      videoDescriptionMaxChars: STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS,
    },
    currentOpening: typeof sel.opening === "string" && sel.opening.trim() ? sel.opening.trim() : null,
    destaques: sel.destaques.map((d) => ({ url: d.url, title: d.title, body: d.body, why: d.why, tool: stackCourseTool(d.url) })),
    items,
    video:
      sel.video && hasStackVideo(sel) && videoDestaque
        ? {
            title: sel.video.title.trim(),
            url: sel.video.url.trim(),
            editionDate: sel.video.editionDate,
            destaque: videoDestaque,
            currentDescription: sel.video.description?.trim() ? sel.video.description.trim() : null,
          }
        : null,
  };
}

/**
 * #12549 item 5: fecho de recomendação ao leitor ("Quem constrói X deveria
 * ver", "Quem tem fluxo apoiado nele precisa migrar", "Vale testar"). O
 * editor tirou esse tom do post; o texto diz o que mudou, não o que o leitor
 * deve fazer.
 */
const READER_ADVICE_PATTERNS: readonly RegExp[] = [
  /\bquem\s+[^.!?]{1,80}?\b(deveria|deveriam|deve|devem|precisa|precisam|vale)\b/i,
  /\b(você|vocês)\s+(deveria|deveriam|deve|devem|precisa|precisam)\b/i,
  /\b(vale|valeria)\s+(a\s+pena\s+)?(ver|ler|reler|conferir|testar|acompanhar|olhar|experimentar|assistir)\b/i,
  /\bdeveria(m)?\s+(ver|ler|conferir|testar|acompanhar|olhar|experimentar|assistir)\b/i,
];

/** Pure: o texto aconselha o leitor (deveria/vale/precisa)? */
export function hasReaderAdvice(text: string): boolean {
  return READER_ADVICE_PATTERNS.some((re) => re.test(text));
}

/**
 * Pure: números do texto que não aparecem em nenhuma das fontes (#12549 item
 * 6: a descrição do vídeo só leva fatos do destaque). Compara o número como
 * escrito e com o separador decimal trocado ("1,5" casa "1.5").
 */
export function unsourcedNumbers(text: string, sources: readonly string[]): string[] {
  const src = sources.join("\n");
  const out: string[] = [];
  for (const tok of text.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const swapped = tok.replace(/[.,]/g, (c) => (c === "." ? "," : "."));
    if (!src.includes(tok) && !src.includes(swapped) && !out.includes(tok)) out.push(tok);
  }
  return out;
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
  if (hasReaderAdvice(s)) problems.push('aconselha o leitor ("deveria/vale/precisa") — diga o que mudou, não o que fazer (#12549)');
  return problems;
}

export interface StackCopy {
  cycle: string;
  opening: string;
  notes: { url: string; stackNote: string }[];
  /** #12549 item 6: presente só quando o insumo tinha `video`. */
  videoDescription?: string;
}

export interface ParseStackCopyOptions {
  /** D1 que o vídeo comenta; default: procurado na seleção (o CLI passa o lido do disco). */
  videoDestaque?: StackVideoDestaque | null;
}

/**
 * Pure: valida o `circle-stack-copy.json` inteiro contra a seleção. Devolve a
 * cópia normalizada (textos com `trim`) e a lista de problemas; lista não
 * vazia = nada pode ser aplicado. Exige uma descrição para cada item de lista
 * da seleção, nenhuma URL a mais e o mesmo ciclo (cópia de outra semana, ou
 * escrita antes de um `--reselect`, é recusada).
 */
export function parseStackCopy(
  raw: string,
  sel: CircleStackSelection,
  opts: ParseStackCopyOptions = {},
): { copy: StackCopy | null; problems: string[] } {
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

  const input = buildStackWriterInput(sel, "", opts.videoDestaque === undefined ? videoDestaqueFromSelection(sel) : opts.videoDestaque);
  const expected = new Set(input.items.map((i) => i.url));
  // #12549 item 6: descrição do vídeo exigida quando (e só quando) o insumo tinha vídeo.
  let videoDescription: string | undefined;
  if (input.video) {
    if (typeof rec.videoDescription !== "string") problems.push("videoDescription ausente ou não é texto (a seleção tem vídeo da semana)");
    else {
      for (const p of stackCopyTextProblems(rec.videoDescription, STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS)) problems.push(`videoDescription: ${p}`);
      const d = input.video.destaque;
      const extra = unsourcedNumbers(rec.videoDescription, [d.title, d.body, d.why, input.video.title]);
      if (extra.length > 0) problems.push(`videoDescription: número(s) fora do destaque comentado (${extra.join(", ")})`);
      videoDescription = rec.videoDescription.trim();
    }
  } else if (rec.videoDescription !== undefined) {
    problems.push("videoDescription sem vídeo da semana (com o destaque comentado) no insumo — apague o campo");
  }
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
  return {
    copy: { cycle: sel.cycle, opening: (rec.opening as string).trim(), notes, ...(videoDescription !== undefined ? { videoDescription } : {}) },
    problems,
  };
}

/**
 * Pure: grava a abertura, as descrições e (#12549) a descrição do vídeo na seleção. Destaques e o resto dos
 * campos ficam como estão; o `stackNote` de um destaque (que o render ignora)
 * não é tocado.
 */
export function applyStackCopy<S extends CircleStackSelection>(sel: S, copy: StackCopy): S {
  if (copy.cycle !== sel.cycle) throw new Error(`Cópia do ciclo ${copy.cycle} aplicada na seleção ${sel.cycle}`);
  const byUrl = new Map(copy.notes.map((n) => [n.url, n.stackNote]));
  const withNote = (items: CircleStackItem[]): CircleStackItem[] =>
    items.map((it) => (byUrl.has(it.url) ? { ...it, stackNote: byUrl.get(it.url) as string } : it));
  if (copy.videoDescription !== undefined && !sel.video) throw new Error(`Cópia do ciclo ${copy.cycle} traz videoDescription, mas a seleção não tem vídeo`);
  return {
    ...sel,
    ...(copy.videoDescription !== undefined && sel.video ? { video: { ...sel.video, description: copy.videoDescription } } : {}),
    opening: copy.opening,
    lancamentos: withNote(sel.lancamentos),
    useMelhor: withNote(sel.useMelhor),
    radar: withNote(sel.radar),
  };
}
