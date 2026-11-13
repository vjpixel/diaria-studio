/**
 * clarice-pending.ts (#12257) — revisão da Clarice pendente na edição.
 *
 * Quando a API da Clarice fica fora do ar por minutos, `clarice-correct.ts`
 * estoura o teto total (`--deadline-ms`) e sai com exit 6 `clarice_unavailable`.
 * Antes do #12257 o Stage 2 terminava sem `02-reviewed.md` nem sentinela, e
 * o único jeito de seguir era reexecutar o stage inteiro (edição 261105:
 * ~15 min e um 2º spawn).
 *
 * Com este módulo o Stage 2 segue sem a Clarice e deixa a revisão como passo
 * retomável:
 *
 * - `skipClarice` grava o marcador `_internal/02-clarice-pending.json`
 *   PRIMEIRO e só então `02-reviewed.md` a partir do snapshot pré-Clarice (o
 *   texto já humanizado) e `[]` em `_internal/02-clarice-suggestions.json`
 *   (aceito por `checkClariceRan`). Marcador primeiro porque um crash no meio
 *   deixaria texto sem Clarice e sem aviso. O `[]` sozinho não distingue
 *   "rodou sem sugestões" de "não rodou": quem precisa da distinção lê o
 *   marcador (os invariantes dos Stages 4 e 5 e `collect-edition-signals.ts`).
 * - `clearClaricePending` apaga o marcador quando a Clarice roda com sucesso
 *   num rerun do Stage 2.
 * - `resumeClarice` roda a Clarice sobre o `02-reviewed.md` atual (que pode já
 *   ter edições do gate) e, em sucesso COMPLETO, grava o corrigido e apaga o
 *   marcador.
 *
 * Rodar a Clarice depois sobre o `02-reviewed.md` não aplica nada em dobro:
 * enquanto o marcador existe, a Clarice nunca rodou sobre aquele texto.
 *
 * Diferenças do resume em relação ao fluxo normal do Stage 2, tratadas aqui
 * (reviews das PRs #12291 e #12440). Na dúvida, o marcador fica (fail-closed);
 * o `reason` original nunca é sobrescrito, o desfecho de cada tentativa vai
 * em `last_outcome` e o porquê legível dela em `last_reason` (#12693, lido do
 * `{"failure"}` do clarice-correct.ts e levado ao gate pelos Stages 4 e 5):
 * - Correção parcial não conta: o resume chama a Clarice sem o fallback por
 *   parágrafo e exige o resumo do filho com `suggestions_count` numérico e
 *   `chunks_used_paragraph_fallback`/`paragraphs_failed` presentes e zerados.
 *   Faltou algum, ou os arquivos de saída não se leem: nada é aplicado
 *   (`partial`).
 * - O `02-reviewed.md` já passou pelo `render-erro-intencional` e pode ter o
 *   erro intencional plantado. A Clarice tende a corrigi-lo, o que mata o
 *   concurso. Se o `wrong_value` declarado em `_internal/intentional-error.json`
 *   some do texto corrigido, o resume NÃO aplica (`intentional-error-corrected`),
 *   a menos que o chamador aceite explicitamente. Arquivo existente mas
 *   ilegível = `protection-unreadable`, sem chamar a Clarice.
 * - O reveal da edição anterior cita de propósito o valor errado antigo. No
 *   fluxo normal ele entra depois da Clarice; aqui o parágrafo é achado com a
 *   mesma detecção do render (`extractTemplateBlock` + `pickErroIntencionalReveal`,
 *   que aceita "Na edição anterior…", "Há duas edições…") e restaurado verbatim
 *   (`restoreReveal`). Sem casar, nada aplicado (`reveal-changed`).
 * - Se o fact-check do Stage 4 já rodou (`_internal/fact-check-autofix.json`),
 *   aplica-se a mesma proteção do #11798 (`filterClariceSuggestions` com os
 *   trechos corrigidos + verbos condicionais). Havendo sugestão retida, o texto
 *   é remontado chunk a chunk (`applyChunkSuggestions` sobre os mesmos chunks
 *   que a Clarice recebeu, lidos do `--chunks-out`), como no Stage 2; qualquer
 *   sugestão mantida que não ache âncora única no chunk vira `partial`. Os pares
 *   retidos voltam em `protectedSuggestions` para o gate.
 * - O editor pode salvar o `02-reviewed.md` pelo Studio enquanto a Clarice
 *   roda. O resume confere o hash antes de copiar e não sobrescreve
 *   (`reviewed-changed`).
 * - As sugestões vão para arquivos temporários e só são promovidas a
 *   `_internal/02-clarice-suggestions.json` junto com o texto corrigido.
 * - Tentativa que falhou por API (exit 3 ou 6) marca `last_attempt_at`; outra
 *   tentativa dentro de `RESUME_COOLDOWN_MS` é pulada (`recently-attempted`,
 *   com o mesmo exit) para não gastar mais 8 min a cada volta ao gate. Outros
 *   desfechos (sem chave, I/O, parcial) não seguram a próxima tentativa.
 * - Os guards pós-Clarice do Stage 2 (travessão, É IA?, estabilidade de URL,
 *   cupons, diff) precisam rodar de novo contra o texto pré-resume, guardado em
 *   `_internal/02-pre-clarice-resume.md`. A lista sai de `postResumeSteps`.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ClariceSuggestion } from "./schemas/clarice-suggestions.ts";
import { applyChunkSuggestions } from "./clarice-chunk.ts";
import { filterClariceSuggestions } from "./clarice-suggestion-guard.ts";
import { readFactCheckProtection } from "./fact-check-protection.ts";
import { isIntentionalErrorPlaceholder } from "./intentional-errors.ts";
import { extractTemplateBlock, pickErroIntencionalReveal } from "./newsletter-parse.ts";

export const CLARICE_PENDING_REL = join("_internal", "02-clarice-pending.json");
export const PRE_CLARICE_REL = join("_internal", "02-pre-clarice.md");
export const PRE_RESUME_REL = join("_internal", "02-pre-clarice-resume.md");
export const CLARICE_SUGGESTIONS_REL = join("_internal", "02-clarice-suggestions.json");
export const RESUME_SUGGESTIONS_TMP_REL = join("_internal", "02-clarice-suggestions.resume.tmp.json");
export const RESUME_CHUNKS_TMP_REL = join("_internal", "02-clarice-chunks.resume.tmp.json");
export const CLARICE_CORRECTED_REL = join("_internal", "02-clarice-corrected.md");
export const INTENTIONAL_ERROR_REL = join("_internal", "intentional-error.json");
export const NORMALIZED_REL = join("_internal", "02-normalized.md");
export const REVIEWED_REL = "02-reviewed.md";

/** Janela em que uma tentativa de resume que falhou por API não é repetida sem `retryNow`. */
export const RESUME_COOLDOWN_MS = 20 * 60_000;

