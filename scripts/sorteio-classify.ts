#!/usr/bin/env npx tsx
/**
 * sorteio-classify.ts (#929)
 *
 * Pure classifier para respostas pendentes do sorteio mensal "ache o
 * erro, ganhe um número". Consumido pelo passo `0p` do orchestrator
 * Stage 0 e pela skill `/diaria-sorteio` em modo batch.
 *
 * Não fala com Gmail. O orchestrator (que tem MCP Gmail) busca threads
 * pendentes, monta o input JSON, e passa pra esta CLI via stdin ou
 * `--input file`. O classificador:
 *
 *   1. Filtra threads já processadas (dedup por `thread_id` em
 *      `data/contest-entries.jsonl`).
 *   2. Para cada thread restante, infere `error_type` (heurística por
 *      keywords), `edition_guessed` (regex do body), e cruza com
 *      `data/intentional-errors.jsonl` pra um `gabarito_match` de 'hit'
 *      | 'miss' | 'unclear'.
 *   3. Recomenda 'APPROVE' / 'REJECT' / 'REVIEW' conforme combinação.
 *
 * Editor sempre confirma — classifier nunca decide sozinho (regra #573).
 *
 * Uso:
 *   echo '[{...}]' | npx tsx scripts/sorteio-classify.ts \
 *     --output data/editions/260507/_internal/sorteio-pending.json
 *
 *   npx tsx scripts/sorteio-classify.ts \
 *     --input data/_sorteio-input.json \
 *     --output data/editions/260507/_internal/sorteio-pending.json
 *
 * Exit codes:
 *   0 = success (mesmo com 0 candidates — não é erro)
 *   2 = validation error (input malformado, arquivo ausente)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "./lib/cli-args.ts";
import { loadEntries, findByThreadId } from "./lib/contest-entries.ts";
import { loadIntentionalErrors, type IntentionalError } from "./lib/intentional-errors.ts";

const ENTRIES_PATH = resolve(process.cwd(), "data/contest-entries.jsonl");
const INTENTIONAL_PATH = resolve(process.cwd(), "data/intentional-errors.jsonl");

/** Input format esperado do orchestrator (1 entry por thread Gmail). */
export interface RawThread {
  thread_id: string;
  sender_email: string;
  sender_name: string;
  subject: string;
  /** Corpo da resposta — pode ser multi-mensagem mas concatenado em string única. */
  body: string;
  /** ISO timestamp da mensagem mais recente da thread. */
  received_iso: string;
}

/** Output enriquecido pelo classifier. */
export interface ClassifiedCandidate {
  thread_id: string;
  sender_email: string;
  sender_name: string;
  subject: string;
  received_iso: string;
  body_excerpt: string;
  /** AAMMDD inferido do body — string vazia se não conseguiu detectar. */
  edition_guessed: string;
  /** Heurística baseada em keywords no body. */
  error_type_guess: string;
  /** Cross-reference contra intentional-errors.jsonl. */
  gabarito_match: "hit" | "miss" | "unclear";
  /** Sugestão pra editor — sempre confirma manualmente. */
  recommendation: "APPROVE" | "REJECT" | "REVIEW";
  /** Justificativa curta (1 frase) — apresentada ao editor pra contexto. */
  reason: string;
}

/**
 * Pure: extrai AAMMDD da assinatura padrão Diar.ia ou de menção direta.
 *
 *   "Diar.ia 260507 ..." → "260507"
 *   "edição de ontem 260506" → "260506"
 *   "(diar.ia.br/edicao/260505)" → "260505"
 *
 * Retorna string vazia se não bateu — caller decide se é REVIEW.
 */
export function guessEditionFromBody(body: string): string {
  if (!body) return "";
  // Procurar AAMMDD em contextos plausíveis (próximo a "diar.ia", "edição",
  // ou na URL `/edicao/AAMMDD`). Conservador: só aceita 6 dígitos
  // começando com `2[5-9]` (anos 2025-2029) — evita falso-positivo de
  // CEP, ID do Twitter, etc.
  const patterns = [
    /\/edicao\/(2[5-9]\d{4})\b/,
    /(?:edi[çc][ãa]o|edition)[^\d\n]{0,20}(2[5-9]\d{4})\b/i,
    /(?:diar\.?ia)[^\d\n]{0,30}(2[5-9]\d{4})\b/i,
    /\b(2[5-9]\d{4})\b/, // último recurso — qualquer AAMMDD plausível
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    if (m) return m[1];
  }
  return "";
}

/**
 * Pure: heurística rápida baseada em keywords no body. Mesma lógica
 * descrita em `.claude/skills/diaria-sorteio/SKILL.md` Passo 3 — extraída
 * pra TS pra não depender do editor lembrar.
 */
export function guessErrorType(body: string): string {
  if (!body) return "unknown";
  const lower = body.toLowerCase();
  if (/\bv\s*\d+\b|\bvers[ãa]o\s*\d+\b|\bversion\s*\d+\b/.test(lower)) {
    return "version_inconsistency";
  }
  if (/\b(typo|erro de digita[çc][ãa]o|grafia)\b/.test(lower)) return "typo";
  if (/\b(matem[áa]tic|conta|c[áa]lculo|n[úu]mero)\b/.test(lower)) return "math";
  if (/desatualizad|outdated|\bantig/.test(lower)) return "outdated";
  if (/\b(data|nome|lugar|cidade|pa[íi]s)\b/.test(lower)) return "factual";
  return "unknown";
}

