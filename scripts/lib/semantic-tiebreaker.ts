/**
 * semantic-tiebreaker.ts (#8211)
 *
 * Classificador semântico externo (TypeSafe System One / modelo `jev-latest`,
 * ver #8211/#5995) como TIE-BREAKER do fallback do categorizador. A #5995
 * mediu com gabarito limpo (rotulagem às cegas, `scripts/blind-label-sample.ts`,
 * PR #8206) que o categorizador acerta 54,5% — e que TODO o erro medido está
 * concentrado nos dois defaults silenciosos de `categorizeWithRule`
 * (`lancamento-default`/`noticias-default`, ver `isFallbackCategorizationRule`
 * em `scripts/lib/launch-heuristics.ts`), 77% do corpus. As ~20 regras fortes
 * acumuladas na #5995 não erraram uma vez na amostra.
 *
 * Este módulo é deliberadamente um passo de PÓS-PROCESSAMENTO, atrás de flag,
 * que roda DEPOIS de `categorizeArticles()` (scripts/categorize.ts) já ter
 * atribuído bucket/rule a cada artigo — nunca dentro de `categorizeWithRule`.
 * As regras fortes (0 erro medido) ficam intocadas; só os dois pontos de
 * fallback verdadeiro são reconsiderados, e só quando a flag está ligada e o
 * classificador responde. Ver `applySemanticTiebreaker` abaixo.
 *
 * Contrato confirmado (#8219, 17/09/2026) contra a API real — 1 chamada de
 * verificação manual, `POST https://api.typesafe.ai/v1/systemone`, `200` com
 * o shape abaixo. Antes desta correção o transporte era uma SUPOSIÇÃO
 * plausível (endpoint `/v1/questions/batch`, request com array `questions`
 * casado por `id`, resposta com array `answers`) que nunca tinha sido
 * verificada — sempre caía no fail-soft em produção (flag "ligada" mas o
 * classificador nunca respondia de verdade, #8219). O contrato real foi
 * recuperado do script de medição original do #5995/#8211
 * (`scripts/experiments/typesafe-bucket-eval.ts`, nunca versionado — ver
 * #8219 pra onde ele foi achado) e confirmado byte-a-byte com uma chamada
 * real:
 *
 *   POST /v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { "model": "jev-latest",
 *     "state": { "title", "url", "summary" },
 *     "questions": { "bucket": { "type": "choice", "instructions", "criteria": { "lancamento", "radar" } } } }
 *   →
 *   { "model": "jev-1.13.0",
 *     "answers": { "bucket": { "type": "choice", "choice": "lancamento", "confidence": 1.0, "probabilities": {...} } },
 *     "usage": { "input_tokens", "output_tokens" } }
 *
 * A API não expõe um endpoint de BATCH real (um `POST` = uma pergunta sobre
 * um item) — o script de medição original também fazia 1 request por item,
 * só com concorrência (`Promise.all` em lotes de 8). `classifyBatchViaTypeSafe`
 * abaixo reproduz esse padrão: N requests concorrentes (teto
 * `TYPESAFE_CONCURRENCY`), nunca 1 request com N itens dentro — a leitura de
 * "batchar" no item 5 do #8211 era sobre concorrência, não sobre um payload
 * de array único (não confirmado, e a issue nunca citou o shape de um batch
 * real). Isolado nesta única função de transporte por design (mesmo padrão
 * de antes) — nenhum teste desta unidade chama a rede de verdade, todos
 * injetam `fetchImpl` stubado.
 *
 * Fail-soft (#8211 item 4): `TYPESAFE_API_KEY` ausente, timeout, erro de
 * rede, HTTP não-2xx, ou resposta que não bate o shape esperado →
 * `applySemanticTiebreaker` devolve o `CategorizedBuckets` ORIGINAL sem
 * nenhuma alteração — nunca trava o Stage 1. Cada fallback é logado em
 * `data/run-log.jsonl` (nível warn) via `scripts/lib/run-log.ts`.
 *
 * Composição com #160 (#8211 item 2): veredito `lancamento` do classificador
 * só é aceito quando a URL é de domínio oficial (`isOfficialLancamentoUrl`,
 * `scripts/lib/launch-heuristics.ts`) — senão vira `radar`. O classificador
 * pode entender que o CONTEÚDO é sobre um lançamento sem saber que o link é
 * de imprensa/terceiro; a regra #160 (LANÇAMENTOS só com link oficial) sempre
 * vence essa leitura.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Article } from "./types/article.ts";
import { isFallbackCategorizationRule, isOfficialLancamentoUrl } from "./launch-heuristics.ts";
import { logEvent } from "./run-log.ts";

// ---------------------------------------------------------------------------
// Config (#8211 item 3 — atrás de flag, default LIGADO por decisão do editor)
// ---------------------------------------------------------------------------

export interface SemanticTiebreakerConfig {
  enabled?: boolean;
}

/**
 * Lê `semantic_tiebreaker` de `platform.config.json`. Fail-soft: arquivo
 * ausente ou JSON malformado → `{ enabled: false }` — um config quebrado
 * nunca deve LIGAR sozinho uma chamada de rede nova; o default seguro em caso
 * de erro é desligado, mesmo que o valor documentado/comitado seja `true`
 * (mesmo padrão de `readSocialCriticConfig`, `scripts/run-social-critic.ts`).
 */
