/**
 * jev-actor-brazil.ts (#8504 — implementação a partir do veredito de #8416)
 *
 * Shadow mode de `jev.features.actor_brazil`: anota artigos com `actor`
 * (Choice, 6-way — big_tech_lab/startup/academia/governo_regulador/
 * empresa_usuaria/outro) e `brazil_p` (Noul, probabilidade 0-1) via Jev
 * (`scripts/lib/jev.ts`), SEM alterar `detectBrazil()`
 * (`scripts/collect-monthly.ts`) nem o regex de concentração big-tech do
 * #8370 nesta fase — método comum do epic #8412 (shadow antes de substituir).
 *
 * Veredito da medição (#8416, 64 itens, 3 rodadas):
 *   - Brasil: ADOTAR. `detectBrazil()` 82,8% vs Jev 98,4%-100%, McNemar
 *     p<0,01 nas 3 rodadas — significativo e reproduzível.
 *   - Ator: ADOTAR COM RESSALVA. Binário big-tech não é estatisticamente
 *     significativo em n=64 (McNemar p=0,29-0,45), mas a classificação 6-way
 *     é capacidade NOVA (82,8%-84,4% de acurácia) que o regex não produz —
 *     tratado como sinal ADITIVO de diversidade (highlight-theme-check),
 *     nunca como substituto do regex #8370 já em produção.
 *
 * Fail-soft obrigatório (#8412 método comum, item 6): `TYPESAFE_API_KEY`
 * ausente, flag desligada, ou falha de transporte (rede/timeout/HTTP não-2xx)
 * → nenhum artigo anotado, `applied: false`, warn em `data/run-log.jsonl` —
 * NUNCA lança, nunca bloqueia a pipeline. Falha PARCIAL (alguns itens da
 * chamada batch falham, outros não) é tratada por `askJevBatch` — os itens
 * que falharam simplesmente não recebem anotação.
 */

import { existsSync, readFileSync } from "node:fs";
import { isJevFeatureOn } from "./jev-profile.ts";
import { resolve } from "node:path";
import { askJevBatch, type JevChoiceAnswer, type JevNoulAnswer } from "./jev.ts";
import { ACTOR_BRAZIL_8416_ACTOR, ACTOR_BRAZIL_8416_BRAZIL } from "./jev-questions.ts";
import { logEvent } from "./run-log.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface JevFeaturesConfig {
  actor_brazil?: boolean;
}

/**
 * Lê `jev.features.actor_brazil` de `platform.config.json`. Fail-soft:
 * arquivo ausente/malformado → `false` — mesmo padrão de
 * `readSemanticTiebreakerConfig` (#8211): um config quebrado nunca liga
 * sozinho uma chamada de rede nova.
 */
export function readJevFeaturesConfig(configPath: string): JevFeaturesConfig {
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      jev?: { features?: JevFeaturesConfig };
    };
    return cfg.jev?.features ?? {};
  } catch {
    return {};
  }
}

/**
 * #8504 item 5 — perfil `--diaria-edicao-jev` liga a flag pra teste em
 * produção real sem alterar o committed `platform.config.json` (que segue
 * default OFF pro `/diaria-edicao` normal). O orchestrator, ao ver
 * `--diaria-edicao-jev` na invocação, exporta `JEV_FORCE_ACTOR_BRAZIL=1` só
 * pro subprocesso do Stage 1 spawnado (mesmo padrão escopado de subprocesso
 * já usado pra outras flags de perfil — nunca `export` persistente no shell,
 * ver princípio "NUNCA trocar a conta claude.ai pela API" no CLAUDE.md sobre
 * escopar env a subprocesso). Env override vence o config (permite ligar
 * mesmo com o committed `false`); nunca o contrário — `JEV_FORCE_ACTOR_BRAZIL`
 * ausente/diferente de `"1"` não desliga uma flag já `true` no config.
 */
export function isActorBrazilEnabled(configPath: string): boolean {
  if (process.env.JEV_FORCE_ACTOR_BRAZIL === "1") return true;
  return isJevFeatureOn(readJevFeaturesConfig(configPath).actor_brazil);
}

// ---------------------------------------------------------------------------
// Anotação
// ---------------------------------------------------------------------------

export type ActorLabel =
  | "big_tech_lab"
  | "startup"
  | "academia"
  | "governo_regulador"
  | "empresa_usuaria"
  | "outro";

const VALID_ACTORS: ReadonlySet<string> = new Set<ActorLabel>([
  "big_tech_lab",
  "startup",
  "academia",
  "governo_regulador",
  "empresa_usuaria",
  "outro",
]);

export interface ActorBrazilAnnotation {
  actor: ActorLabel;
  /** Probabilidade da choice escolhida, se a API devolveu `probabilities`; senão `confidence`. */
  actor_p: number;
  /** Probabilidade 0-1 de que o assunto principal envolve o Brasil (#8416). */
  brazil_p: number;
}

