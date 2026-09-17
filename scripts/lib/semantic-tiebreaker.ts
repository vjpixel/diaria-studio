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
 * ⚠️ CONTRATO DA API NÃO CONFIRMADO — LER ANTES DE CONFIAR EM PRODUÇÃO.
 * Antes desta unidade o repo não tinha nenhuma chamada real à TypeSafe: sem
 * doc, sem exemplo de request/response, sem menção prévia em `.env.example`.
 * `classifyBatchViaTypeSafe` abaixo implementa um contrato PLAUSÍVEL — batch
 * de `questions` numa única request (a issue cita o cookbook
 * `parallel_questions` da TypeSafe, "12x mais barato batchado"), resposta com
 * um array `answers` casado por `id` (usamos a própria URL como id) — mas é
 * uma SUPOSIÇÃO, não um fato verificado contra a API real. Isolado nesta
 * única função de transporte pra ser trivial de corrigir sem tocar
 * composição/fail-soft/flag quando o contrato real for confirmado. O PR desta
 * unidade lista explicitamente o que precisa ser validado antes da flag ser
 * confiável em produção. Nenhum teste desta unidade chama a rede de verdade —
 * todos injetam `fetchImpl` stubado.
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
// Transporte — isolado, contrato NÃO confirmado (ver aviso no topo do arquivo)
// ---------------------------------------------------------------------------

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/questions/batch"; // NÃO CONFIRMADO
const TYPESAFE_MODEL = "jev-latest";

/**
 * Critério passado ao classificador — mesmo espírito do #160 (LANÇAMENTOS só
 * com link oficial) e do resíduo medido na #5995: distinguir "anúncio oficial
 * de produto/feature que o leitor pode usar" de "notícia/cobertura/relatório/
 * marco institucional sobre a empresa". Texto deliberadamente curto — a
 * issue reporta que o controle contra prompt-tuning (texto de critério
 * ORIGINAL, escrito antes de conhecer o corpus) deu o mesmo resultado.
 */
const TIEBREAKER_CRITERION =
  "Este link anuncia o LANÇAMENTO de um produto, feature ou modelo de IA que " +
  "o leitor pode usar diretamente — responda 'lancamento'. Se for notícia, " +
  "cobertura de imprensa, relatório, marco institucional, parceria de " +
  "negócio ou opinião sobre a empresa/produto — responda 'radar'.";

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
 * Chama a TypeSafe em lote (#8211 item 5 — batching, "12x mais barato" no
 * cookbook `parallel_questions` citado na issue). Lança em qualquer falha —
 * quem chama (`applySemanticTiebreaker`) trata como fail-soft.
 */
export async function classifyBatchViaTypeSafe(opts: ClassifyBatchOptions): Promise<TieBreakerAnswer[]> {
  if (opts.items.length === 0) return [];
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        questions: opts.items.map((item) => ({
          id: item.url,
          criterion: TIEBREAKER_CRITERION,
          context: `${item.title}\n\n${item.summary}`.trim(),
        })),
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
  return parseTypeSafeResponse(raw, opts.items);
}

/**
 * Parseia/valida a resposta da TypeSafe. Exposto pra teste — não faz I/O.
 * Item malformado ou `id` que não bate nenhuma URL requisitada é IGNORADO
 * (nunca lançado) — resposta parcialmente inválida ainda deixa os itens
 * válidos serem aproveitados; os itens sem resposta ficam sem verdict e
 * `applySemanticTiebreaker` mantém o bucket original pra eles (fail-soft por
 * item, não só por request).
 */
export function parseTypeSafeResponse(raw: unknown, items: TieBreakerQuestionItem[]): TieBreakerAnswer[] {
  if (!raw || typeof raw !== "object") {
    throw new Error("[semantic-tiebreaker] resposta da TypeSafe não é um objeto JSON");
  }
  const answers = (raw as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) {
    throw new Error("[semantic-tiebreaker] resposta da TypeSafe sem array `answers`");
  }
  const validUrls = new Set(items.map((i) => i.url));
  const out: TieBreakerAnswer[] = [];
  for (const entry of answers) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    const answerRaw = (entry as Record<string, unknown>).answer;
    if (typeof id !== "string" || !validUrls.has(id)) continue;
    const verdict = normalizeVerdict(answerRaw);
    if (!verdict) continue;
    out.push({ url: id, verdict });
  }
  return out;
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
