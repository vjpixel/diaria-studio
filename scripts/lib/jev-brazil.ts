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
 * nunca bloqueia a coleta. Falha PARCIAL (alguns itens falham, outros não) é
 * tratada por `askJevBatch`: os itens que falharam simplesmente não recebem
 * `brazil_p` e quem chama cai no `detectBrazil()` só para eles.
 */

import { askJevBatch, type JevNoulAnswer } from "./jev.ts";
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
}

/**
 * Pergunta Brasil para um lote de itens. Falha de transporte é fail-soft:
 * devolve `applied: false` e mapa vazio — quem chama decide o resto.
 */
export async function classifyBrazil(
  items: BrazilItem[],
  opts: ClassifyBrazilOptions,
): Promise<ClassifyBrazilResult> {
  if (items.length === 0) return { probabilities: new Map(), applied: true };

  let batch: Awaited<ReturnType<typeof askJevBatch>>;
  try {
    batch = await askJevBatch(
      items.map((item) => ({
        id: item.id,
        state: { title: item.title, url: item.url, summary: item.summary },
        questions: [ACTOR_BRAZIL_8416_BRAZIL.question],
        // Cache por URL+título: o mesmo destaque aparece no mensal e no anual,
        // e reexecutar a coleta não paga de novo.
        cacheKey: `${item.url}|||${item.title}`,
      })),
      {
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        cacheDir: opts.cacheDir,
        concurrency: opts.concurrency,
      },
    );
  } catch {
    // Falha TOTAL de transporte — askJevBatch lança quando todos os itens falham.
    return { probabilities: new Map(), applied: false };
  }

  const probabilities = new Map<string, number>();
  for (const result of batch.results) {
    const answer = result.answers.find(
      (a): a is JevNoulAnswer => a.type === "noul" && a.id === ACTOR_BRAZIL_8416_BRAZIL.question.id,
    );
    if (!answer || !Number.isFinite(answer.probability)) continue;
    probabilities.set(result.id, answer.probability);
  }
  return { probabilities, applied: true };
}

export type BrazilJevReason = "ok" | "no-key" | "transport" | "empty";

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
}

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
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent,
        level: "warn",
        message: "Jev indisponível — sinal Brasil cai no detectBrazil() (regex/host/categoria) (#9552)",
      },
      rootDir,
    );
    return { probabilities: new Map(), applied: false, reason: "transport" };
  }

  if (result.probabilities.size < items.length) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent,
        level: "warn",
        message: `Jev respondeu ${result.probabilities.size}/${items.length} item(ns) — os demais caem no detectBrazil() (#9552)`,
      },
      rootDir,
    );
  }

  return { probabilities: result.probabilities, applied: true, reason: "ok" };
}
