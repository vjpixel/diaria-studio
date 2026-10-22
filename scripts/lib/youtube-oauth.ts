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
 * O app OAuth está em produção desde 22/10/2026 (#10785): o refresh token
 * não vence mais em 7 dias como no modo "Testing" (#1973).
 * `YOUTUBE_REFRESH_OBTAINED_AT` ficou como registro de quando foi gerado.
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
  const norm = (h: string) => h.trim().toLowerCase().replace(/^@/, "");
  const want = norm(expectedHandle);
  const match = channels.find((c) => norm(c.customUrl ?? "") === want);
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
  return `YouTube API respondeu ${status}: ${body.slice(0, 300)}`;
}

/**
 * Escopo concedido de fato (#10757). O consentimento granular do Google deixa
 * desmarcar um escopo: sem `youtube.upload` o token passa na checagem do canal
 * (que só usa readonly) e falharia só no 1º upload. Devolve os ausentes.
 */
export function missingGrantedScopes(grantedScope: string | undefined): string[] {
  const granted = new Set(String(grantedScope ?? "").split(/\s+/).filter(Boolean));
  return YOUTUBE_OAUTH_SCOPES.filter((s) => !granted.has(s));
}

/** Resposta do `oauth2.googleapis.com/token` que interessa à decisão. */
export type YouTubeTokenResponse = { access_token: string; refresh_token?: string; scope?: string };

export type PersistDecision =
  | { persist: true; refreshToken: string; channel: YouTubeChannel }
  | { persist: false; reason: string };

/**
 * Regra de "nunca gravar" do setup (#10786), extraída de `main` para ser
 * testada caso a caso. Recebe os tokens já trocados e a resposta CRUA de
 * `channels.list?mine=true` (status + corpo em texto) e decide se o token
 * pode ser gravado. Sem refresh token, escopo faltando, `channels.list`
 * falhando, corpo que não é JSON ou canal que não é o @diariabr: não grava.
 */
export function decidePersist(args: {
  tokens: YouTubeTokenResponse;
  channelsStatus: number;
  channelsBody: string;
  expectedHandle?: string;
}): PersistDecision {
  const { tokens, channelsStatus, channelsBody } = args;
  if (!tokens.refresh_token) {
    return {
      persist: false,
      reason: "O Google não devolveu refresh_token. Revogue o app em https://myaccount.google.com/permissions e rode de novo",
    };
  }
  const missing = missingGrantedScopes(tokens.scope);
  if (missing.length > 0) {
    return {
      persist: false,
      reason: `O consentimento não concedeu: ${missing.join(", ")}. Rode de novo e deixe os 2 escopos marcados`,
    };
  }
  if (channelsStatus < 200 || channelsStatus >= 300) {
    return { persist: false, reason: explainYouTubeApiError(channelsStatus, channelsBody) };
  }
  let json: unknown;
  try {
    json = JSON.parse(channelsBody);
  } catch {
    return { persist: false, reason: "channels.list devolveu um corpo que não é JSON" };
  }
  const check = checkAuthorizedChannel(parseChannelsResponse(json), args.expectedHandle);
  if (!check.ok) return { persist: false, reason: check.reason };
  return { persist: true, refreshToken: tokens.refresh_token, channel: check.channel };
}

/** Desfecho de uma requisição recebida no servidor de loopback (#10786). */
export type CallbackOutcome =
  | { kind: "ignore" } // não é o callback (favicon, path errado, sem code/error)
  | { kind: "bad-state" } // state divergente: responde 400 e CONTINUA esperando
  | { kind: "denied"; error: string; description: string }
  | { kind: "code"; code: string };

/**
 * Classifica uma requisição no redirect de loopback. State divergente não
 * encerra mais o fluxo (#10786): qualquer requisição local a
 * `/youtube/callback?code=x` nos 15 min de espera obrigaria o editor a
 * recomeçar. O callback legítimo, com o state certo, ainda pode chegar.
 */
export function classifyCallback(url: URL, expectedState: string): CallbackOutcome {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (url.pathname !== "/youtube/callback" || (!code && !error)) return { kind: "ignore" };
  if (url.searchParams.get("state") !== expectedState) return { kind: "bad-state" };
  if (error) return { kind: "denied", error, description: url.searchParams.get("error_description") ?? "" };
  return { kind: "code", code: code as string };
}
