/**
 * generic-study-feedback.ts (#9673, regra do editor de 05/10/2026)
 *
 * Feedback EXPLÍCITO do editor no gate 4 sobre os itens que a penalidade de
 * estudo/case genérico (#9462) tiraria do destaque em MODO SOMBRA
 * (`_internal/01-generic-study-demoted.json` com `applied: false`).
 *
 * Regra do editor (comentário de 05/10/2026 na #9673):
 *   "precisa deixar explícito que preciso responder no gate 4. se eu não
 *    responder positivamente ou negativamente, considere que eu não li e não
 *    lembrei que eu tinha que falar disso."
 *
 * Consequências codificadas aqui:
 *  - O gate pergunta, POR ITEM, "Concorda que <título> sairia do destaque?
 *    responda sim/não" — bloco no topo do resumo (`formatGateQuestions`).
 *  - Sem resposta ⇒ `nao_lido`. Nunca concordância, nunca discordância.
 *  - Manter/tirar o item no `02-reviewed.md` NÃO é resposta: vai para
 *    `acao_no_final` ("tirou" | "manteve"), dado secundário.
 *  - A decisão de ligar a flag usa só respostas explícitas, e só com
 *    `MIN_EXPLICIT_ANSWERS` ou mais (`shadowVerdict`).
 *
 * O núcleo é puro; os helpers de disco (`read*`) são finos e fail-soft.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";

export const DEMOTED_LOG = "01-generic-study-demoted.json";
export const FEEDBACK_FILE = "04-generic-study-feedback.json";
/** Mínimo de respostas explícitas (sim + não) para a decisão da #9673. */
export const MIN_EXPLICIT_ANSWERS = 5;

export type GenericStudyAnswer = "sim" | "nao" | "nao_lido";
export type GenericStudyFinalAction = "tirou" | "manteve";

export interface ShadowItem {
  url: string;
  titulo: string;
}

export interface GenericStudyFeedbackItem {
  url: string;
  titulo: string;
  resposta: GenericStudyAnswer;
  /** ISO do registro da resposta explícita; `null` quando `nao_lido`. */
  respondido_em: string | null;
  /**
   * Dado SECUNDÁRIO: o item ficou ou não entre os destaques do
   * `02-reviewed.md` final. Não é resposta. `null` = sem `02-reviewed.md`.
   */
  acao_no_final: GenericStudyFinalAction | null;
}

export interface GenericStudyFeedbackFile {
  edition: string | null;
  recorded_at: string;
  items: GenericStudyFeedbackItem[];
}

// ---------------------------------------------------------------------------
// Itens em modo sombra
// ---------------------------------------------------------------------------

/**
 * Extrai os itens de modo sombra de um log `01-generic-study-demoted.json`
 * já parseado. Só `applied === false` conta: com a flag ligada o item já saiu
 * do destaque no Stage 1 e não há o que perguntar.
 */
export function shadowItemsFromLog(log: unknown): ShadowItem[] {
  if (!log || typeof log !== "object") return [];
  const l = log as { applied?: unknown; demoted?: unknown };
  if (l.applied !== false || !Array.isArray(l.demoted)) return [];
  const out: ShadowItem[] = [];
  const seen = new Set<string>();
  for (const d of l.demoted) {
    const url = (d as { url?: unknown })?.url;
    const title = (d as { title?: unknown })?.title;
    if (typeof url !== "string" || url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, titulo: typeof title === "string" ? title : url });
  }
  return out;
}