export function readSemanticTiebreakerConfig(configPath: string): SemanticTiebreakerConfig {
  if (!existsSync(configPath)) return { enabled: false };
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      semantic_tiebreaker?: SemanticTiebreakerConfig;
    };
    return cfg.semantic_tiebreaker ?? { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function isSemanticTiebreakerEnabled(configPath: string): boolean {
  return readSemanticTiebreakerConfig(configPath).enabled === true;
}

// ---------------------------------------------------------------------------
// Transporte — contrato confirmado (#8219, ver aviso no topo do arquivo)
// ---------------------------------------------------------------------------

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";

/** Teto de requests concorrentes por edição — mesmo valor usado no script de
 * medição original do #5995/#8211 (`typesafe-bucket-eval.ts`, `CONC = 8`). */
const TYPESAFE_CONCURRENCY = 8;

/**
 * Critérios passados ao classificador (questão `bucket`, tipo `choice`) —
 * mesmo espírito do #160 (LANÇAMENTOS só com link oficial) e do resíduo
 * medido na #5995: distinguir "anúncio oficial de produto/feature que o
 * leitor pode usar" de "notícia/cobertura/relatório/marco institucional
 * sobre a empresa". Só as duas chaves que o tie-breaker sabe interpretar —
 * `use_melhor` fica fora de propósito (#8211 escopo: "só o fallback, não
 * encostar nas regras fortes"; este módulo nunca move nada PARA use_melhor).
 * Texto deliberadamente curto — a issue reporta que o controle contra
 * prompt-tuning (texto de critério ORIGINAL, escrito antes de conhecer o
 * corpus) deu o mesmo resultado.
 */
const TIEBREAKER_INSTRUCTIONS =
  "Este link anuncia o LANÇAMENTO de um produto, feature ou modelo de IA que " +
  "o leitor pode usar diretamente, ou é notícia/cobertura de imprensa/" +
  "relatório/marco institucional/parceria de negócio/opinião sobre a " +
  "empresa ou produto?";

const TIEBREAKER_CRITERIA: Record<string, string> = {
  lancamento:
    "Anúncio OFICIAL, feito pela própria empresa que o criou, de um produto, " +
    "ferramenta, modelo ou feature NOVA que o leitor pode começar a usar.",
  radar:
    "Notícia, análise, entrevista, ensaio, relatório, pesquisa, marco " +
    "corporativo ou anúncio institucional — sem lançar um produto usável.",
};

export class TypeSafeHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = "TypeSafeHttpError";
    this.status = status;
  }
}

export type TieBreakerVerdict = "lancamento" | "radar";

export interface TieBreakerQuestionItem {
  url: string;
  title: string;
  summary: string;
}

export interface TieBreakerAnswer {
  url: string;
  verdict: TieBreakerVerdict;
}

export interface ClassifyBatchOptions {
  apiKey: string;
  items: TieBreakerQuestionItem[];
  /** Opcional — injeta fetch pra testes. Default = global fetch. Nunca chamar a rede real em teste. */
  fetchImpl?: typeof fetch;
  /** Timeout em ms pra request inteira (batch). Default 30s. */
  timeoutMs?: number;
}

/**
 * Chama a TypeSafe pra UM item (a API não tem endpoint de batch real — ver
 * aviso no topo do arquivo). Lança em qualquer falha de transporte (rede,
 * timeout, HTTP não-2xx, shape estruturalmente inesperado) — quem chama
 * (`classifyBatchViaTypeSafe`) decide se isso derruba só o item ou o lote
 * inteiro.
 */
async function classifyOneViaTypeSafe(
  item: TieBreakerQuestionItem,
  apiKey: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<TieBreakerAnswer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        state: { title: item.title, url: item.url, summary: item.summary },
        questions: {
          bucket: {
            type: "choice",
            instructions: TIEBREAKER_INSTRUCTIONS,
            criteria: TIEBREAKER_CRITERIA,
          },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable>");
    throw new TypeSafeHttpError(res.status, bodyText.slice(0, 500));
  }

  const raw = (await res.json()) as unknown;
  const verdict = parseTypeSafeAnswer(raw);
  return verdict ? { url: item.url, verdict } : null;
}