export interface ActorBrazilItem {
  /** Identifica o item no retorno (ex: URL do artigo). */
  id: string;
  title: string;
  url: string;
  summary: string;
}

export interface ClassifyActorBrazilOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  concurrency?: number;
}

export interface ClassifyActorBrazilResult {
  /** id do item → anotação. Itens que falharam na chamada (fail-soft por item) não aparecem aqui. */
  annotations: Map<string, ActorBrazilAnnotation>;
  /** true = a chamada rodou (mesmo que alguns itens tenham falhado individualmente). false = falha total de transporte. */
  applied: boolean;
}

/**
 * Classifica um lote de artigos em `actor`/`actor_p`/`brazil_p` via Jev.
 * Lança apenas se a falha for de USO (nenhum item, apiKey vazia) — falha de
 * transporte (rede, key inválida, API fora) é fail-soft: devolve
 * `applied: false, annotations: new Map()`, quem chama decide o resto
 * (mesmo contrato de `applySemanticTiebreaker`).
 */
export async function classifyActorBrazil(
  items: ActorBrazilItem[],
  opts: ClassifyActorBrazilOptions,
): Promise<ClassifyActorBrazilResult> {
  if (items.length === 0) return { annotations: new Map(), applied: true };

  let batch: Awaited<ReturnType<typeof askJevBatch>>;
  try {
    batch = await askJevBatch(
      items.map((item) => ({
        id: item.id,
        state: { title: item.title, url: item.url, summary: item.summary },
        questions: [ACTOR_BRAZIL_8416_ACTOR.question, ACTOR_BRAZIL_8416_BRAZIL.question],
        cacheKey: item.id,
      })),
      {
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        cacheDir: opts.cacheDir,
        concurrency: opts.concurrency,
      },
    );
  } catch {
    // Falha TOTAL de transporte (todos os itens falharam) — askJevBatch já
    // lança nesse caso (mesmo contrato de classifyBatchViaTypeSafe).
    return { annotations: new Map(), applied: false };
  }

  const annotations = new Map<string, ActorBrazilAnnotation>();
  for (const result of batch.results) {
    const actorAnswer = result.answers.find((a): a is JevChoiceAnswer => a.type === "choice" && a.id === "actor");
    const brazilAnswer = result.answers.find((a): a is JevNoulAnswer => a.type === "noul" && a.id === "brazil");
    if (!actorAnswer || !brazilAnswer) continue;
    if (!VALID_ACTORS.has(actorAnswer.choice)) continue;

    const actorP = actorAnswer.probabilities?.[actorAnswer.choice] ?? actorAnswer.confidence;
    annotations.set(result.id, {
      actor: actorAnswer.choice as ActorLabel,
      actor_p: actorP,
      brazil_p: brazilAnswer.probability,
    });
  }

  return { annotations, applied: true };
}

// ---------------------------------------------------------------------------
// Ponto de entrada fail-soft — resolve flag + API key + log, delega em classifyActorBrazil
// ---------------------------------------------------------------------------

export interface AnnotateActorBrazilOptions {
  configPath?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  edition?: string | null;
  rootDir?: string;
}

export interface AnnotateActorBrazilResult {
  annotations: Map<string, ActorBrazilAnnotation>;
  /** true = a flag está ligada, a key está presente, e a chamada rodou (ver applied de classifyActorBrazil). */
  applied: boolean;
}

/**
 * Ponto de entrada de produção (#8504). Byte-a-byte idêntico ao
 * comportamento anterior (nenhuma anotação) quando:
 *   - `jev.features.actor_brazil` está desligada (default) — caminho normal,
 *     não loga warn (não é uma falha, é o estado padrão);
 *   - `TYPESAFE_API_KEY` está ausente — loga warn;
 *   - a chamada à Jev falha totalmente (rede, timeout, HTTP não-2xx) — loga warn.
 */
export async function annotateActorBrazil(
  items: ActorBrazilItem[],
  opts: AnnotateActorBrazilOptions = {},
): Promise<AnnotateActorBrazilResult> {
  const rootDir = opts.rootDir ?? process.cwd();
  const configPath = opts.configPath ?? resolve(rootDir, "platform.config.json");

  if (!isActorBrazilEnabled(configPath)) {
    return { annotations: new Map(), applied: false };
  }

  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent: "jev-actor-brazil",
        level: "warn",
        message: "TYPESAFE_API_KEY ausente — pulando anotação actor/brazil shadow mode (#8504)",
      },
      rootDir,
    );
    return { annotations: new Map(), applied: false };
  }

  const result = await classifyActorBrazil(items, {
    apiKey,
    fetchImpl: opts.fetchImpl,
    cacheDir: opts.cacheDir,
  });

  if (!result.applied) {
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent: "jev-actor-brazil",
        level: "warn",
        message: "Jev indisponível — pulando anotação actor/brazil shadow mode, sem alterar produção (#8504)",
      },
      rootDir,
    );
  }

  return result;
}
