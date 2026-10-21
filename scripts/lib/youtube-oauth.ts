/**
 * youtube-oauth.ts (#10659) — miolo puro do OAuth do canal @diariabr.
 *
 * O token do YouTube é SEPARADO do `data/.credentials.json` (oauth-setup.ts):
 * o canal pode pertencer a outra conta/conta de marca, e o escopo
 * `youtube.upload` é sensível — misturá-lo no token compartilhado do
 * Drive/Gmail faria qualquer re-consentimento daquele token exigir o canal.
 * Reusa o MESMO client OAuth (GOOGLE_CLIENT_ID/SECRET, tipo "Desktop app",
 * que aceita qualquer redirect de loopback).
 *
 * Armadilha conhecida: com o app OAuth em modo "Testing" (#1973), o refresh
 * token expira em 7 dias. Por isso gravamos `YOUTUBE_REFRESH_OBTAINED_AT`.
 */

export const YOUTUBE_OAUTH_ENV = {
  refreshToken: "YOUTUBE_REFRESH_TOKEN",
  channelId: "YOUTUBE_CHANNEL_ID",
  obtainedAt: "YOUTUBE_REFRESH_OBTAINED_AT",
} as const;

export const YOUTUBE_OAUTH_SCOPES = [
  // videos.insert (resumable) e thumbnails.set.
  "https://www.googleapis.com/auth/youtube.upload",
  // channels.list?mine=true — confirmar QUAL canal foi autorizado.
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const YOUTUBE_OAUTH_REDIRECT_PORT = 8767;
export const YOUTUBE_OAUTH_REDIRECT_URI = `http://127.0.0.1:${YOUTUBE_OAUTH_REDIRECT_PORT}/youtube/callback`;

/** Handle esperado do canal da diar.ia.br. */
export const EXPECTED_YOUTUBE_HANDLE = "@diariabr";

export function buildYouTubeAuthUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: YOUTUBE_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    // consent força refresh_token; select_account deixa escolher a conta dona do canal.
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export type YouTubeChannel = { id: string; title: string; customUrl: string | null };

/** Extrai os canais de uma resposta de `channels.list?part=snippet&mine=true`. */
export function parseChannelsResponse(body: unknown): YouTubeChannel[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: YouTubeChannel[] = [];
  for (const it of items) {
    const id = (it as { id?: unknown })?.id;
    const snippet = (it as { snippet?: { title?: unknown; customUrl?: unknown } })?.snippet;
    if (typeof id !== "string" || !id) continue;
    out.push({
      id,
      title: typeof snippet?.title === "string" ? snippet.title : "",
      customUrl: typeof snippet?.customUrl === "string" ? snippet.customUrl : null,
    });
  }
  return out;
}

/**
 * Decide se o canal autorizado é o @diariabr. Comparação de handle sem caixa
 * (a API devolve `customUrl` como "@diariabr"). Sem nenhum canal, ou com um
 * canal de outro handle, devolve o motivo — o script NÃO grava o token.
 */
export function checkAuthorizedChannel(
  channels: YouTubeChannel[],
  expectedHandle: string = EXPECTED_YOUTUBE_HANDLE,
): { ok: true; channel: YouTubeChannel } | { ok: false; reason: string } {
  if (channels.length === 0) {
    return { ok: false, reason: "a conta autorizada não tem canal do YouTube (escolha a conta/canal de marca do @diariabr no consentimento)" };
  }
  const want = expectedHandle.toLowerCase();
  const match = channels.find((c) => (c.customUrl ?? "").toLowerCase() === want);
  if (match) return { ok: true, channel: match };
  const seen = channels.map((c) => `${c.title} (${c.customUrl ?? "sem handle"})`).join(", ");
  return { ok: false, reason: `canal autorizado não é ${expectedHandle}: ${seen}` };
}

/** Explica erros comuns da API do YouTube sem expor tokens. */
export function explainYouTubeApiError(status: number, body: string): string {
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(body)) {
    return "YouTube Data API v3 não está ativada no projeto GCP do client OAuth — ative em console.cloud.google.com → APIs → YouTube Data API v3 e rode de novo";
  }
  if (status === 403 && /insufficientPermissions|insufficient authentication scopes/i.test(body)) {
    return "token sem o escopo youtube.readonly — o consentimento não concedeu todos os escopos pedidos";
  }
  return `YouTube API respondeu ${status}`;
}
