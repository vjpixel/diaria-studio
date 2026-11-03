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
 * `read_doc`) e o registro `data/monthly/clarice-tutorial-log.json` (fora do
 * git: `data/` sincroniza entre as máquinas, mesma razão do #5227).
 *
 * Todo erro daqui é `ClariceTutorialError` com `reason` (`doc-invalido`,
 * `log-invalido`, `log-diverge-do-doc`), que o CLI repassa para o aviso do
 * gate 4.
 */

export type ClariceTutorialErrorReason = "doc-invalido" | "log-invalido" | "log-diverge-do-doc";

export class ClariceTutorialError extends Error {
  readonly reason: ClariceTutorialErrorReason;
  constructor(reason: ClariceTutorialErrorReason, message: string) {
    super(message);
    this.name = "ClariceTutorialError";
    this.reason = reason;
  }
}

const docErr = (msg: string) => new ClariceTutorialError("doc-invalido", `Laboratório Clarice: ${msg}`);
const logErr = (msg: string) => new ClariceTutorialError("log-invalido", `clarice-tutorial-log: ${msg}`);
const divergeErr = (msg: string) => new ClariceTutorialError("log-diverge-do-doc", `clarice-tutorial-log: ${msg}`);

/** Passos por tutorial: o próprio Doc declara "3 a 5 passos". */
export const MIN_PASSOS = 3;
export const MAX_PASSOS = 5;

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
  | { kind: "esgotado"; usados: number[]; no_doc: number[] };

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
      if (cta) throw docErr(`${label} tem mais de uma linha de CTA (→).`);
      cta = cm[1].trim();
    } else if (dm) {
      if (dica) throw docErr(`${label} tem mais de uma linha "Dica:".`);
      dica = dm[1].trim();
    } else if (cta) {
      throw docErr(`${label} tem texto depois do CTA: "${line}".`);
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
    throw docErr(`${label} sem ${faltando.join(", ")}.`);
  }
  if (passos.length < MIN_PASSOS || passos.length > MAX_PASSOS) {
    throw docErr(`${label} tem ${passos.length} passos (o Doc declara ${MIN_PASSOS} a ${MAX_PASSOS}).`);
  }
  return { numero: d.numero, titulo: d.titulo, intro, passos, dica, cta };
}

/**
 * Parseia o texto do Doc. Aceita (a) texto com marcadores `[HEADING_N]` (o
 * formato que `docJsonToMarkedText` produz a partir do `read_doc`) e (b) texto
 * plano exportado do Google Docs, sem marcadores.
 *
 * Regra de heading de tutorial, a mesma nos dois modos: linha `N. Título` no
 * começo da lista ou logo depois do CTA (→) do tutorial anterior. Com
 * marcadores, ela também precisa estar em HEADING_2; sem marcadores, a posição
 * depois do CTA é o que separa o heading de um passo numerado ("1. Cole o
 * texto"), porque depois do CTA não pode haver mais corpo. Nenhum dos modos
 * exige N sequencial: a ordem do Doc é a ordem da lista, e N repetido é erro.
 * "Notas" encerra a lista.
 *
 * Estrito: com marcadores, heading numerado fora de HEADING_2, ou heading não
 * numerado (que não seja HEADING_1 nem "Notas") depois do 1º tutorial, é erro;
 * nos dois modos, linha de corpo fora de tutorial depois do 1º tutorial,
 * tutorial incompleto ou com passos fora de 3 a 5 é erro. Nunca devolve lista
 * parcial em silêncio.
 */
export function parseLaboratorioClarice(text: string): ClariceTutorial[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const hasMarkers = lines.some((l) => MARKER_RE.test(l));
  const out: ClariceTutorial[] = [];
  let cur: Draft | null = null;
  let started = false;
  const seen = new Set<number>();

  const close = () => {
    if (cur) out.push(finish(cur));
    cur = null;
  };
  const open = (numero: number, titulo: string) => {
    if (seen.has(numero)) throw docErr(`tutorial ${numero} aparece duas vezes.`);
    seen.add(numero);
    started = true;
    cur = { numero, titulo: titulo.trim(), body: [] };
  };
  const atBoundary = () => {
    const draft = cur as Draft | null;
    return !draft || draft.body.some((l) => CTA_RE.test(l));
  };

  for (const line of lines) {
    if (!line) continue;
    if (hasMarkers) {
      const mm = line.match(MARKER_RE);
      if (mm) {
        const level = mm[1];
        const heading = mm[2].trim();
        close();
        if (NOTAS_RE.test(heading)) break;
        const nm = heading.match(NUMBERED_HEADING_RE);
        if (nm) {
          if (level !== "2") {
            throw docErr(`heading numerado "${heading}" em HEADING_${level}; tutorial é HEADING_2.`);
          }
          open(Number(nm[1]), nm[2]);
        } else if (started && level !== "1") {
          throw docErr(`heading "${heading}" (HEADING_${level}) no meio da lista não é tutorial nem "Notas".`);
        }
        // HEADING_1 (título do Doc) e headings do preâmbulo ficam fora da lista.
        continue;
      }
    } else {
      if (NOTAS_RE.test(line)) {
        close();
        break;
      }
      const nm = line.match(NUMBERED_HEADING_RE);
      if (nm && atBoundary()) {
        close();
        open(Number(nm[1]), nm[2]);
        continue;
      }
    }
    if (cur) (cur as Draft).body.push(line);
    else if (started) throw docErr(`linha fora de tutorial depois do 1º tutorial: "${line}".`);
  }
  close();

  if (out.length === 0) {
    throw docErr(
      "nenhum tutorial encontrado no texto do Doc (esperado heading \"N. Título\"). " +
        "Conferir se o texto gravado é mesmo o Doc 1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY.",
    );
  }
  return out;
}

