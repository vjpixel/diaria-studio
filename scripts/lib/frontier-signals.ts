/**
 * frontier-signals.ts (#9359)
 *
 * Sinal DETERMINÍSTICO de "lançamento principal de laboratório de fronteira"
 * para a seleção de destaque. A #9359 mediu (118 edições) que o editor promove
 * de fora dos 6 candidatos, com frequência, o post oficial de lançamento de
 * modelo de Anthropic/OpenAI/Google/xAI/Meta.
 *
 * `detectFrontierLaunch` classifica em três sabores:
 *   - `official`/`model`: host oficial do laboratório + modelo-carro-chefe
 *     VERSIONADO ("Claude Sonnet 5.5", "GPT-6", "Gemini 4") num título que
 *     anuncia. É o único sabor que GARANTE vaga (`isGuaranteedFrontierLaunch`).
 *   - `official`/`product`: "Introducing X" no host oficial sem modelo
 *     versionado (produto/feature do laboratório).
 *   - `press`/`model`: imprensa com verbo de lançamento + modelo versionado
 *     no título ("Anthropic lança Claude Sonnet 5.5").
 *
 * ## Por que só `official`/`model` garante vaga — medição (corpus da #9359)
 *
 * 113 edições com `01-categorized.json` × `01-approved.json` (taxa de
 * aprovação do editor sobre os candidatos que chegaram aos 6; base = 44%):
 *
 *   | sabor              | candidatos | aprovados |
 *   |--------------------|-----------:|----------:|
 *   | official / model   |         13 | 12 (92%)  |
 *   | official / product |          7 |  4 (57%)  |
 *   | press / model      |          7 |  3 (43%)  |
 *
 * Só o 1º se separa da base; os outros dois ficam como sinal informativo.
 *
 * ## Fora deste módulo (decidido por medição, não por omissão)
 *
 * - Garantia DIRETA nos 6 destaques (swap determinístico pós-scorer-select):
 *   simulada nas mesmas 113 edições, rende 2 acertos e 2 perdas (o candidato
 *   deslocado era um que o editor aprovou), com 3 inserções de história já
 *   coberta semanas antes (mesma URL reaparecendo fora da janela de dedup de 3
 *   edições). Saldo nulo → a garantia fica nos FINALISTAS (o `scorer-select`
 *   ainda decide), ver `pickFrontierLaunchFinalists`.
 * - Peso extra para "incidente de segurança de fronteira" sobre o negativo
 *   genérico: candidatos `negative_impact` com ator de fronteira foram
 *   aprovados em 8/15 (53%) contra 31/55 (56%) do negativo genérico — a
 *   hipótese da #9359 não se sustentou no dado.
 * - Penalidade da lista 3 da #9359: sem calibragem medida ainda (Track A
 *   da #7980/#8633).
 */

import { hasLaunchVerb } from "./launch-detect.ts";

export interface ArticleLike {
  url?: string;
  title?: string;
}

/** Laboratórios de fronteira e seus hosts oficiais (sem `www.`; subdomínio conta). */
export const FRONTIER_LABS: ReadonlyArray<{ lab: string; hosts: readonly string[] }> = [
  { lab: "Anthropic", hosts: ["anthropic.com", "claude.com"] },
  { lab: "OpenAI", hosts: ["openai.com"] },
  { lab: "Google DeepMind", hosts: ["deepmind.google", "blog.google"] },
  { lab: "xAI", hosts: ["x.ai"] },
  { lab: "Meta", hosts: ["ai.meta.com"] },
];

/**
 * Modelo-carro-chefe COM versão: "Claude Opus 5.5", "GPT-6", "Grok 4.7",
 * "Gemini 4", "Llama 5" — e as formas de slug de URL (`claude sonnet 5 5`,
 * depois de `pathWords`). A versão separa lançamento principal de menção.
 */
export const FLAGSHIP_MODEL_RE =
  /\b(?:claude(?:[\s-]+(?:opus|sonnet|haiku))?|gemini(?:[\s-]+(?:ultra|pro|flash))?|grok|llama|gpt)[\s-]*\d+(?:[.-]\d+)?(?![\w])/i;

/** Subdomínios de documentação/console — página de referência, não anúncio. */
const NON_ANNOUNCEMENT_SUBDOMAIN_RE =
  /^(?:docs|help|platform|developers?|status|support|community|deploymentsafety)\./;

/** Título que ABRE com "Introducing"/"Previewing"/… — forma canônica de anúncio oficial. */
const ANNOUNCEMENT_OPENER_RE = /^\s*(?:introducing|previewing|meet|announcing)\b/i;

/**
 * Página de REFERÊNCIA (evergreen) do modelo, não anúncio datado. No corpus da
 * #9359 essas páginas reaparecem semanas depois do lançamento com data "de
 * ontem" (`date_unverified`) — `deepmind.google/models/gemini/` sozinha surgiu
 * em 8 edições, nenhuma aprovada.
 */
