/**
 * jev.ts (#8413 — Fase 0 do epic #8412)
 *
 * Transporte reutilizável para o classificador externo TypeSafe System One
 * ("Jev", modelo `jev-latest`), generalizado a partir de
 * `classifyBatchViaTypeSafe` (`scripts/lib/semantic-tiebreaker.ts`, #8211/#8219)
 * — leia aquele módulo primeiro, este reproduz o mesmo endpoint, auth e
 * parsing de resposta, só que para QUALQUER pergunta, não só o desempate
 * `bucket` do categorizador.
 *
 * Contrato confirmado contra a API real (#8219, 17/09/2026) — mas só para o
 * tipo `choice` com 1 pergunta por request. Os tipos `score` e `noul` seguem
 * o MESMO shape de envelope (mesmo endpoint, mesma auth, `questions`/`answers`
 * como mapa por id) por analogia direta com `choice` — a issue #8412 descreve
 * os 3 tipos e a issue #8413 pede que o harness os suporte estruturalmente
 * antes de qualquer medição real os exercitar (medições 1/3/4/5/7 do epic
 * usam `noul`/`score` e são quem primeiro vai confirmar o shape exato deles
 * contra a API — mesmo processo de verificação pontual do #8219, não
 * repetido aqui). Enquanto isso, `parseJevAnswer` é permissivo o bastante
 * pra aceitar qualquer chave de resposta plausível (`probability`/`prob`,
 * `score`/`value`) e MANTÉM fail-soft: resposta com shape inesperado lança,
 * o chamador decide (mesmo padrão de `parseTypeSafeAnswer`).
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   {
 *     "model": "jev-latest",
 *     "state": { ...campos livres, ex: title/url/summary },
 *     "questions": {
 *       "<id>": { "type": "choice", "instructions", "criteria": { "<opção>": "<descrição>" } }
 *              | { "type": "score", "instructions", "min", "max" }
 *              | { "type": "noul", "instructions" }
 *     }
 *   }
 *   →
 *   {
 *     "model": "jev-1.13.0",
 *     "answers": {
 *       "<id>": { "type": "choice", "choice", "confidence", "probabilities"? }
 *              | { "type": "score", "score", "confidence" }
 *              | { "type": "noul", "probability", "confidence" }
 *     },
 *     "usage": { "input_tokens", "output_tokens" }
 *   }
 *
 * Diferença de "batch" vs. `semantic-tiebreaker.ts`: lá, "batch" é
 * concorrência entre ITENS (N requests, 1 pergunta cada). Aqui, `askJev` faz
 * 1 request por ITEM (`state`) com VÁRIAS perguntas dentro — é isso que a
 * issue #8413 chama de "a API avalia em paralelo, custo de latência ~zero
 * por pergunta extra": o ganho de empacotar é por pergunta, não por item.
 * Pra processar muitos itens concorrentemente (ex: o corpus inteiro de uma
 * medição), `askJevBatch` reusa o padrão de fila+teto de
 * `classifyBatchViaTypeSafe` (`TYPESAFE_CONCURRENCY`, mesmo valor).
 *
 * Cache em disco (#8413 item 1): chave = hash(cacheKey do item + hash
 * estável das perguntas). Reexecutar uma medição sobre o MESMO gabarito não
 * paga custo de novo — importante porque `jev-eval.ts` é rodado
 * repetidamente durante calibração (ajuste de limiar de confiança) sobre a
 * amostra rotulada, que não muda entre rodadas. Segue o padrão de
 * `scripts/lib/url-body-cache.ts` (arquivo por chave, best-effort, nunca
 * lança em falha de I/O — cache é otimização, não fonte de verdade).
 *
 * Fail-soft: nenhuma função aqui decide "o que fazer se a API falhar" — isso
 * é responsabilidade do CHAMADOR (mesmo contrato de
 * `applySemanticTiebreaker`), porque o comportamento de fallback é
 * específico de cada medição/feature. `askJev`/`askJevBatch` apenas lançam
 * em qualquer falha de transporte (rede, timeout, HTTP não-2xx, shape
 * inesperado) — nenhum teste desta unidade chama a rede real, todos injetam
 * `fetchImpl`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Teto de requests concorrentes — mesmo valor de `TYPESAFE_CONCURRENCY` em semantic-tiebreaker.ts. */
export const JEV_CONCURRENCY = 8;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;

// ---------------------------------------------------------------------------
// Tipos de pergunta
// ---------------------------------------------------------------------------

export interface JevChoiceQuestion {
  id: string;
  type: "choice";
  instructions: string;
  /** opção → descrição, casado no vocabulário aceito de `choice` na resposta. */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  id: string;
  type: "score";
  instructions: string;
  min: number;
  max: number;
}