/** Lê os itens de modo sombra de `{editionDir}/_internal/`. Ausente/ilegível ⇒ []. */
export function readShadowItems(editionDir: string): ShadowItem[] {
  const p = join(editionDir, "_internal", DEMOTED_LOG);
  if (!existsSync(p)) return [];
  try {
    return shadowItemsFromLog(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pergunta do gate
// ---------------------------------------------------------------------------

/** Aspas do título escapadas — senão `"a "b" c"` fica ambíguo na pergunta. */
export function escapeTitleQuotes(titulo: string): string {
  return titulo.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Texto da pergunta por item — exigido pelo editor (#9673). Fonte única do
 * gate no terminal (`formatQuestion`) e do painel do Studio (`/revisao`).
 */
export function questionText(item: ShadowItem): string {
  return `Concorda que "${escapeTitleQuotes(item.titulo)}" sairia do destaque? responda sim/não`;
}

/** Linha de pergunta numerada para o gate no terminal. */
export function formatQuestion(item: ShadowItem, index: number): string {
  return `  ${index}. ${questionText(item)}`;
}

/**
 * Bloco de perguntas para o TOPO do resumo do gate 4. String vazia quando
 * não há item em modo sombra (o playbook omite a seção).
 */
export function formatGateQuestions(items: ShadowItem[]): string {
  if (items.length === 0) return "";
  const lines = [
    "━━━ ❓ RESPONDA NESTE GATE — ESTUDO/CASE GENÉRICO (#9673) ━━━━",
    "🔎 Modo sombra: a regra de estudo/case genérico (#9462) TIRARIA",
    "   estes itens do destaque. Responda sim ou não para CADA um.",
    "   Sem resposta = \"não lido\" (nunca conta como concordância).",
    "   Manter ou tirar o item no texto NÃO substitui a resposta.",
    "",
    ...items.map((it, i) => formatQuestion(it, i + 1)),
    "",
    '   Responda junto com o gate, ex.: "sim; 1 sim, 2 não".',
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

function normalizeAnswerToken(raw: string): "sim" | "nao" | null {
  const t = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (["sim", "s", "yes", "y", "concordo"].includes(t)) return "sim";
  if (["nao", "n", "no", "discordo"].includes(t)) return "nao";
  return null;
}

/**
 * Parseia `--answers` no formato `1=sim,2=nao` (também aceita `1:não`,
 * `1 sim`). Índice = número do item na pergunta do gate (1-based). Lança em
 * token inválido ou índice fora do intervalo — resposta mal formada não pode
 * virar `nao_lido` em silêncio.
 */
export function parseAnswersArg(raw: string | undefined, itemCount: number): Map<number, "sim" | "nao"> {
  const out = new Map<number, "sim" | "nao">();
  if (raw === undefined || raw.trim() === "") return out;
  for (const part of raw.split(/[,;]/)) {
    const p = part.trim();
    if (p === "") continue;
    const m = /^(\d+)\s*[=:\s]\s*(\S+)$/u.exec(p);
    if (!m) throw new Error(`resposta mal formada: "${p}" (esperado "N=sim" ou "N=nao")`);
    const idx = Number(m[1]);
    if (idx < 1 || idx > itemCount) {
      throw new Error(`resposta para o item ${idx}, mas há ${itemCount} item(ns) em modo sombra`);
    }
    const ans = normalizeAnswerToken(m[2]);
    if (!ans) throw new Error(`resposta inválida para o item ${idx}: "${m[2]}" (use sim/não)`);
    out.set(idx, ans);
  }
  return out;
}

function normUrl(u: string): string {
  return u.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** URLs dos destaques do `02-reviewed.md` final (normalizadas). */
export function destaqueUrls(reviewedMd: string): Set<string> {
  return new Set(parseDestaques(reviewedMd).map((d) => normUrl(d.url)).filter((u) => u !== ""));
}

/**
 * Monta o registro por item. `answers` indexado pela posição 1-based em
 * `items`. Item sem resposta ⇒ `nao_lido`, independentemente de
 * `acao_no_final`. `previous` (registro anterior da mesma edição) preserva
 * uma resposta EXPLÍCITA já gravada para a mesma URL quando esta chamada não
 * traz resposta para ela (re-registro após resume não apaga o que o editor
 * disse); uma resposta nova sempre vence.
 */
export function buildFeedback(opts: {
  items: ShadowItem[];
  answers: Map<number, "sim" | "nao">;
  /** Respostas por URL (painel do Studio). Índice e URL podem coexistir; índice vence. */
  answersByUrl?: Map<string, "sim" | "nao">;
  reviewedMd: string | null;
  now: string;
  previous?: GenericStudyFeedbackItem[];
}): GenericStudyFeedbackItem[] {
  const finalUrls = opts.reviewedMd === null ? null : destaqueUrls(opts.reviewedMd);
  const prevByUrl = new Map<string, GenericStudyFeedbackItem>();
  for (const p of opts.previous ?? []) {
    if (p.resposta === "sim" || p.resposta === "nao") prevByUrl.set(p.url, p);
  }
  return opts.items.map((it, i) => {
    const given = opts.answers.get(i + 1) ?? opts.answersByUrl?.get(it.url);
    const prev = prevByUrl.get(it.url);
    const resposta: GenericStudyAnswer = given ?? prev?.resposta ?? "nao_lido";
    const respondido_em = given ? opts.now : prev ? prev.respondido_em : null;
    const acao_no_final: GenericStudyFinalAction | null =
      finalUrls === null ? null : finalUrls.has(normUrl(it.url)) ? "manteve" : "tirou";
    return { url: it.url, titulo: it.titulo, resposta, respondido_em, acao_no_final };
  });
}

// ---------------------------------------------------------------------------
// Registro em disco (CLI do gate e painel do Studio)
// ---------------------------------------------------------------------------

export function feedbackPath(editionDir: string): string {
  return join(editionDir, "_internal", FEEDBACK_FILE);
}

/** Lê o registro gravado. Ausente/ilegível ⇒ null. */
export function readFeedbackFile(editionDir: string): GenericStudyFeedbackFile | null {
  const p = feedbackPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const f = JSON.parse(readFileSync(p, "utf8")) as Partial<GenericStudyFeedbackFile>;
    if (!Array.isArray(f.items)) return null;
    return { edition: f.edition ?? null, recorded_at: f.recorded_at ?? "", items: f.items };
  } catch {
    return null;
  }
}

/**
 * Grava `_internal/04-generic-study-feedback.json`. Retorna o arquivo
 * gravado, ou `null` quando a edição não tem item em modo sombra. Lança em
 * resposta inválida (nada é gravado). Respostas explícitas anteriores para a
 * mesma URL são preservadas quando esta chamada não traz resposta para ela.
 */
export function recordGenericStudyFeedback(opts: {
  editionDir: string;
  /** `--answers "1=sim,2=nao"` do gate no terminal. */
  answers?: string;
  /** Respostas por URL (painel do Studio). */
  answersByUrl?: Map<string, "sim" | "nao">;
  now?: string;
}): GenericStudyFeedbackFile | null {
  const items = readShadowItems(opts.editionDir);
  if (items.length === 0) return null;
  const answers = parseAnswersArg(opts.answers, items.length);
  for (const url of opts.answersByUrl?.keys() ?? []) {
    if (!items.some((it) => it.url === url)) throw new Error(`URL não está entre os itens 🔎 em modo sombra: ${url}`);
  }
  const reviewedPath = join(opts.editionDir, "02-reviewed.md");
  const reviewedMd = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
  const now = opts.now ?? new Date().toISOString();
  const edition = basename(opts.editionDir.replace(/[\\/]+$/, ""));
  const file: GenericStudyFeedbackFile = {
    edition: /^\d{6}$/.test(edition) ? edition : null,
    recorded_at: now,
    items: buildFeedback({
      items,
      answers,
      answersByUrl: opts.answersByUrl,
      reviewedMd,
      now,
      previous: readFeedbackFile(opts.editionDir)?.items ?? [],
    }),
  };
  writeFileSync(feedbackPath(opts.editionDir), JSON.stringify(file, null, 2) + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// Agregação (decisão da #9673)
// ---------------------------------------------------------------------------

export interface ShadowEditionFeedback {
  edition: string;
  items: GenericStudyFeedbackItem[];
  /** true = edição tinha itens em sombra mas nenhum registro gravado no gate. */
  sem_registro?: boolean;
}

export interface ShadowReport {
  editions: number;
  total: number;
  sim: number;
  nao: number;
  nao_lido: number;
  sem_registro: number;
  respondidos: number;
  /** Dado secundário, só informativo. */
  acao: { tirou: number; manteve: number; desconhecida: number };
  nao_items: Array<{ edition: string; titulo: string; url: string }>;
  verdict: "insuficiente" | "ligar" | "perguntar";
  verdict_text: string;
}

/**
 * Veredito usa SÓ respostas explícitas: `nao_lido` (inclui edição sem
 * registro) nunca entra na conta, nem a `acao_no_final`.
 */
export function shadowVerdict(sim: number, nao: number): Pick<ShadowReport, "verdict" | "verdict_text"> {
  const respondidos = sim + nao;
  if (respondidos < MIN_EXPLICIT_ANSWERS) {
    return {
      verdict: "insuficiente",
      verdict_text: `insuficiente — continuar perguntando (${respondidos} resposta(s) explícita(s), mínimo ${MIN_EXPLICIT_ANSWERS})`,
    };
  }
  if (nao === 0) {
    return {
      verdict: "ligar",
      verdict_text: `ligar a flag: ${sim} concordância(s) explícita(s), 0 discordâncias`,
    };
  }
  return {
    verdict: "perguntar",
    verdict_text: `levar ao editor: ${nao} discordância(s) explícita(s) em ${respondidos} — "liga mesmo assim?"`,
  };
}

export function aggregateShadowFeedback(editions: ShadowEditionFeedback[]): ShadowReport {
  let sim = 0;
  let nao = 0;
  let naoLido = 0;
  let semRegistro = 0;
  const acao = { tirou: 0, manteve: 0, desconhecida: 0 };
  const naoItems: ShadowReport["nao_items"] = [];
  let total = 0;
  for (const ed of editions) {
    for (const it of ed.items) {
      total++;
      if (it.resposta === "sim") sim++;
      else if (it.resposta === "nao") {
        nao++;
        naoItems.push({ edition: ed.edition, titulo: it.titulo, url: it.url });
      } else {
        naoLido++;
        if (ed.sem_registro) semRegistro++;
      }
      if (it.acao_no_final === "tirou") acao.tirou++;
      else if (it.acao_no_final === "manteve") acao.manteve++;
      else acao.desconhecida++;
    }
  }
  return {
    editions: editions.length,
    total,
    sim,
    nao,
    nao_lido: naoLido,
    sem_registro: semRegistro,
    respondidos: sim + nao,
    acao,
    nao_items: naoItems,
    ...shadowVerdict(sim, nao),
  };
}