/** Exits do clarice-correct.ts que significam "API fora/lenta" — só eles seguram a próxima tentativa. */
const COOLDOWN_EXITS = new Set([3, 6]);

export interface ClaricePendingMarker {
  /** Motivo ORIGINAL do skip (ex.: `clarice_unavailable`, `mcp_down_rest_exit3_editor_approved`). Nunca sobrescrito. */
  reason: string;
  /** ISO 8601 do momento do skip. */
  skipped_at: string;
  /** Texto de onde saiu o `02-reviewed.md` (sempre o snapshot pré-Clarice). */
  source: string;
  /** Edição AAMMDD, quando conhecida (vai no comando de retomada). */
  edition?: string | null;
  /** ISO 8601 da última tentativa de resume que não aplicou nada. */
  last_attempt_at?: string;
  /** Desfecho dessa tentativa (`failed:6`, `partial`, `crashed`, ...). */
  last_outcome?: string;
  /**
   * #12693 — POR QUE essa tentativa não aplicou nada, em texto ("a Clarice não
   * respondeu em 60s...", "certificado TLS recusado (SELF_SIGNED_CERT_IN_CHAIN)").
   * Os invariantes dos Stages 4 e 5 levam ao gate.
   */
  last_reason?: string;
}

export function claricePendingPath(editionDir: string): string {
  return join(editionDir, CLARICE_PENDING_REL);
}