/** "Noul" — probabilidade 0-1 de uma afirmação ser verdadeira (#8412). */
export interface JevNoulQuestion {
  id: string;
  type: "noul";
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
  id: string;
  type: "choice";
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface JevScoreAnswer {
  id: string;
  type: "score";
  score: number;
  confidence: number;
}

export interface JevNoulAnswer {
  id: string;
  type: "noul";
  probability: number;
  confidence: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export class JevHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = "JevHttpError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Cache em disco — chave = (cacheKey do item, hash das perguntas)
// ---------------------------------------------------------------------------

/**
 * Hash estável do conjunto de perguntas — ORDEM não importa (perguntas são
 * ordenadas por `id` antes do hash), então reordenar `questions` no código
 * chamador não invalida o cache.
 */
export function hashJevQuestions(questions: JevQuestion[]): string {
  const sorted = [...questions].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function cacheFilePath(cacheDir: string, cacheKey: string, questionsHash: string): string {
  const keyHash = createHash("sha1").update(cacheKey).digest("hex").slice(0, 20);
  return resolve(cacheDir, `${keyHash}-${questionsHash}.json`);
}

/** Lê o cache em disco. Retorna null se ausente, ilegível, ou cacheDir desabilitado. */
export function loadCachedJevAnswers(
  cacheDir: string | null | undefined,
  cacheKey: string,
  questions: JevQuestion[],
): JevAnswer[] | null {
  if (!cacheDir) return null;
  const path = cacheFilePath(cacheDir, cacheKey, hashJevQuestions(questions));
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JevAnswer[];
  } catch {
    return null;
  }
}

/** Grava o cache em disco. Best-effort — nunca lança (cache é otimização). */
export function saveCachedJevAnswers(
  cacheDir: string | null | undefined,
  cacheKey: string,
  questions: JevQuestion[],
  answers: JevAnswer[],
): void {
  if (!cacheDir) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
    const path = cacheFilePath(cacheDir, cacheKey, hashJevQuestions(questions));
    writeFileSync(path, JSON.stringify(answers), "utf8");
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Parsing da resposta
// ---------------------------------------------------------------------------

/**
 * Parseia/valida `answers` de UMA resposta HTTP contra as `questions`
 * pedidas. Shape estruturalmente inesperado (não é objeto, falta `answers`,
 * falta uma pergunta pedida, tipo incompatível com o pedido) LANÇA — sinal
 * de contrato quebrado, tratado como falha de transporte pelo chamador
 * (mesmo espírito de `parseTypeSafeAnswer`).
 */
export function parseJevAnswers(raw: unknown, questions: JevQuestion[]): JevAnswer[] {
  if (!raw || typeof raw !== "object") {
    throw new Error("[jev] resposta não é um objeto JSON");
  }
  const answers = (raw as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("[jev] resposta sem objeto `answers`");
  }
  const answersRec = answers as Record<string, unknown>;

  return questions.map((q) => {
    const a = answersRec[q.id];
    if (!a || typeof a !== "object") {
      throw new Error(`[jev] resposta sem \`answers.${q.id}\``);
    }
    const rec = a as Record<string, unknown>;
    switch (q.type) {
      case "choice": {
        const choice = rec.choice;
        if (typeof choice !== "string") {
          throw new Error(`[jev] \`answers.${q.id}.choice\` ausente ou não é string`);
        }
        const hasProbabilities = rec.probabilities && typeof rec.probabilities === "object";
        return {
          id: q.id,
          type: "choice",
          choice,
          confidence: toConfidence(rec.confidence),
          // Chave OMITIDA (não `undefined`) quando ausente — `undefined` explícito
          // sobrevive num objeto JS mas some num round-trip de `JSON.stringify`
          // (cache em disco), o que faria a mesma resposta comparar DIFERENTE de
          // si mesma antes/depois do cache (`deepStrictEqual` distingue "chave
          // ausente" de "chave presente com valor `undefined`").
          ...(hasProbabilities ? { probabilities: rec.probabilities as Record<string, number> } : {}),
        } satisfies JevChoiceAnswer;
      }
      case "score": {
        const score = toNumber(rec.score ?? rec.value);
        if (score === null) {
          throw new Error(`[jev] \`answers.${q.id}.score\` ausente ou não é número`);
        }
        return { id: q.id, type: "score", score, confidence: toConfidence(rec.confidence) } satisfies JevScoreAnswer;
      }
      case "noul": {
        // Contrato real confirmado ao vivo (#8414, 19/09/2026): a chave é
        // `noul`, não `probability`/`prob` como a analogia com `choice`/
        // `score` sugeria antes de qualquer medição real usar o tipo —
        // `{"type":"noul","noul":0.82}`. Mantém `probability`/`prob` como
        // fallback tolerante (não sabemos se o vendor usa nomes diferentes
        // por versão de modelo) — `noul` é só o primeiro confirmado.
        const probability = toNumber(rec.noul ?? rec.probability ?? rec.prob);
        if (probability === null) {
          throw new Error(`[jev] \`answers.${q.id}.noul\` ausente ou não é número`);
        }
        return {
          id: q.id,
          type: "noul",
          probability,
          confidence: toConfidence(rec.confidence),
        } satisfies JevNoulAnswer;
      }
    }
  });
}

function toNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `confidence` ausente vira 1 — mesma leniência de `semantic-tiebreaker.ts` (payload real do #8219 às vezes omite). */
function toConfidence(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

function questionToWire(q: JevQuestion): Record<string, unknown> {
  switch (q.type) {
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.criteria };
    case "score":
      return { type: "score", instructions: q.instructions, min: q.min, max: q.max };
    case "noul":
      return { type: "noul", instructions: q.instructions };
  }
}

// ---------------------------------------------------------------------------
// askJev — 1 item, N perguntas, 1 request (com cache + retry em 429)
// ---------------------------------------------------------------------------

export interface AskJevOptions {
  apiKey: string;
  /** Injeta fetch pra teste. Default = global fetch. Nunca chamar a rede real em teste. */
  fetchImpl?: typeof fetch;
  /** Timeout em ms pra request inteira. Default 30s. */
  timeoutMs?: number;
  /** Diretório do cache em disco. Omitido/null = sem cache. */
  cacheDir?: string | null;
  /** Chave do item pro cache — default `String(state.url ?? state.id ?? JSON.stringify(state))`. */
  cacheKey?: string;
  /** Máximo de tentativas em HTTP 429 (rate limit). Default 3. */
  maxRetries?: number;
  /** Base do backoff exponencial (ms) entre retries de 429. Default 1000. */
  retryBaseMs?: number;
}

/**
 * Chama a Jev para UM item (`state`) com uma ou mais `questions`, todas
 * avaliadas numa única request. Lança em qualquer falha de transporte —
 * quem chama decide o fallback (mesmo contrato de `applySemanticTiebreaker`).
 *
 * Cache: se `opts.cacheDir` estiver setado e já houver uma resposta salva
 * para (cacheKey, hash das perguntas), devolve do disco sem chamar a rede.
 */
export async function askJev(
  state: Record<string, unknown>,
  questions: JevQuestion[],
  opts: AskJevOptions,
): Promise<JevAnswer[]> {
  if (questions.length === 0) return [];

  const cacheKey = opts.cacheKey ?? String((state as Record<string, unknown>).url ?? (state as Record<string, unknown>).id ?? JSON.stringify(state));
  const cached = loadCachedJevAnswers(opts.cacheDir, cacheKey, questions);
  if (cached) return cached;

  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const questionsWire = Object.fromEntries(questions.map((q) => [q.id, questionToWire(q)]));

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions: questionsWire }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        lastError = new JevHttpError(429, await res.text().catch(() => "<unreadable>"));
        if (attempt < maxRetries) {
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "<unreadable>");
        throw new JevHttpError(res.status, bodyText.slice(0, 500));
      }

      const raw = (await res.json()) as unknown;
      const answers = parseJevAnswers(raw, questions);
      saveCachedJevAnswers(opts.cacheDir, cacheKey, questions, answers);
      return answers;
    } finally {
      clearTimeout(timeout);
    }
  }
  // Inatingível (o loop sempre retorna ou lança antes) — TS não infere isso.
  throw lastError instanceof Error ? lastError : new Error("[jev] falha desconhecida");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// askJevBatch — N itens concorrentes (fila com teto), reusando askJev por item
// ---------------------------------------------------------------------------

export interface JevBatchItem {
  /** Identifica o item no retorno — não precisa ser o `cacheKey` (default: mesma regra de `askJev`). */
  id: string;
  state: Record<string, unknown>;
  questions: JevQuestion[];
  cacheKey?: string;
}

export interface JevBatchResult {
  id: string;
  answers: JevAnswer[];
}

export interface AskJevBatchOptions extends Omit<AskJevOptions, "cacheKey"> {
  /** Teto de requests concorrentes. Default `JEV_CONCURRENCY`. */
  concurrency?: number;
}

/**
 * Processa vários itens concorrentemente (fila com teto de
 * `JEV_CONCURRENCY`, mesmo padrão de `classifyBatchViaTypeSafe`). Fail-soft
 * por item: erro de transporte num item específico não derruba os outros —
 * o item sai do array `results` e entra em `errors` (por `id`). Se TODOS os
 * itens falharem, lança (sinal de falha total de transporte — API fora do
 * ar, key inválida) para o chamador tratar como fallback total, mesmo
 * contrato de `classifyBatchViaTypeSafe`.
 */
export async function askJevBatch(
  items: JevBatchItem[],
  opts: AskJevBatchOptions,
): Promise<{ results: JevBatchResult[]; errors: Map<string, unknown> }> {
  if (items.length === 0) return { results: [], errors: new Map() };

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? JEV_CONCURRENCY, items.length));
  const results: JevBatchResult[] = [];
  const errors = new Map<string, unknown>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        const answers = await askJev(item.state, item.questions, { ...opts, cacheKey: item.cacheKey });
        results.push({ id: item.id, answers });
      } catch (err) {
        errors.set(item.id, err);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (errors.size === items.length) {
    throw errors.values().next().value;
  }

  return { results, errors };
}
