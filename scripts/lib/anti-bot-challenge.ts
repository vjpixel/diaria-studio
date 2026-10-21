/**
 * #10240: reconhece o challenge anti-bot da PLATFORMA de hospedagem numa
 * resposta HTTP de feed/sitemap — distinto de rate limit nosso ou de feed que
 * mudou de endereço. Caso real: VentureBeat (IA), `HTTP 429` com
 * `x-vercel-mitigated: challenge` (Vercel Security Checkpoint) no domínio
 * inteiro desde 04/09/2026; passar pelo desafio exige automação de browser
 * (fora da política de ToS do projeto), então o feed não tem conserto do nosso
 * lado — o caminho é esvaziar a coluna RSS da fonte em `seed/sources.csv` e
 * cobrir pela busca `site:`.
 *
 * Só anota o motivo da falha (o outcome continua `fail`); quem decide o que
 * fazer com isso é o editor/`source_feed_broken`.
 */

export type ChallengePlatform = "vercel" | "cloudflare";

/** Header → plataforma. Ambos usam o valor literal `challenge`. */
const CHALLENGE_HEADERS: ReadonlyArray<[string, ChallengePlatform]> = [
  ["x-vercel-mitigated", "vercel"],
  ["cf-mitigated", "cloudflare"],
];

/** Plataforma que emitiu o challenge, ou `null` se a resposta não é um. */
export function detectAntiBotChallenge(
  headers: Pick<Headers, "get"> | undefined | null,
): ChallengePlatform | null {
  if (!headers || typeof headers.get !== "function") return null;
  for (const [name, platform] of CHALLENGE_HEADERS) {
    if (headers.get(name)?.trim().toLowerCase() === "challenge") return platform;
  }
  return null;
}

/**
 * Motivo de falha HTTP de feed/sitemap: `HTTP {status}`, com sufixo
 * ` (challenge anti-bot: {plataforma})` quando a resposta é um challenge.
 * Sem challenge o formato fica idêntico ao histórico (`HTTP 404`).
 */
export function describeFeedHttpFailure(res: {
  status: number;
  headers?: Pick<Headers, "get"> | null;
}): string {
  const platform = detectAntiBotChallenge(res.headers);
  return platform
    ? `HTTP ${res.status} (challenge anti-bot: ${platform})`
    : `HTTP ${res.status}`;
}