/**
 * Chama a TypeSafe pra todos os itens do lote — N requests concorrentes
 * (teto `TYPESAFE_CONCURRENCY`), nunca 1 request com N itens dentro (ver
 * aviso no topo do arquivo). Fail-soft de DUAS camadas:
 *   - por item: erro de transporte num item específico não derruba os
 *     outros — o item some do retorno e `applySemanticTiebreaker` mantém o
 *     bucket original pra ele.
 *   - por lote: se TODOS os itens falharem (ex: API fora do ar, key
 *     inválida), lança — `applySemanticTiebreaker` trata como falha total de
 *     transporte, loga e devolve os buckets originais sem nenhuma alteração
 *     (mesmo contrato de antes, só a implementação interna mudou).
 */
export async function classifyBatchViaTypeSafe(opts: ClassifyBatchOptions): Promise<TieBreakerAnswer[]> {
  if (opts.items.length === 0) return [];
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const concurrency = Math.max(1, Math.min(TYPESAFE_CONCURRENCY, opts.items.length));

  const results: Array<TieBreakerAnswer | null> = new Array(opts.items.length).fill(null);
  const errors: unknown[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < opts.items.length) {
      const idx = cursor++;
      try {
        results[idx] = await classifyOneViaTypeSafe(opts.items[idx], opts.apiKey, fetchFn, timeoutMs);
      } catch (err) {
        errors.push(err);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (errors.length === opts.items.length) {
    throw errors[0];
  }

  return results.filter((r): r is TieBreakerAnswer => r !== null);
}

/**
 * Parseia/valida a resposta de UM item da TypeSafe. Exposto pra teste — não
 * faz I/O. Shape estruturalmente inesperado (não é objeto, sem `answers`,
 * sem `answers.bucket`) LANÇA — sinal de que o contrato mudou, tratado como
 * falha de transporte pelo chamador. `choice` que não bate nenhuma das
 * `TIEBREAKER_CRITERIA` (ex: a API respondeu algo fora do vocabulário
 * esperado) devolve `null` sem lançar — item fica sem verdict,
 * `applySemanticTiebreaker` mantém o bucket original pra ele.
 */
export function parseTypeSafeAnswer(raw: unknown): TieBreakerVerdict | null {
  if (!raw || typeof raw !== "object") {
    throw new Error("[semantic-tiebreaker] resposta da TypeSafe não é um objeto JSON");
  }
  const answers = (raw as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("[semantic-tiebreaker] resposta da TypeSafe sem objeto `answers`");
  }
  const bucket = (answers as Record<string, unknown>).bucket;
  if (!bucket || typeof bucket !== "object") {
    throw new Error("[semantic-tiebreaker] resposta da TypeSafe sem `answers.bucket`");
  }
  return normalizeVerdict((bucket as Record<string, unknown>).choice);
}

function normalizeVerdict(raw: unknown): TieBreakerVerdict | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "lancamento" || v === "lançamento" || v === "launch" || v === "launches") return "lancamento";
  if (v === "radar" || v === "noticias" || v === "notícias" || v === "news") return "radar";
  return null;
}

// ---------------------------------------------------------------------------
// Composição com #160 + aplicação sobre os buckets do categorizador
// ---------------------------------------------------------------------------

export interface CategorizedBuckets {
  lancamento: Article[];
  radar: Article[];
  use_melhor: Article[];
  video: Article[];
}

type ComposedVerdict = "lancamento" | "radar";

/**
 * #8211 item 2 — a composição em si, exposta pra teste isolado do restante do
 * mecanismo. `lancamento` só é aceito se a URL for de domínio oficial (#160);
 * senão vira `radar` mesmo que o classificador tenha dito `lancamento`.
 */
export function composeWithOfficialDomainGate(verdict: TieBreakerVerdict, url: string): ComposedVerdict {
  if (verdict === "lancamento") {
    return isOfficialLancamentoUrl(url) ? "lancamento" : "radar";
  }
  return "radar";
}

export interface ApplySemanticTiebreakerOptions {
  /** Path para platform.config.json. Default: <rootDir>/platform.config.json. */
  configPath?: string;
  /** Default: process.env.TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Injeta fetch pra teste — nunca chamar a rede real em teste. */
  fetchImpl?: typeof fetch;
  /** Para o run-log. */
  edition?: string | null;
  /** Raiz do repo, pra resolver configPath e o run-log. Default: cwd. */
  rootDir?: string;
}