const REFERENCE_TITLE_RE = /\b(?:system\s+card|model\s+card|docs|safety\s+hub)\b/i;

function hostAndPath(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: "", path: "" };
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, "").toLowerCase(), path: u.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

function matchLabHost(host: string): { lab: string; base: string } | undefined {
  if (!host) return undefined;
  for (const { lab, hosts } of FRONTIER_LABS) {
    const base = hosts.find((h) => host === h || host.endsWith(`.${h}`));
    if (base) return { lab, base };
  }
  return undefined;
}

/** Laboratório dono do host da URL (ou de um subdomínio dele), ou `undefined`. */
export function frontierLabOfUrl(url: string | undefined): string | undefined {
  return matchLabHost(hostAndPath(url).host)?.lab;
}

function isReferencePage(host: string, path: string, title: string): boolean {
  if (NON_ANNOUNCEMENT_SUBDOMAIN_RE.test(host)) return true;
  if (REFERENCE_TITLE_RE.test(title)) return true;
  if (/system-card|model-card/i.test(path)) return true;
  // deepmind.google/models/* = página de produto do modelo (evergreen).
  if (host === "deepmind.google" && path.startsWith("/models/")) return true;
  // openai.com fora de /index|/news|/blog = landing de produto (`/gpt-5`), não post.
  if (host === "openai.com" && !/^\/(?:index|news|blog)\//.test(path)) return true;
  return false;
}

/** Path com separadores virados espaço — `/claude-sonnet-5-5` vira " claude sonnet 5 5". */
function pathWords(path: string): string {
  return path.replace(/[/_-]+/g, " ");
}

export interface FrontierLaunchSignal {
  route: "official" | "press";
  /** `model` = modelo-carro-chefe versionado; `product` = "Introducing X" sem modelo. */
  strength: "model" | "product";
  /** Laboratório do host (só na rota `official`). */
  lab?: string;
  /** Trecho que casou (modelo versionado ou o "Introducing"). */
  matched: string;
}

/**
 * Detecta lançamento de laboratório de fronteira. `null` = não é.
 *
 * Rota `official`: o título precisa ANUNCIAR — abrir com o modelo, abrir com
 * "Introducing/Previewing/…" ou trazer verbo de lançamento. Post que só CITA o
 * modelo ("Replit expands access … with GPT-5.6", "See what 4 builders are
 * making with Gemini 3.8") não conta: eram falsos-positivos no corpus. Título
 * vazio → o modelo pode vir do path (`anthropic.com/claude-opus-5-5`).
 */
export function detectFrontierLaunch(article: ArticleLike): FrontierLaunchSignal | null {
  const title = (article.title ?? "").trim();
  const { host, path } = hostAndPath(article.url);
  const labHost = matchLabHost(host);
  if (labHost) {
    if (isReferencePage(host, path, title)) return null;
    const model = (title || pathWords(path)).match(FLAGSHIP_MODEL_RE);
    const opener = title.match(ANNOUNCEMENT_OPENER_RE);
    if (model) {
      const announces = !title || model.index === 0 || opener !== null || hasLaunchVerb(title) !== undefined;
      return announces ? { route: "official", strength: "model", lab: labHost.lab, matched: model[0] } : null;
    }
    // blog.google publica de tudo (cursos, PMEs, programas) — ali só modelo versionado conta.
    if (labHost.base === "blog.google") return null;
    if (opener) return { route: "official", strength: "product", lab: labHost.lab, matched: opener[0].trim() };
    return null;
  }
  const model = title.match(FLAGSHIP_MODEL_RE);
  if (!model || !hasLaunchVerb(title)) return null;
  return { route: "press", strength: "model", matched: model[0] };
}

/** Só o sabor que o dado sustenta (92% de aprovação): post oficial de modelo versionado. */
export function isGuaranteedFrontierLaunch(article: ArticleLike): boolean {
  const s = detectFrontierLaunch(article);
  return s !== null && s.route === "official" && s.strength === "model";
}

/** Máximo de finalistas EXTRAS que a garantia pode acrescentar ao top-N. */
export const FRONTIER_LAUNCH_FINALIST_CAP = 2;

/**
 * Garantia nos finalistas: dado o pool já ORDENADO por score desc, devolve os
 * itens `isGuaranteedFrontierLaunch` que ficaram FORA do top-N (até `cap`,
 * maior score primeiro), para serem ACRESCENTADOS aos finalistas — nunca
 * deslocam um finalista por mérito, e o `scorer-select` continua decidindo
 * se entram nos 6. Puro: não muta nada.
 */
export function pickFrontierLaunchFinalists<T extends { article: ArticleLike }>(
  rankedPool: readonly T[],
  topN: number,
  cap: number = FRONTIER_LAUNCH_FINALIST_CAP,
): T[] {
  if (topN <= 0 || cap <= 0) return [];
  return rankedPool.slice(topN).filter((e) => isGuaranteedFrontierLaunch(e.article)).slice(0, cap);
}
