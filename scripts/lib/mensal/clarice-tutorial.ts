/**
 * scripts/lib/mensal/clarice-tutorial.ts (#11836)
 *
 * Fonte do CLARICE — TUTORIAL da mensal: o Doc "Laboratório Clarice" no Drive
 * (id `1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY`). Cada tutorial é um
 * heading "N. Título", seguido de 1 parágrafo de intro, os passos (uma linha
 * cada), uma linha "Dica: ..." e uma linha de CTA "→ ...". A seção final
 * "Notas" não é tutorial.
 *
 * Puro: sem rede, sem fs. Quem lê o Doc é o coordenador, pelo conector Google
 * Docs; o CLI `scripts/clarice-tutorial-next.ts` recebe o texto (ou o JSON do
 * `read_doc`) e o registro `context/clarice-tutorial-log.json`.
 */

export interface ClariceTutorial {
  numero: number;
  titulo: string;
  intro: string;
  passos: string[];
  dica: string;
  /** Texto do CTA, sem a seta. O link é do writer (`clarice.ai/precos-planos?via=diaria`). */
  cta: string;
}

export interface TutorialLogEntry {
  cycle: string;
  /** Número do tutorial no Doc; `null` = tutorial fora da lista (ex.: "Simplificar", 2609-10). */
  numero: number | null;
  titulo: string;
  nota?: string;
  recorded_at?: string;
}

export interface TutorialLog {
  doc_id?: string;
  doc_title?: string;
  entries: TutorialLogEntry[];
}

export type PickResult =
  | { kind: "tutorial"; tutorial: ClariceTutorial; reused: boolean }
  /** O ciclo já tem entrada no log com tutorial fora da lista do Doc. */
  | { kind: "fora-da-lista"; entry: TutorialLogEntry }
  /** Todos os tutoriais do Doc já saíram. Nunca inventar: o writer mantém o placeholder. */
  | { kind: "esgotado"; usados: number[]; disponiveis: number[] };

const MARKER_RE = /^\[HEADING_(\d)\]\s*(.*)$/;
const NUMBERED_HEADING_RE = /^(\d+)\.\s+(\S.*)$/;
const NOTAS_RE = /^notas\s*:?\s*$/i;
const DICA_RE = /^dica\s*:\s*(.*)$/i;
const CTA_RE = /^→\s*(.*)$/;
/** Prefixo de item de lista que um export em texto plano pode trazer nos passos. */
const LIST_PREFIX_RE = /^(?:\d+[.)]|[*•\-])\s+/;

interface Draft {
  numero: number;
  titulo: string;
  body: string[];
}

function finish(d: Draft): ClariceTutorial {
  const label = `tutorial ${d.numero} ("${d.titulo}")`;
  let intro = "";
  let dica = "";
  let cta = "";
  const passos: string[] = [];
  for (const line of d.body) {
    const dm = line.match(DICA_RE);
    const cm = line.match(CTA_RE);
    if (cm) {
      if (cta) throw new Error(`Laboratório Clarice: ${label} tem mais de uma linha de CTA (→).`);
      cta = cm[1].trim();
    } else if (dm) {
      if (dica) throw new Error(`Laboratório Clarice: ${label} tem mais de uma linha "Dica:".`);
      dica = dm[1].trim();
    } else if (cta) {
      throw new Error(`Laboratório Clarice: ${label} tem texto depois do CTA: "${line}".`);
    } else if (!intro) {
      intro = line;
    } else {
      passos.push(line.replace(LIST_PREFIX_RE, "").trim());
    }
  }
  const faltando = [
    !intro && "intro",
    passos.length === 0 && "passos",
    !dica && "Dica:",
    !cta && "CTA (→)",
  ].filter(Boolean);
  if (faltando.length > 0) {
    throw new Error(`Laboratório Clarice: ${label} sem ${faltando.join(", ")}.`);
  }
  return { numero: d.numero, titulo: d.titulo, intro, passos, dica, cta };
}

/**
 * Parseia o texto do Doc. Aceita (a) texto com marcadores `[HEADING_N]` (o
 * formato que o coordenador grava a partir do `read_doc`) e (b) texto plano
 * exportado do Google Docs, sem marcadores — aí o heading é a linha isolada
 * `N. Título` cujo N é o próximo da sequência e que vem depois do CTA do
 * tutorial anterior (os passos podem chegar numerados num export, e "1. Cole
 * o texto" não pode virar tutorial). "Notas" encerra a lista.
 *
 * Lança erro quando não acha nenhum tutorial ou quando um tutorial está
 * incompleto — nunca devolve lista parcial em silêncio.
 */