export interface ApplySemanticTiebreakerResult {
  result: CategorizedBuckets;
  /** true = a chamada rodou e produziu (ou tentou produzir) resposta — mesmo com 0 reclassificações. false = pulado (flag off, key ausente, ou falha de transporte). */
  applied: boolean;
  reclassified: number;
}

function isFallbackArticle(article: Article): boolean {
  return !!article.category_rule && isFallbackCategorizationRule(article.category_rule);
}

/**
 * Ponto de entrada do tie-breaker (#8211 item 1). Roda DEPOIS de
 * `categorizeArticles()` já ter atribuído bucket/rule — só reconsidera
 * artigos cuja regra foi um dos dois defaults silenciosos
 * (`lancamento-default`/`noticias-default`).
 *
 * Byte-a-byte idêntico ao comportamento anterior quando:
 *   - a flag está desligada (`semantic_tiebreaker.enabled !== true`);
 *   - `TYPESAFE_API_KEY` está ausente;
 *   - a chamada à TypeSafe falha (rede, timeout, HTTP não-2xx, resposta
 *     malformada) — cada uma dessas condições retorna `buckets` sem nenhuma
 *     cópia/alteração e loga o motivo em `data/run-log.jsonl` (exceto a flag
 *     desligada, que é o caminho normal/silencioso, não um fallback).
 */
export async function applySemanticTiebreaker(
  buckets: CategorizedBuckets,
  opts: ApplySemanticTiebreakerOptions = {},
): Promise<ApplySemanticTiebreakerResult> {
  const rootDir = opts.rootDir ?? process.cwd();
  const configPath = opts.configPath ?? resolve(rootDir, "platform.config.json");

  if (!isSemanticTiebreakerEnabled(configPath)) {
    return { result: buckets, applied: false, reclassified: 0 };
  }

  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent: "semantic-tiebreaker",
        level: "warn",
        message: "TYPESAFE_API_KEY ausente — pulando tie-breaker semântico, mantendo fallback determinístico (#8211)",
      },
      rootDir,
    );
    return { result: buckets, applied: false, reclassified: 0 };
  }

  const fallbackArticles = [
    ...buckets.lancamento.filter(isFallbackArticle),
    ...buckets.radar.filter(isFallbackArticle),
  ];

  if (fallbackArticles.length === 0) {
    // Nada pra desempatar nesta edição — flag ligada e key presente, mas sem
    // trabalho a fazer. `applied: true` porque não houve falha nenhuma.
    return { result: buckets, applied: true, reclassified: 0 };
  }

  let answers: TieBreakerAnswer[];
  try {
    answers = await classifyBatchViaTypeSafe({
      apiKey,
      items: fallbackArticles.map((a) => ({ url: a.url, title: a.title ?? "", summary: a.summary ?? "" })),
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent: "semantic-tiebreaker",
        level: "warn",
        message: `TypeSafe indisponível — mantendo fallback determinístico sem alteração (#8211): ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      rootDir,
    );
    return { result: buckets, applied: false, reclassified: 0 };
  }

  const verdictByUrl = new Map(answers.map((a) => [a.url, a.verdict]));
  const fallbackUrls = new Set(fallbackArticles.map((a) => a.url));

  const nextLancamento = buckets.lancamento.filter((a) => !fallbackUrls.has(a.url));
  const nextRadar = buckets.radar.filter((a) => !fallbackUrls.has(a.url));
  let reclassified = 0;

  for (const article of fallbackArticles) {
    const verdict = verdictByUrl.get(article.url);
    if (verdict === undefined) {
      // TypeSafe não respondeu por este item específico — fail-soft por item:
      // mantém bucket/rule originais, sem contar como reclassificação.
      if (article.category === "lancamento") nextLancamento.push(article);
      else nextRadar.push(article);
      continue;
    }
    const composed = composeWithOfficialDomainGate(verdict, article.url);
    if (composed === "lancamento") {
      if (article.category !== "lancamento") reclassified++;
      nextLancamento.push({ ...article, category: "lancamento", category_rule: "semantic-tiebreaker-lancamento" });
    } else {
      if (article.category !== "noticias") reclassified++;
      const rule =
        verdict === "lancamento"
          ? "semantic-tiebreaker-radar-nonofficial" // #160: classificador disse lancamento, URL não é domínio oficial
          : "semantic-tiebreaker-radar";
      nextRadar.push({ ...article, category: "noticias", category_rule: rule });
    }
  }

  return {
    result: { lancamento: nextLancamento, radar: nextRadar, use_melhor: buckets.use_melhor, video: buckets.video },
    applied: true,
    reclassified,
  };
}
