/**
 * jev-brazil.ts (#9552 — sucede `jev-actor-brazil.ts` do #8504)
 *
 * Pergunta Brasil do Jev (`ACTOR_BRAZIL_8416_BRAZIL`, texto EXATO da medição
 * #8416) aplicada na COLETA do mensal (`collect-monthly.ts`) e do anual
 * (`collect-annual.ts`). Devolve `brazil_p` (Noul, probabilidade 0-1 de que o
 * assunto principal envolve o Brasil) por item; o limiar e a decisão
 * (`resolveBrazilSignal`, `JEV_BRAZIL_THRESHOLD`) ficam em `collect-monthly.ts`.
 *
 * Veredito da medição (#8416, 64 itens, 3 rodadas): ADOTAR — `detectBrazil()`
 * 82,8% vs Jev 98,4%-100%, McNemar p<0,01 nas 3 rodadas. A avaliação pareada
 * da #9531 mostrou de onde vem o erro do regex: 313 das 319 divergências são
 * `detectBrazil()` marcando Brasil por domínio (.com.br) em matéria que não
 * fala do Brasil.
 *
 * Histórico: até o #9551 esta lib também fazia a pergunta de ATOR e era
 * chamada por `annotate-actor-brazil.ts` no Stage 1 DIÁRIO, atrás de
 * `jev.features.actor_brazil` (perfil `/diaria-edicao-jev`). O `brazil_p`
 * gravado ali nunca chegava ao mensal (morria em `_internal/01-categorized.json`).
 * O perfil Jev e a pergunta de ator foram aposentados pelo editor em
 * 04/10/2026 — sobrou só a pergunta Brasil, chamada direto na coleta.
 *
 * Fail-soft obrigatório (#8412 método comum, item 6): `TYPESAFE_API_KEY`
 * ausente ou falha TOTAL de transporte (rede/timeout/HTTP não-2xx) → nenhum
 * item anotado, `applied: false`, warn em `data/run-log.jsonl` — NUNCA lança,
 * nunca bloqueia a coleta. O motivo da falha total NÃO é descartado (#9558):
 * HTTP 401/403 vira `reason: "auth"` (credencial — não se resolve sozinho),
 * o resto `transport`, e o status/mensagem redigida vai no warn e em
 * `detail`. Falha PARCIAL (alguns itens falham, outros não) é
 * tratada por `askJevBatch`: os itens que falharam simplesmente não recebem
 * `brazil_p` e quem chama cai no `detectBrazil()` só para eles.
 */

import { askJevBatch, JevHttpError, type JevNoulAnswer } from "./jev.ts";
import { ACTOR_BRAZIL_8416_BRAZIL } from "./jev-questions.ts";
import { logEvent } from "./run-log.ts";

export interface BrazilItem {
  /** Identifica o item no retorno (ex: `{edição}#{posição}`). */
  id: string;
  title: string;
  url: string;
  /** Texto do item — no mensal/anual, o corpo do destaque publicado. */
  summary: string;
}

export interface ClassifyBrazilOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  concurrency?: number;
}

export interface ClassifyBrazilResult {
  /** id do item → `brazil_p`. Itens que falharam (fail-soft por item) não aparecem aqui. */
  probabilities: Map<string, number>;
  /** true = a chamada rodou (mesmo que alguns itens tenham falhado). false = falha total de transporte. */
  applied: boolean;
  /** Falha TOTAL (`applied: false`): o erro que `askJevBatch` lançou, já redigido (#9558). */
  error?: JevErrorInfo;
  /** Falha PARCIAL: erro de cada item que ficou sem resposta, já redigido (#9558). */
  itemErrors: Array<{ id: string } & JevErrorInfo>;
}

/** Erro do Jev reduzido ao que serve de diagnóstico — sem a API key (#9558). */
export interface JevErrorInfo {
  /** Status HTTP quando o erro veio da API (`JevHttpError`). */
  status?: number;
  /** Mensagem redigida (key e `Bearer …` mascarados) e truncada. */
  message: string;
}

const MAX_ERROR_MESSAGE_CHARS = 200;

/**
 * Reduz um erro do Jev a status + mensagem curta, mascarando a API key (o
 * corpo de erro da API pode ecoar o header) e qualquer `Bearer …`. @pure
 */
export function describeJevError(err: unknown, apiKey?: string): JevErrorInfo {
  const status =
    err instanceof JevHttpError
      ? err.status
      : typeof (err as { status?: unknown } | null)?.status === "number"
        ? ((err as { status: number }).status)
        : undefined;
  let message = err instanceof Error ? err.message : String(err);
  if (apiKey) message = message.split(apiKey).join("***");
  message = message.replace(/Bearer\s+\S+/gi, "Bearer ***").replace(/\s+/g, " ").trim();
  if (message.length > MAX_ERROR_MESSAGE_CHARS) message = `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`;
  return { ...(status !== undefined ? { status } : {}), message };
}

/** 401/403 = credencial (key revogada/expirada/sem permissão), não queda. @pure */
export function isJevAuthError(info: JevErrorInfo | undefined): boolean {
  return info?.status === 401 || info?.status === 403;
}

function formatJevError(info: JevErrorInfo): string {
  return info.status !== undefined ? `HTTP ${info.status} — ${info.message}` : info.message;
}

/**
 * Pergunta Brasil para um lote de itens. Falha de transporte é fail-soft:
 * devolve `applied: false` e mapa vazio — quem chama decide o resto.
 */