/**
 * Converte o JSON do `read_doc` do conector Google Docs em texto com
 * marcadores `[HEADING_N]`, pronto para `parseLaboratorioClarice`. Aceita a
 * estrutura com abas (`content.tabs[].documentTab.body.content[]`, ou `tabs`
 * na raiz) e a sem abas (`body.content[]`). Elementos que não são parágrafo
 * (sectionBreak, tabela) e elementos de parágrafo sem `textRun`
 * (horizontalRule) não geram texto.
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
    throw docErr("JSON do Doc sem `tabs[].documentTab.body.content` nem `body.content`.");
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

/** Título comparável: NFC, minúsculas, espaços colapsados. */
export function normalizeTitulo(t: string): string {
  return t.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

type NumberedEntry = TutorialLogEntry & { numero: number };

/**
 * Tutorial do Doc que a entrada do log registra, conferindo número E título.
 * Número que sumiu do Doc ou título diferente = Doc reordenado ou reescrito →
 * `log-diverge-do-doc`, nunca escolha silenciosa.
 */
function matchEntry(tutorials: ClariceTutorial[], e: NumberedEntry): ClariceTutorial {
  const t = tutorials.find((x) => x.numero === e.numero);
  if (!t) {
    throw divergeErr(`o ciclo ${e.cycle} registra o tutorial ${e.numero} ("${e.titulo}"), que não existe mais no Doc.`);
  }
  if (normalizeTitulo(t.titulo) !== normalizeTitulo(e.titulo)) {
    throw divergeErr(
      `o ciclo ${e.cycle} registra o tutorial ${e.numero} como "${e.titulo}", mas o ${e.numero} do Doc hoje é ` +
        `"${t.titulo}" (Doc reordenado?). Corrigir o log ou o Doc.`,
    );
  }
  return t;
}

/**
 * Escolhe o tutorial do ciclo. Idempotente: se o ciclo já tem entrada no log,
 * devolve aquela (rodar a Etapa 2 de novo não avança a sequência). Senão, o
 * primeiro tutorial na ordem do Doc cujo número ainda não saiu. Nenhum
 * disponível → `esgotado`, nunca um tutorial inventado ou repetido. Toda
 * entrada numerada do log é conferida por número + título contra o Doc antes
 * da escolha (entradas fora da lista, `numero: null`, ficam de fora).
 */
export function pickNextTutorial(
  tutorials: ClariceTutorial[],
  log: TutorialLog,
  cycle: string,
): PickResult {
  const numeradas = log.entries.filter((e): e is NumberedEntry => e.numero !== null);
  const conferidas = new Map(numeradas.map((e) => [e.cycle, matchEntry(tutorials, e)]));

  const existing = log.entries.find((e) => e.cycle === cycle);
  if (existing) {
    if (existing.numero === null) return { kind: "fora-da-lista", entry: existing };
    return { kind: "tutorial", tutorial: conferidas.get(existing.cycle)!, reused: true };
  }
  const usados = numeradas.map((e) => e.numero);
  const next = tutorials.find((t) => !usados.includes(t.numero));
  if (!next) {
    return { kind: "esgotado", usados, no_doc: tutorials.map((t) => t.numero) };
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

const LOG_CYCLE_RE = /^\d{4}-\d{2}$/;

/**
 * Valida o registro. Malformado → `log-invalido`, nunca tratado como vazio
 * (log vazio faria a sequência recomeçar do #1).
 */
export function parseTutorialLog(raw: string): TutorialLog {
  let j: TutorialLog;
  try {
    j = JSON.parse(raw) as TutorialLog;
  } catch (err) {
    throw logErr(`JSON inválido (${(err as Error).message}).`);
  }
  if (!j || typeof j !== "object" || !Array.isArray(j.entries)) {
    throw logErr("JSON sem array `entries`.");
  }
  const cycles = new Set<string>();
  const numeros = new Set<number>();
  for (const e of j.entries as unknown[]) {
    const x = e as Partial<TutorialLogEntry> | null;
    const ok =
      x !== null &&
      typeof x === "object" &&
      typeof x.cycle === "string" &&
      LOG_CYCLE_RE.test(x.cycle) &&
      (x.numero === null || Number.isInteger(x.numero)) &&
      typeof x.titulo === "string" &&
      x.titulo.trim() !== "";
    if (!ok) throw logErr(`entrada inválida ${JSON.stringify(e)}.`);
    const entry = x as TutorialLogEntry;
    if (cycles.has(entry.cycle)) throw logErr(`ciclo ${entry.cycle} aparece duas vezes.`);
    cycles.add(entry.cycle);
    if (entry.numero !== null) {
      if (numeros.has(entry.numero)) throw logErr(`tutorial ${entry.numero} registrado em dois ciclos.`);
      numeros.add(entry.numero);
    }
  }
  return j;
}