/** Comando de retomada. Derivado na leitura (nunca persistido), com `--edition` quando conhecida. */
export function resumeCommandFor(editionDir: string, edition?: string | null): string {
  return `npx tsx scripts/clarice-pending.ts resume --edition-dir ${editionDir}${edition ? ` --edition ${edition}` : ""}`;
}

function isMarker(v: unknown): v is ClaricePendingMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.reason === "string" && typeof m.skipped_at === "string" && typeof m.source === "string";
}

/**
 * Lê o marcador. `null` quando ausente, ilegível ou sem os campos esperados.
 * Para saber se há revisão pendente, usar `isClaricePending` (existência do
 * arquivo): um marcador malformado continua sendo pendência.
 */
export function readClaricePending(editionDir: string): ClaricePendingMarker | null {
  const p = claricePendingPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return isMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * #12693 — frase com a última tentativa de retomar e o motivo, para os
 * invariantes levarem ao gate. "" quando nenhum resume foi tentado. Termina em
 * espaço, para concatenar antes da frase seguinte.
 */
export function lastResumeAttemptNote(marker: ClaricePendingMarker | null): string {
  if (!marker?.last_attempt_at) return "";
  const outcome = marker.last_outcome ? `, ${marker.last_outcome}` : "";
  const why = marker.last_reason ? `: ${marker.last_reason}` : "";
  return `Última tentativa de retomar em ${marker.last_attempt_at}${outcome}${why}. `;
}

/** Há revisão da Clarice pendente? (o arquivo existe, legível ou não) */
export function isClaricePending(editionDir: string): boolean {
  return existsSync(claricePendingPath(editionDir));
}

function writeMarker(editionDir: string, marker: ClaricePendingMarker): void {
  writeFileSync(claricePendingPath(editionDir), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/** Apaga o marcador (a Clarice rodou com sucesso num rerun do Stage 2). Devolve se havia marcador. */
export function clearClaricePending(editionDir: string): boolean {
  const had = isClaricePending(editionDir);
  rmSync(claricePendingPath(editionDir), { force: true });
  return had;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Segue o Stage 2 sem a Clarice: marcador gravado, `02-reviewed.md` =
 * snapshot pré-Clarice, sugestões `[]`. Lança se o snapshot pré-Clarice não
 * existir (sem ele não há texto humanizado conhecido para publicar nem base
 * para o diff/estabilidade de URL do Stage 2).
 *
 * Recusa (lança) quando `02-reviewed.md` já existe, difere do snapshot e é
 * mais novo que ele: é o caso de alguém rodar `skip` de novo depois de editar
 * o reviewed no gate, e a cópia apagaria a edição. No fluxo do exit 6 isso não
 * acontece, porque o snapshot é gravado logo antes da Clarice e um reviewed de
 * rodada anterior é mais velho. `force` desliga a recusa.
 *
 * As recusas vêm antes de qualquer escrita; depois delas o marcador é a
 * PRIMEIRA escrita, para que um crash no meio nunca deixe o texto sem Clarice
 * sem o aviso.
 */
export function skipClarice(
  editionDir: string,
  reason: string,
  opts: { now?: () => Date; force?: boolean; edition?: string | null } = {},
): ClaricePendingMarker {
  const now = opts.now ?? (() => new Date());
  const pre = join(editionDir, PRE_CLARICE_REL);
  if (!existsSync(pre)) {
    throw new Error(
      `snapshot pré-Clarice ausente (${pre}) — sem ele não há texto humanizado para gravar em ${REVIEWED_REL}`,
    );
  }
  const reviewed = join(editionDir, REVIEWED_REL);
  if (
    !opts.force &&
    existsSync(reviewed) &&
    statSync(reviewed).mtimeMs > statSync(pre).mtimeMs &&
    sha256(reviewed) !== sha256(pre)
  ) {
    throw new Error(
      `${REVIEWED_REL} foi editado depois do snapshot pré-Clarice; o skip o sobrescreveria. ` +
        "Para retomar a revisão, use `resume`. Para descartar a edição, repita com --force.",
    );
  }
  const marker: ClaricePendingMarker = {
    reason,
    skipped_at: now().toISOString(),
    source: PRE_CLARICE_REL,
    edition: opts.edition ?? null,
  };
  writeMarker(editionDir, marker);
  copyFileSync(pre, reviewed);
  writeFileSync(join(editionDir, CLARICE_SUGGESTIONS_REL), "[]\n", "utf8");
  return marker;
}

/** Resultado de rodar o `clarice-correct.ts`. `crashed` = o processo nem terminou normalmente (signal/erro de spawn). */
export interface ClariceRunResult {
  exitCode: number;
  stdout: string;
  crashed?: string;
}

/** Roda `clarice-correct.ts` com os argumentos dados. Um número puro equivale a `{ exitCode, stdout: "" }`. */
export type ClariceRunner = (args: string[]) => number | ClariceRunResult;

export interface ProtectedSuggestion {
  from: string;
  to: string;
}

export type ResumeOutcome =
  | { status: "nothing-pending" }
  | {
      status: "resumed";
      preResume: string;
      applyMode: "corrected" | "filtered-chunks";
      protectedSuggestions: ProtectedSuggestion[];
    }
  | { status: "failed"; exitCode: number; reason: string }
  | { status: "crashed"; message: string }
  | { status: "partial"; detail: string }
  | { status: "reviewed-missing" }
  | { status: "protection-unreadable"; message: string }
  | {
      status: "recently-attempted";
      lastAttemptAt: string;
      lastOutcome: string;
      exitCode: number;
      lastReason?: string;
    }
  | { status: "reviewed-changed" }
  | { status: "reveal-changed" }
  | { status: "intentional-error-corrected"; wrongValue: string };

/**
 * `wrong_value` declarado (não placeholder) em `_internal/intentional-error.json`.
 * `{ ok: true, value: null }` quando o arquivo não existe ou não declara erro;
 * `{ ok: false }` quando existe mas não se lê (o resume trata como proteção
 * ilegível, fail-closed).
 */
export function readDeclaredWrongValue(
  editionDir: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const p = join(editionDir, INTENTIONAL_ERROR_REL);
  if (!existsSync(p)) return { ok: true, value: null };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { wrong_value?: unknown };
    const w = typeof j?.wrong_value === "string" ? j.wrong_value.trim() : "";
    return { ok: true, value: w && !isIntentionalErrorPlaceholder(w) ? w : null };
  } catch (e) {
    return { ok: false, message: `${INTENTIONAL_ERROR_REL} ilegível: ${(e as Error).message}` };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

const ERRO_INTENCIONAL_MARKER = "ERRO INTENCIONAL";
const ERRO_INTENCIONAL_HEADER_RE = /^(?:\*\*)?ERRO INTENCIONAL(?:\*\*)?\s*$/m;
const REVEAL_LINE = /^\s*Na\s+[úu]ltima\s+edi[çc][ãa]o\b/i;

/** Parágrafo do reveal da edição anterior, pela mesma detecção do render. `null` sem bloco ou sem reveal. */
function findReveal(text: string): string | null {
  const block = extractTemplateBlock(text, ERRO_INTENCIONAL_MARKER);
  return block ? pickErroIntencionalReveal(block) : null;
}

/**
 * Restaura verbatim, no texto corrigido, o reveal da edição anterior do texto
 * pré-resume. Com bloco ERRO INTENCIONAL, usa a detecção do render (aceita
 * ganchos além de "Na última edição"); sem bloco, cai nas linhas que começam
 * com "Na última edição", casadas por ordem. `null` quando não dá para casar
 * com segurança (reveal sumiu, bloco sumiu, número de linhas mudou).
 */
export function restoreReveal(pre: string, corrected: string): string | null {
  const preReveal = findReveal(pre);
  if (preReveal) {
    const header = ERRO_INTENCIONAL_HEADER_RE.exec(corrected);
    const postReveal = findReveal(corrected);
    if (!header || !postReveal) return null;
    const at = corrected.indexOf(postReveal, header.index);
    if (at < 0) return null;
    return corrected.slice(0, at) + preReveal + corrected.slice(at + postReveal.length);
  }
  const preReveals = pre.split("\n").filter((l) => REVEAL_LINE.test(l));
  if (preReveals.length === 0) return corrected;
  const lines = corrected.split("\n");
  const idx = lines.flatMap((l, i) => (REVEAL_LINE.test(l) ? [i] : []));
  if (idx.length !== preReveals.length) return null;
  idx.forEach((i, k) => {
    lines[i] = preReveals[k];
  });
  return lines.join("\n");
}

/** JSON de resumo do `clarice-correct.ts` (última linha do stdout que é um objeto). */
function parseRunnerSummary(stdout: string): Record<string, unknown> | null {
  for (const l of stdout.trim().split("\n").reverse()) {
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* linha que não é JSON */
    }
  }
  return null;
}

/**
 * #12693 — motivo de um exit ≠ 0 do `clarice-correct.ts`. Lê o `{"failure":
 * {...}}` que ele imprime no stdout (exits 3 e 6); sem ele, cai no significado
 * do exit. Antes o resume devolvia só o número, e o gate mostrava "Clarice
 * falhou de novo" sem dizer que a API não respondia em 60s.
 */
export function failureReasonFromRun(exitCode: number, stdout: string): string {
  const failure = parseRunnerSummary(stdout)?.failure as { message?: unknown } | undefined;
  if (failure && typeof failure.message === "string" && failure.message.trim()) return failure.message.trim();
  switch (exitCode) {
    case 2:
      return "CLARICE_API_KEY ausente no ambiente";
    case 3:
      return "erro chamando a API REST da Clarice (motivo não informado pelo clarice-correct.ts)";
    case 4:
      return "erro de leitura/escrita de arquivo no clarice-correct.ts";
    case 5:
      return "saída do clarice-correct.ts com mtime anterior à chamada (no-op suspeito, #5755)";
    case 6:
      return "a API da Clarice não respondeu dentro do teto total do clarice-correct.ts";
    default:
      return `clarice-correct.ts saiu com exit ${exitCode}`;
  }
}

/** Resumo completo = campos presentes e zerados; campo ausente conta como incompleto. */
export function isCompleteSummary(s: Record<string, unknown> | null): boolean {
  return (
    !!s &&
    typeof s.suggestions_count === "number" &&
    s.chunks_used_paragraph_fallback === 0 &&
    s.paragraphs_failed === 0
  );
}

interface ChunkEntry {
  startOffset: number;
  length: number;
  suggestions: ClariceSuggestion[];
}

/** Lê o `--chunks-out` e confere que os chunks cobrem `text` inteiro, em ordem. `null` se não bater. */
function readChunks(path: string, text: string): ChunkEntry[] | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(v)) return null;
    let pos = 0;
    for (const c of v as ChunkEntry[]) {
      if (c?.startOffset !== pos || typeof c.length !== "number" || !Array.isArray(c.suggestions)) return null;
      pos += c.length;
    }
    return pos === text.length ? (v as ChunkEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * Remonta o texto chunk a chunk só com as sugestões que a proteção mantém.
 * Devolve o texto, os pares retidos e se alguma sugestão mantida ficou sem
 * âncora única no chunk (aí o chamador trata como parcial).
 */
function rebuildFilteredByChunk(
  text: string,
  chunks: ChunkEntry[],
  protection: { correctedTexts: string[] },
): { text: string; retained: ProtectedSuggestion[]; unanchored: number } {
  const retained: ProtectedSuggestion[] = [];
  let unanchored = 0;
  let out = "";
  for (const c of chunks) {
    const chunk = { text: text.slice(c.startOffset, c.startOffset + c.length), startOffset: c.startOffset };
    const { kept, dropped } = filterClariceSuggestions(c.suggestions, {
      correctedTexts: protection.correctedTexts,
      protectConditional: true,
    });
    for (const d of dropped) {
      if (d.reason === "fact_check_protected") {
        const s = d.suggestion as ClariceSuggestion;
        retained.push({ from: s.from, to: s.to });
      }
    }
    const applied = applyChunkSuggestions(chunk, kept, () => {});
    unanchored += applied.skipped.filter((s) => /não encontrado|âncora ambígua/.test(s.reason)).length;
    out += applied.text;
  }
  return { text: out, retained, unanchored };
}

/**
 * Retoma a revisão: Clarice sobre o `02-reviewed.md` atual. Antes de chamar,
 * guarda o texto em `_internal/02-pre-clarice-resume.md` (base dos guards
 * pós-resume). Só grava `02-reviewed.md`, promove as sugestões e apaga o
 * marcador quando: o runner sai 0 com resumo completo, o `02-reviewed.md` não
 * mudou durante a chamada, o reveal da edição anterior foi restaurado, as
 * sugestões mantidas pela proteção acharam âncora e o erro intencional
 * declarado continua no texto (ou `acceptIntentionalErrorChange`). Em qualquer
 * outro caso nada muda no `02-reviewed.md` e o marcador fica.
 */
export function resumeClarice(
  editionDir: string,
  runner: ClariceRunner,
  opts: {
    edition?: string;
    acceptIntentionalErrorChange?: boolean;
    retryNow?: boolean;
    now?: () => Date;
    warn?: (msg: string) => void;
  } = {},
): ResumeOutcome {
  if (!isClaricePending(editionDir)) return { status: "nothing-pending" };
  const now = opts.now ?? (() => new Date());
  const warn = opts.warn ?? (() => {});
  const marker = readClaricePending(editionDir);

  if (!opts.retryNow && marker?.last_attempt_at && marker.last_outcome) {
    const m = /^failed:(\d+)$/.exec(marker.last_outcome);
    const lastExit = m ? Number(m[1]) : NaN;
    const last = Date.parse(marker.last_attempt_at);
    if (COOLDOWN_EXITS.has(lastExit) && Number.isFinite(last) && now().getTime() - last < RESUME_COOLDOWN_MS) {
      return {
        status: "recently-attempted",
        lastAttemptAt: marker.last_attempt_at,
        lastOutcome: marker.last_outcome,
        exitCode: lastExit,
        ...(marker.last_reason ? { lastReason: marker.last_reason } : {}),
      };
    }
  }

  const reviewed = join(editionDir, REVIEWED_REL);
  if (!existsSync(reviewed)) return { status: "reviewed-missing" };

  let protection;
  try {
    protection = readFactCheckProtection(editionDir);
  } catch (e) {
    return { status: "protection-unreadable", message: (e as Error).message };
  }
  const declared = readDeclaredWrongValue(editionDir);
  if (!declared.ok) return { status: "protection-unreadable", message: declared.message };

  const recordAttempt = (outcome: string, why: string): void => {
    const base: ClaricePendingMarker = marker ?? {
      reason: "motivo ilegível no marcador",
      skipped_at: now().toISOString(),
      source: PRE_CLARICE_REL,
    };
    writeMarker(editionDir, {
      ...base,
      edition: base.edition ?? opts.edition ?? null,
      last_attempt_at: now().toISOString(),
      last_outcome: outcome,
      last_reason: why,
    });
  };
  const partial = (detail: string): ResumeOutcome => {
    recordAttempt("partial", `correção parcial ou não verificável: ${detail}`);
    return { status: "partial", detail };
  };

  const preResume = join(editionDir, PRE_RESUME_REL);
  copyFileSync(reviewed, preResume);
  const hashBefore = sha256(reviewed);
  const corrected = join(editionDir, CLARICE_CORRECTED_REL);
  const tmpSuggestions = join(editionDir, RESUME_SUGGESTIONS_TMP_REL);
  const tmpChunks = join(editionDir, RESUME_CHUNKS_TMP_REL);
  rmSync(tmpSuggestions, { force: true });
  rmSync(tmpChunks, { force: true });
  const args = [
    "--in", preResume,
    "--out", tmpSuggestions,
    "--corrected-out", corrected,
    "--chunks-out", tmpChunks,
    "--retry",
    // Sem o fallback por parágrafo: ele sai 0 com parágrafos sem correção.
    "--no-paragraph-fallback",
    // #12693: as tentativas do resume vão ao run-log como Stage 4 (antes saíam
    // com o default, Stage 2, e pareciam do Stage 2).
    "--stage", "4",
    ...(opts.edition ? ["--edition", opts.edition] : []),
  ];
  const raw = runner(args);
  const run: ClariceRunResult = typeof raw === "number" ? { exitCode: raw, stdout: "" } : raw;
  if (run.crashed) {
    recordAttempt("crashed", `clarice-correct.ts não terminou (${run.crashed})`);
    return { status: "crashed", message: run.crashed };
  }
  if (run.exitCode !== 0) {
    const reason = failureReasonFromRun(run.exitCode, run.stdout);
    recordAttempt(`failed:${run.exitCode}`, reason);
    return { status: "failed", exitCode: run.exitCode, reason };
  }
  if (!isCompleteSummary(parseRunnerSummary(run.stdout))) {
    return partial("resumo do clarice-correct ausente, ilegível ou com fallback/parágrafo falho");
  }
  let suggestions: ClariceSuggestion[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(tmpSuggestions, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("sugestões não são array");
    suggestions = parsed as ClariceSuggestion[];
  } catch (e) {
    return partial(`sugestões do resume ilegíveis (${(e as Error).message})`);
  }
  if (!existsSync(corrected)) return partial("texto corrigido ausente");
  // #12693 — os três desfechos abaixo falaram com a Clarice: gravar a tentativa,
  // senão o gate segue mostrando o `last_reason` de uma falha de API anterior.
  if (!existsSync(reviewed) || sha256(reviewed) !== hashBefore) {
    recordAttempt(
      "reviewed-changed",
      `a Clarice respondeu, mas o ${REVIEWED_REL} mudou durante a chamada; nada aplicado`,
    );
    return { status: "reviewed-changed" };
  }

  const preText = readFileSync(preResume, "utf8");
  let finalText = readFileSync(corrected, "utf8");
  let applyMode: "corrected" | "filtered-chunks" = "corrected";
  let protectedSuggestions: ProtectedSuggestion[] = [];
  if (protection.present) {
    const anyRetained = filterClariceSuggestions(suggestions, {
      correctedTexts: protection.correctedTexts,
      protectConditional: true,
    }).dropped.some((d) => d.reason === "fact_check_protected");
    if (anyRetained) {
      const chunks = readChunks(tmpChunks, preText);
      if (!chunks) return partial("sugestões por chunk ausentes ou sem cobrir o texto");
      const rebuilt = rebuildFilteredByChunk(preText, chunks, protection);
      if (rebuilt.unanchored > 0) {
        return partial(`${rebuilt.unanchored} sugestão(ões) mantida(s) sem âncora única no chunk`);
      }
      finalText = rebuilt.text;
      protectedSuggestions = rebuilt.retained;
      applyMode = "filtered-chunks";
    }
  }

  const restored = restoreReveal(preText, finalText);
  if (restored === null) {
    recordAttempt(
      "reveal-changed",
      "a Clarice respondeu, mas mexeu no reveal da edição anterior a ponto de não dar para restaurá-lo; nada aplicado",
    );
    return { status: "reveal-changed" };
  }
  finalText = restored;

  const wrongValue = declared.value;
  if (wrongValue) {
    const before = countOccurrences(preText, wrongValue);
    if (before === 0) {
      warn(`o erro intencional declarado ("${wrongValue}") não aparece no ${REVIEWED_REL}: nada a proteger`);
    } else if (!opts.acceptIntentionalErrorChange && countOccurrences(finalText, wrongValue) < before) {
      recordAttempt(
        "intentional-error-corrected",
        `a Clarice respondeu, mas corrigiu o erro intencional declarado ("${wrongValue}"); nada aplicado`,
      );
      return { status: "intentional-error-corrected", wrongValue };
    }
  }

  writeFileSync(reviewed, finalText, "utf8");
  renameSync(tmpSuggestions, join(editionDir, CLARICE_SUGGESTIONS_REL));
  rmSync(tmpChunks, { force: true });
  rmSync(claricePendingPath(editionDir), { force: true });
  return { status: "resumed", preResume: PRE_RESUME_REL, applyMode, protectedSuggestions };
}

/**
 * Passos que o Stage 2 roda depois de qualquer passada da Clarice
 * (`.claude/agents/orchestrator-stage-2.md` §2b), com o texto pré-resume como
 * base. Mesma ordem do Stage 2 para travessão, É IA?, URL e cupons; o diff,
 * que no Stage 2 vem antes do strip, aqui vai por último para mostrar o texto
 * final. Os dois primeiros consertam sozinhos; os dois `verify-*` só reportam
 * (exit 1 = achado para o gate, nunca auto-restaurar; exit ≥ 2 = o check não
 * rodou); o diff leva o `02-normalized.md` como 4º argumento quando existe
 * (sinaliza reversão do humanizador, #3929).
 */
export function postResumeSteps(editionDir: string): Array<{ name: string; args: string[]; reportOnly: boolean }> {
  const pre = join(editionDir, PRE_RESUME_REL);
  const reviewed = join(editionDir, REVIEWED_REL);
  const normalized = join(editionDir, NORMALIZED_REL);
  return [
    { name: "strip-emdashes-reviewed", args: ["scripts/strip-emdashes-reviewed.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "sync-eia-block", args: ["scripts/sync-eia-block.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "verify-clarice-url-stability", args: ["scripts/verify-clarice-url-stability.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    { name: "verify-clarice-coupons", args: ["scripts/verify-clarice-coupons.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    {
      name: "clarice-diff",
      args: [
        "scripts/clarice-diff.ts",
        pre,
        reviewed,
        join(editionDir, "_internal", "02-clarice-diff.md"),
        ...(existsSync(normalized) ? [normalized] : []),
      ],
      reportOnly: false,
    },
  ];
}

/** Desfecho de um passo pós-Clarice: `crashed` = signal/erro de spawn, nunca vira "achado". */
export interface PostStepRun {
  name: string;
  reportOnly: boolean;
  exit: number;
  crashed?: string;
}

/**
 * Classifica os passos pós-Clarice: falha dura (passo que conserta sozinho com
 * exit ≠ 0, qualquer `verify-*` com exit ≥ 2 ou crash) versus achado para o
 * gate (`verify-*` com exit 1).
 */
export function classifyPostSteps(steps: PostStepRun[]): { hardFailures: PostStepRun[]; attention: PostStepRun[] } {
  const hardFailures: PostStepRun[] = [];
  const attention: PostStepRun[] = [];
  for (const s of steps) {
    if (s.crashed) hardFailures.push(s);
    else if (s.exit === 0) continue;
    else if (s.reportOnly && s.exit === 1) attention.push(s);
    else hardFailures.push(s);
  }
  return { hardFailures, attention };
}