export async function classifyBrazil(
  items: BrazilItem[],
  opts: ClassifyBrazilOptions,
): Promise<ClassifyBrazilResult> {
  if (items.length === 0) return { probabilities: new Map(), applied: true, itemErrors: [] };

  let batch: Awaited<ReturnType<typeof askJevBatch>>;
  try {
    batch = await askJevBatch(
      items.map((item) => ({
        id: item.id,
        state: { title: item.title, url: item.url, summary: item.summary },
        questions: [ACTOR_BRAZIL_8416_BRAZIL.question],
        // Cache por URL+título: reexecutar a coleta do MESMO pipeline não paga
        // de novo. NÃO é compartilhado entre mensal e anual — o `cacheDir` é
        // por pipeline (`data/monthly/{ciclo}/_internal/jev-brazil-cache` vs
        // `data/annual/{slug}/_internal/...`), #9558.
        cacheKey: `${item.url}|||${item.title}`,
      })),
      {
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        cacheDir: opts.cacheDir,
        concurrency: opts.concurrency,
      },
    );
  } catch (err) {
    // Falha TOTAL — askJevBatch lança (o 1º erro) quando todos os itens falham.
    // O motivo é preservado (#9558): sem ele, key revogada (401) e queda
    // temporária ficavam indistinguíveis no run-log.
    return {
      probabilities: new Map(),
      applied: false,
      error: describeJevError(err, opts.apiKey),
      itemErrors: [],
    };
  }

  const probabilities = new Map<string, number>();
  for (const result of batch.results) {
    const answer = result.answers.find(
      (a): a is JevNoulAnswer => a.type === "noul" && a.id === ACTOR_BRAZIL_8416_BRAZIL.question.id,
    );
    if (!answer || !Number.isFinite(answer.probability)) continue;
    probabilities.set(result.id, answer.probability);
  }
  const itemErrors = [...batch.errors].map(([id, err]) => ({ id, ...describeJevError(err, opts.apiKey) }));
  return { probabilities, applied: true, itemErrors };
}

/** `auth` (#9558): falha total com HTTP 401/403 — credencial, não queda. */
export type BrazilJevReason = "ok" | "no-key" | "auth" | "transport" | "empty";

export interface FetchBrazilOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  /** Rótulo da coleta no run-log (ciclo mensal ou slug anual). */
  edition?: string | null;
  /** Agente no run-log (ex: `collect-monthly`). */
  agent?: string;
  rootDir?: string;
}

export interface FetchBrazilResult {
  probabilities: Map<string, number>;
  applied: boolean;
  reason: BrazilJevReason;
  /** Motivo concreto do fallback (`HTTP 401 — …`), redigido. Só em `auth`/`transport` (#9558). */
  detail?: string;
}

/** Quantos erros por item entram no warn de falha parcial. */
const PARTIAL_ERROR_SAMPLE = 3;

/**
 * Ponto de entrada de produção (#9552): resolve a key, chama o Jev, loga o
 * fallback. Sem key ou com a API fora, devolve mapa vazio — o resultado da
 * coleta fica idêntico ao `detectBrazil()` de sempre.
 */
export async function fetchBrazilProbabilities(
  items: BrazilItem[],
  opts: FetchBrazilOptions = {},
): Promise<FetchBrazilResult> {
  if (items.length === 0) return { probabilities: new Map(), applied: false, reason: "empty" };
  const rootDir = opts.rootDir ?? process.cwd();
  const agent = opts.agent ?? "jev-brazil";

  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent,
        level: "warn",
        message: "TYPESAFE_API_KEY ausente — sinal Brasil cai no detectBrazil() (regex/host/categoria) (#9552)",
      },
      rootDir,
    );
    return { probabilities: new Map(), applied: false, reason: "no-key" };
  }

  const result = await classifyBrazil(items, {
    apiKey,
    fetchImpl: opts.fetchImpl,
    cacheDir: opts.cacheDir,
  });

  if (!result.applied) {
    const auth = isJevAuthError(result.error);
    const reason: BrazilJevReason = auth ? "auth" : "transport";
    const detail = result.error ? formatJevError(result.error) : "erro desconhecido";
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent,
        level: "warn",
        message: auth
          ? `Jev recusou a credencial (${detail}) — TYPESAFE_API_KEY revogada/expirada? Sinal Brasil cai no detectBrazil() (regex/host/categoria) (#9558)`
          : `Jev indisponível (${detail}) — sinal Brasil cai no detectBrazil() (regex/host/categoria) (#9552)`,
        details: { reason, ...(result.error ?? {}) },
      },
      rootDir,
    );
    return { probabilities: new Map(), applied: false, reason, detail };
  }

  if (result.probabilities.size < items.length) {
    const sample = result.itemErrors.slice(0, PARTIAL_ERROR_SAMPLE);
    const sampleText = sample.map((e) => `${e.id}: ${formatJevError(e)}`).join("; ");
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent,
        level: "warn",
        message:
          `Jev respondeu ${result.probabilities.size}/${items.length} item(ns) — os demais caem no detectBrazil() (#9552)` +
          (sampleText ? `. Erros (amostra ${sample.length}/${result.itemErrors.length}): ${sampleText}` : ""),
        details: { item_errors: sample, item_errors_total: result.itemErrors.length },
      },
      rootDir,
    );
  }

  return { probabilities: result.probabilities, applied: true, reason: "ok" };
}