/**
 * Pure: cruza o palpite do classifier contra `data/intentional-errors.jsonl`
 * pra dizer se o leitor acertou (`hit`), errou (`miss`) ou se não dá pra saber
 * (`unclear` — edição não identificada ou sem erro registrado pra ela).
 */
export function classifyGabarito(
  candidate: { edition_guessed: string; error_type_guess: string; body: string },
  intentional: IntentionalError[],
): "hit" | "miss" | "unclear" {
  if (!candidate.edition_guessed) return "unclear";
  const editionErrors = intentional.filter(
    (e) => e.edition === candidate.edition_guessed && e.is_feature,
  );
  if (editionErrors.length === 0) return "unclear";
  // Match por tipo (heurística do classifier acertou) OU
  // por ocorrência substring do `detail` no body (texto literal do leitor
  // bateu palavras-chave do gabarito).
  for (const err of editionErrors) {
    if (
      err.error_type === candidate.error_type_guess &&
      candidate.error_type_guess !== "unknown"
    ) {
      return "hit";
    }
    if (err.detail && candidate.body) {
      const detailWords = err.detail
        .toLowerCase()
        .split(/[\s,/.()]+/)
        .filter((w) => w.length >= 3);
      const lowerBody = candidate.body.toLowerCase();
      // 2+ palavras significativas do gabarito no body → hit
      const overlap = detailWords.filter((w) => lowerBody.includes(w)).length;
      if (overlap >= 2) return "hit";
    }
  }
  return "miss";
}

/** Pure: monta a recomendação editorial a partir do classify. */
export function recommend(
  gabarito: "hit" | "miss" | "unclear",
  errorType: string,
  hasEdition: boolean,
): { recommendation: "APPROVE" | "REJECT" | "REVIEW"; reason: string } {
  if (gabarito === "hit" && errorType !== "unknown") {
    return {
      recommendation: "APPROVE",
      reason: "match com gabarito + error_type identificado",
    };
  }
  if (gabarito === "miss" && hasEdition) {
    return {
      recommendation: "REJECT",
      reason: "edição identificada mas resposta não bate com gabarito",
    };
  }
  if (gabarito === "unclear" && !hasEdition) {
    return {
      recommendation: "REVIEW",
      reason: "edição não identificada no body — verificar manualmente",
    };
  }
  // Caso ambíguo (hit com error_type=unknown, ou miss sem edição): REVIEW.
  return {
    recommendation: "REVIEW",
    reason: "match parcial — editor confirma",
  };
}

/**
 * Pure: classifica array de threads. Retorna apenas as não-processadas.
 * Threads com `thread_id` já em entries do mês corrente (ou qualquer mês)
 * são silenciosamente filtradas — idempotência via `findByThreadId`.
 */
export function classify(
  threads: RawThread[],
  alreadyProcessed: Set<string>,
  intentional: IntentionalError[],
): ClassifiedCandidate[] {
  const candidates: ClassifiedCandidate[] = [];
  for (const t of threads) {
    if (alreadyProcessed.has(t.thread_id)) continue;
    const editionGuessed = guessEditionFromBody(t.body);
    const errorTypeGuess = guessErrorType(t.body);
    const gabarito = classifyGabarito(
      {
        edition_guessed: editionGuessed,
        error_type_guess: errorTypeGuess,
        body: t.body,
      },
      intentional,
    );
    const { recommendation, reason } = recommend(
      gabarito,
      errorTypeGuess,
      Boolean(editionGuessed),
    );
    candidates.push({
      thread_id: t.thread_id,
      sender_email: t.sender_email,
      sender_name: t.sender_name,
      subject: t.subject,
      received_iso: t.received_iso,
      body_excerpt: t.body.slice(0, 240).replace(/\s+/g, " ").trim(),
      edition_guessed: editionGuessed,
      error_type_guess: errorTypeGuess,
      gabarito_match: gabarito,
      recommendation,
      reason,
    });
  }
  return candidates;
}

function loadInputThreads(inputArg: string | undefined): RawThread[] {
  let raw: string;
  if (inputArg) {
    raw = readFileSync(resolve(process.cwd(), inputArg), "utf8");
  } else {
    // Read stdin
    raw = readFileSync(0, "utf8");
  }
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("input must be a JSON array of RawThread");
  }
  return parsed as RawThread[];
}

function main(): number {
  const { values } = parseArgs(process.argv.slice(2));
  const outputPath = values["output"];
  if (!outputPath) {
    process.stderr.write("Erro: --output OBRIGATÓRIO\n");
    return 2;
  }

  let threads: RawThread[];
  try {
    threads = loadInputThreads(values["input"]);
  } catch (err) {
    process.stderr.write(
      `Erro carregando input: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const entries = loadEntries(ENTRIES_PATH);
  const alreadyProcessed = new Set(entries.map((e) => e.reply_thread_id));
  const intentional = loadIntentionalErrors(INTENTIONAL_PATH);

  const candidates = classify(threads, alreadyProcessed, intentional);

  const result = {
    generated_at: new Date().toISOString(),
    total_input: threads.length,
    already_processed: threads.filter((t) => alreadyProcessed.has(t.thread_id)).length,
    candidates,
  };

  mkdirSync(dirname(resolve(process.cwd(), outputPath)), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), outputPath),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}

// Re-exports pra uso externo (testes, importação direta)
export { findByThreadId };
