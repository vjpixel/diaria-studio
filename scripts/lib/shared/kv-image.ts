/**
 * Serviço de `/img/{key}` a partir do KV `POLL` — compartilhado entre Workers (#7657).
 *
 * As capas das edições vivem num único KV, escrito pela pipeline
 * (`scripts/upload-images-public.ts`, `scripts/lib/mensal/monthly-image-upload.ts`).
 * Até o #7657 só `workers/poll` sabia lê-las, e portanto o ÚNICO endereço
 * público das imagens era `eia.diar.ia.br/img/{key}` — host diferente do
 * documento em toda superfície que as exibe.
 *
 * Por que isso é problema, medido ao vivo em 08/09/2026 (ver #7657): um
 * bloqueador de conteúdo no navegador do leitor que corte requisições pro
 * subdomínio derruba as 7 capas da home de uma vez. Reproduzido no Chrome do
 * editor — falhas de 4-10 ms com `transferSize: 0` e `nextHopProtocol: ""`
 * (nada trafegou), enquanto `poll.diaria.workers.dev/img/{a MESMA imagem}`
 * respondia 200 no mesmo segundo e o analytics da zona registrava ZERO 403
 * em `/img/` no período. Falha 100% client-side, invisível pra nós: não gera
 * log, não dá pra medir quantos leitores veem a home quebrada.
 *
 * Este módulo existe pra que `workers/site` sirva os MESMOS bytes em
 * `diar.ia.br/img/{key}`, mesma origem do documento — sem salto cross-host,
 * não há hostname de terceiro pra um filtro cortar.
 *
 * `workers/poll` continua servindo `eia.diar.ia.br/img/{key}` pelo mesmo
 * caminho, agora delegando aqui. **Isso não é transição, é permanente**: toda
 * edição já ENVIADA por e-mail e as 262 páginas `/p/{slug}` do acervo
 * carregam a URL antiga. As duas rotas leem o mesmo KV e devolvem resposta
 * byte a byte idêntica.
 *
 * Contratos herdados do `handleImage` original, preservados sem alteração:
 *   - allowlist de key (#4112) — ver `isPublicImageKey`;
 *   - ETag forte SHA-256 + `If-None-Match` → 304 (#5136);
 *   - `Cache-Control` por classe de key (#5136) — ver `imageCacheControlFor`;
 *   - CORS `*` em TODOS os paths, inclusive 404 (#1132 P2.4).
 */

/** Binding de KV mínimo que este módulo consome — evita depender do tipo
 *  global `KVNamespace` (nem todo Worker do repo carrega os tipos do
 *  workers-types no mesmo tsconfig). */
export interface KvImageStore {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
}

/**
 * #5136: distingue keys de imagem com cache-bust por hash
 * (`img-{AAMMDD}-{base}-{md5short}.{ext}`, `md5short` = 8 hex chars
 * minúsculos — ver `cloudflareKvKey` em `scripts/upload-images-public.ts`)
 * das keys de convenção FIXA sem hash (`img-{AAMMDD}-01-eia-{A|B}.jpg` e as
 * variantes real/ia legadas — `noCacheBust: true`, #1704), cujo fluxo
 * `/vote` depende do nome nunca mudar entre regenerações da mesma edição.
 *
 * Só a 1ª categoria pode receber `Cache-Control: immutable` de longa
 * duração: a 2ª pode passar a apontar pra bytes diferentes a qualquer
 * momento (correção pós-envio regenera a mesma key).
 */
export function isContentAddressedImageKey(key: string): boolean {
  return /-[0-9a-f]{8}\.[A-Za-z0-9]+$/.test(key);
}

/**
 * #5136: `Cache-Control` pra `/img/{key}` — `immutable` de 1 ano quando a
 * key é content-addressed (ver `isContentAddressedImageKey` acima), ou o
 * mesmo `max-age=3600` de sempre (#1242) pras keys de convenção fixa
 * (É IA? A/B), que podem apontar pra bytes diferentes numa regeneração.
 */
export function imageCacheControlFor(key: string): string {
  return isContentAddressedImageKey(key)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";
}

