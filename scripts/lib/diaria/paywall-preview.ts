/**
 * paywall-preview.ts (#12537, Etapa 1 item 1)
 *
 * A proposta do #12537 só aceita destaque atrás de paywall se o pipeline LEU o
 * artigo inteiro (condição 1). O manifest de `fact-check-sources/` registrava
 * só `ok | blocked | error` + bytes, e a prévia que o paywall serve (os 2-3
 * primeiros parágrafos + "assine para continuar lendo") chega como HTTP 200 e
 * vira `ok`. Este módulo separa "artigo inteiro" de "prévia de paywall" a
 * partir do HTML bruto e do texto já extraído.
 *
 * Sinais, do mais forte ao mais fraco:
 *   - **schema.org `isAccessibleForFree: false`** (JSON-LD ou microdata) — a
 *     marcação que o Google pede a quem tem paywall; o publisher declara.
 *   - **`article:content_tier` `locked`/`metered`** (meta OpenGraph).
 *   - **classe/id de paywall** no HTML (`paywall`, `regwall`, `piano`...).
 *   - **frase de corte** no texto extraído ("subscribe to continue reading",
 *     "para continuar lendo"...).
 *
 * Decisão:
 *   - nenhum sinal → `full` (página aberta; texto curto sem sinal é notícia
 *     curta, não prévia);
 *   - com sinal e `wordCount` declarado no JSON-LD → `preview` se o texto
 *     extraído tem menos que `PREVIEW_WORDCOUNT_RATIO` das palavras
 *     declaradas, senão `full` (o site mandou o texto inteiro no HTML e só
 *     esconde por JS, caso comum);
 *   - com sinal e sem `wordCount` → `preview` se o texto extraído tem menos
 *     que `PREVIEW_MAX_WORDS` palavras.
 *
 * Puro: não toca rede nem disco. Não é veredito editorial — o manifest grava
 * o resultado e o resumo do fact-check o mostra no gate.
 */

/** Sem `wordCount` declarado, texto com sinal de paywall abaixo disto é prévia. */
export const PREVIEW_MAX_WORDS = 400;

/** Com `wordCount` declarado, texto extraído abaixo desta fração é prévia. */
export const PREVIEW_WORDCOUNT_RATIO = 0.6;

export type SourceCompleteness = "full" | "preview";

export interface PaywallPreviewResult {
  completeness: SourceCompleteness;
  /** Sinais de paywall achados (vazio = página aberta). */
  signals: string[];
  /** Palavras do texto extraído. */
  words: number;
  /** `wordCount` declarado no JSON-LD, quando houver. */
  declared_words: number | null;
}

/** Frases de corte, comparadas em minúsculas contra o texto extraído. */
export const PAYWALL_CUTOFF_PHRASES: readonly string[] = [
  "subscribe to continue reading",
  "subscribe to keep reading",
  "subscribe to read the full",
  "to continue reading, subscribe",
  "this article is for subscribers",
  "this article is only available to subscribers",
  "already a subscriber? sign in",
  "already a subscriber? log in",
  "create a free account to continue reading",
  "para continuar lendo",
  "continue lendo com",
  "assine para ler",
  "assine para continuar",
  "conteúdo exclusivo para assinantes",
  "matéria exclusiva para assinantes",
  "já é assinante? faça login",
];

const CLASS_HOOK =
  /\b(?:class|id)\s*=\s*["'][^"']*\b(paywall|regwall|piano-(?:offer|paywall|inline)|tp-container-inner|meter-wall|subscriber-only|premium-gate|article-locked)\b/i;

function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

/** `wordCount` declarado (maior valor achado; JSON-LD pode trazer vários nós). */
function declaredWordCount(html: string): number | null {
  let best: number | null = null;
  for (const m of html.matchAll(/"wordCount"\s*:\s*"?(\d{2,6})"?/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

/** @pure */
export function detectPaywallSignals(html: string, text: string): string[] {
  const signals: string[] = [];
  if (/"isAccessibleForFree"\s*:\s*(?:"false"|false)/i.test(html)) signals.push("schema:isAccessibleForFree=false");
  else if (/itemprop\s*=\s*["']isAccessibleForFree["'][^>]*content\s*=\s*["']false["']/i.test(html)) {
    signals.push("schema:isAccessibleForFree=false");
  }
  const tier = html.match(/<meta[^>]+(?:property|name)\s*=\s*["']article:content_tier["'][^>]*content\s*=\s*["'](locked|metered)["']/i)
    ?? html.match(/<meta[^>]+content\s*=\s*["'](locked|metered)["'][^>]*(?:property|name)\s*=\s*["']article:content_tier["']/i);
  if (tier) signals.push(`meta:content_tier=${tier[1].toLowerCase()}`);
  const hook = html.match(CLASS_HOOK);
  if (hook) signals.push(`html:${hook[1].toLowerCase()}`);
  const lower = text.toLowerCase();
  const phrase = PAYWALL_CUTOFF_PHRASES.find((p) => lower.includes(p));
  if (phrase) signals.push(`texto:"${phrase}"`);
  return signals;
}

/**
 * Classifica o texto baixado como artigo inteiro ou prévia de paywall.
 * `html` pode ser vazio (fonte em texto puro): aí só a frase de corte conta. @pure
 */
export function assessPaywallPreview(html: string, text: string): PaywallPreviewResult {
  const signals = detectPaywallSignals(html, text);
  const words = countWords(text);
  const declared_words = declaredWordCount(html);
  let completeness: SourceCompleteness = "full";
  if (signals.length > 0) {
    if (declared_words !== null) {
      if (words < declared_words * PREVIEW_WORDCOUNT_RATIO) completeness = "preview";
    } else if (words < PREVIEW_MAX_WORDS) {
      completeness = "preview";
    }
  }
  return { completeness, signals, words, declared_words };
}