export function parseLaboratorioClarice(text: string): ClariceTutorial[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const hasMarkers = lines.some((l) => MARKER_RE.test(l));
  const out: ClariceTutorial[] = [];
  let cur: Draft | null = null;
  const seen = new Set<number>();

  const close = () => {
    if (cur) out.push(finish(cur));
    cur = null;
  };
  const open = (numero: number, titulo: string) => {
    if (seen.has(numero)) throw new Error(`Laboratório Clarice: tutorial ${numero} aparece duas vezes.`);
    seen.add(numero);
    cur = { numero, titulo: titulo.trim(), body: [] };
  };

  for (const line of lines) {
    if (!line) continue;
    if (hasMarkers) {
      const mm = line.match(MARKER_RE);
      if (mm) {
        close();
        const heading = mm[2].trim();
        if (NOTAS_RE.test(heading)) break;
        const nm = heading.match(NUMBERED_HEADING_RE);
        // HEADING_1 (título do Doc) e headings não numerados ficam fora da lista.
        if (mm[1] === "2" && nm) open(Number(nm[1]), nm[2]);
        continue;
      }
    } else {
      if (NOTAS_RE.test(line)) {
        close();
        break;
      }
      const nm = line.match(NUMBERED_HEADING_RE);
      const draft = cur as Draft | null;
      const expected = out.length + (draft ? 2 : 1);
      const prevClosed = !draft || draft.body.some((l) => CTA_RE.test(l));
      if (nm && Number(nm[1]) === expected && prevClosed) {
        close();
        open(Number(nm[1]), nm[2]);
        continue;
      }
    }
    if (cur) (cur as Draft).body.push(line);
  }
  close();

  if (out.length === 0) {
    throw new Error(
      "Laboratório Clarice: nenhum tutorial encontrado no texto do Doc (esperado heading \"N. Título\"). " +
        "Conferir se o texto gravado é mesmo o Doc 1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY.",
    );
  }
  return out;
}

/**
 * Converte o JSON do `read_doc` do conector Google Docs em texto com
 * marcadores `[HEADING_N]`, pronto para `parseLaboratorioClarice`. Aceita a
 * estrutura com abas (`content.tabs[].documentTab.body.content[]`, ou `tabs`
 * na raiz) e a sem abas (`body.content[]`).
 */
export function docJsonToMarkedText(json: unknown): string {
  const j = json as Record<string, any>;
  const tabs: any[] | undefined = j?.content?.tabs ?? j?.tabs ?? j?.document?.tabs;
  const bodies: any[][] = [];
  if (Array.isArray(tabs)) {
    const walk = (ts: any[]) => {
      for (const t of ts) {
        const c = t?.documentTab?.body?.content;
        if (Array.isArray(c)) bodies.push(c);
        if (Array.isArray(t?.childTabs)) walk(t.childTabs);
      }
    };
    walk(tabs);
  } else {
    const c = j?.body?.content ?? j?.content?.body?.content ?? j?.document?.body?.content;
    if (Array.isArray(c)) bodies.push(c);
  }
  if (bodies.length === 0) {
    throw new Error("Laboratório Clarice: JSON do Doc sem `tabs[].documentTab.body.content` nem `body.content`.");
  }
  const out: string[] = [];
  for (const content of bodies) {
    for (const el of content) {
      const p = el?.paragraph;
      if (!p) continue;
      const text = (Array.isArray(p.elements) ? p.elements : [])
        .map((e: any) => e?.textRun?.content ?? "")
        .join("")
        .replace(/\n+$/, "")
        .replace(/\v/g, " ");
      const style: string = p?.paragraphStyle?.namedStyleType ?? "";
      const hm = style.match(/^HEADING_(\d)$/);
      out.push(hm ? `[HEADING_${hm[1]}] ${text}` : text);
    }
  }
  return out.join("\n");
}

/**
 * Escolhe o tutorial do ciclo. Idempotente: se o ciclo já tem entrada no log,
 * devolve aquela (rodar a Etapa 2 de novo não avança a sequência). Senão, o
 * primeiro tutorial na ordem do Doc cujo número ainda não saiu. Nenhum
 * disponível → `esgotado`, nunca um tutorial inventado ou repetido.
 */
export function pickNextTutorial(
  tutorials: ClariceTutorial[],
  log: TutorialLog,
  cycle: string,
): PickResult {
  const existing = log.entries.find((e) => e.cycle === cycle);
  if (existing) {
    if (existing.numero === null) return { kind: "fora-da-lista", entry: existing };
    const t = tutorials.find((x) => x.numero === existing.numero);
    if (!t) {
      throw new Error(
        `clarice-tutorial-log: o ciclo ${cycle} registra o tutorial ${existing.numero}, que não existe mais no Doc.`,
      );
    }
    return { kind: "tutorial", tutorial: t, reused: true };
  }
  const usados = log.entries.map((e) => e.numero).filter((n): n is number => n !== null);
  const next = tutorials.find((t) => !usados.includes(t.numero));
  if (!next) {
    return { kind: "esgotado", usados, disponiveis: tutorials.map((t) => t.numero) };
  }
  return { kind: "tutorial", tutorial: next, reused: false };
}

/** Log com a entrada do ciclo acrescentada (não muta o original). */
export function recordTutorial(
  log: TutorialLog,
  cycle: string,
  tutorial: ClariceTutorial,
  recordedAt: string,
): TutorialLog {
  if (log.entries.some((e) => e.cycle === cycle)) return log;
  return {
    ...log,
    entries: [
      ...log.entries,
      { cycle, numero: tutorial.numero, titulo: tutorial.titulo, recorded_at: recordedAt },
    ],
  };
}

export function parseTutorialLog(raw: string): TutorialLog {
  const j = JSON.parse(raw) as TutorialLog;
  if (!j || !Array.isArray(j.entries)) {
    throw new Error("clarice-tutorial-log: JSON sem array `entries`.");
  }
  for (const e of j.entries) {
    if (typeof e.cycle !== "string" || !(e.numero === null || Number.isInteger(e.numero))) {
      throw new Error(`clarice-tutorial-log: entrada inválida ${JSON.stringify(e)}.`);
    }
  }
  return j;
}