/**
 * #4112 (P0, achado do review 260727 e CONFIRMADO em produção): sem esta
 * allowlist, `/img/{key}` era um leitor arbitrário do KV INTEIRO — a chave
 * vinha crua da URL direto pro `get`. Em produção dava, sem autenticação
 * nenhuma e com `Access-Control-Allow-Origin: *`:
 *   GET /img/correct:{hoje}                 → o gabarito do dia (spoiler
 *                                             total; a chave é escrita no
 *                                             Stage 4, ANTES do e-mail sair)
 *   GET /img/leaderboard-snapshot:{slug}    → e-mails dos leitores EM CLARO
 *   GET /img/score:{email}, /img/vote:{ed}:{email}, /img/nickname:{apelido}
 *                                           → dado individual + harvest de
 *                                             e-mail a partir dos apelidos
 *                                             públicos do leaderboard
 *
 * O gate é o prefixo `img-`: TODA chave de imagem gravada pelo pipeline usa
 * `img-{edition}-{basename}` / `img-monthly-*` (upload-images-public.ts,
 * lib/mensal/monthly-image-upload.ts), e NENHUMA chave de estado começa
 * assim — todas usam namespace com `:` (`correct:`, `stats:`, `vote:`,
 * `score:`, `score-by-month:`, `nickname:`, `counted:`, `votelog:`,
 * `identify-linked:`, `leaderboard-snapshot:`, `eiameta:`, `rl:`,
 * `subscriber:`, mais os prefixos de brand `clarice:`/`web:`) ou são
 * singletons (`valid_editions`). Recusar `:` é defesa em profundidade
 * (redundante hoje, protege de uma chave futura tipo `img-algo:secreto`) e
 * não restringe charset de filename — não quebra nenhuma URL já enviada em
 * edição passada, que é o requisito duro aqui.
 *
 * INVARIANTE ao adicionar consumidor: este gate roda em TODO Worker que
 * exponha o KV `POLL` por HTTP. Um caminho novo que leia o KV sem passar por
 * `serveKvImage` reabre exatamente o buraco do #4112 — o KV é o mesmo, a
 * exposição é que muda de host.
 */
export function isPublicImageKey(key: string): boolean {
  return /^img-[^:]+$/.test(key);
}

/**
 * Extrai a key de um pathname `/img/{key}`, ou `null` se o path não for de
 * imagem. Pura, exportada pra teste.
 *
 * #4112: `decodeURIComponent` lança `URIError` em `%` malformado (`/img/%`).
 * Sem este guard, uma rota pública devolvia 500 pra input trivial — aqui
 * vira `null`, e o caller responde 404 como em qualquer key inexistente.
 */
export function imageKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith("/img/")) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice("/img/".length));
  } catch {
    return null;
  }
  return key || null;
}

/**
 * #5136: ETag forte via SHA-256 dos bytes — barato o bastante pra rodar por
 * request nas imagens (<500 KB cada, ver medição na issue) e correto
 * independente de a key ser content-addressed ou não (cobre também as
 * imagens de convenção fixa do É IA?, cujo conteúdo PODE mudar sob o mesmo
 * key numa regeneração — o ETag muda junto, então `If-None-Match` continua
 * válido mesmo aí).
 */
async function sha256HexOfBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Serve `/img/{key}` a partir do KV. `key` já veio de `imageKeyFromPath`
 * (ou equivalente); a validação da allowlist acontece AQUI, não no caller,
 * pra que nenhum Worker novo possa esquecê-la.
 *
 * CORS: imagens são públicas — emitir `Access-Control-Allow-Origin` em todos
 * os paths (200, 304 e 404). #1132 P2.4: pre-check de CORS faz probe contra
 * key que pode não existir; com CORS apenas em 200, o pre-check produzia
 * falso negativo.
 */
export async function serveKvImage(
  key: string,
  kv: KvImageStore,
  ifNoneMatch?: string | null,
): Promise<Response> {
  const corsHeaders = { "Access-Control-Allow-Origin": "*" };

  if (!isPublicImageKey(key)) {
    return new Response("not found", { status: 404, headers: corsHeaders });
  }

  const value = await kv.get(key, "arrayBuffer");
  if (!value) {
    return new Response("not found", { status: 404, headers: corsHeaders });
  }

  const etag = `"${await sha256HexOfBytes(value)}"`;
  const cacheControl = imageCacheControlFor(key);

  // #5136: conditional GET — devolve 304 sem corpo quando o client já tem
  // os mesmos bytes (If-None-Match). Vale sobretudo pras keys de convenção
  // fixa: `max-age=3600` faz o browser revalidar a cada hora, e a maioria
  // das revalidações vai bater o mesmo ETag (a imagem só muda numa
  // regeneração real).
  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...corsHeaders, "Cache-Control": cacheControl, ETag: etag },
    });
  }

  // Imagens do É IA? são sempre JPEG.
  return new Response(value, {
    headers: {
      ...corsHeaders,
      "Content-Type": "image/jpeg",
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}
