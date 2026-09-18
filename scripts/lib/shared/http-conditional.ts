/**
 * scripts/lib/shared/http-conditional.ts (#8355)
 *
 * Validadores de cache HTTP (`ETag` fraco + `Last-Modified` + `304 Not
 * Modified` condicional) — extraído de `workers/arquivo/src/index.ts`
 * (#4909/#5134), onde essa lógica nasceu e já roda em produção há semanas
 * sem incidente. `workers/site` (#8355) é o 2º consumidor — extração pra
 * `scripts/lib/shared/` em vez de duplicar ~90 linhas, seguindo o mesmo
 * padrão já usado por `kv-image.ts`/`confirmado-page.ts`/`ai-referrer-log.ts`
 * (módulos genéricos importados por mais de um Worker).
 *
 * `workers/arquivo/src/index.ts` NÃO foi migrado pra importar daqui nesta PR
 * — decisão deliberada de blast radius: aquele arquivo está fora do escopo
 * desta issue e uma PR concorrente (#8358) já toca o worker `arquivo`
 * (`render-archive.ts`); trocar sua implementação local por este import é
 * refactor de baixo risco mas zero urgência, melhor feito numa unidade
 * própria depois que a #8358 mergear. As duas implementações são
 * funcionalmente idênticas hoje (este módulo é uma extração fiel, não uma
 * reescrita).
 *
 * Nenhuma chamada de rede/I/O aqui — puramente funções sobre strings/
 * `Request`/`Response` (Web standard, disponíveis tanto no runtime de
 * Workers quanto em Node 18+/undici, usado pelos testes).
 */

/**
 * Hash não-criptográfico (FNV-1a 32-bit) do corpo, pra `ETag`. Não precisa
 * ser à prova de colisão adversarial — só precisa mudar quando o conteúdo
 * muda, pra um `If-None-Match` de crawler funcionar. Puramente em JS (sem
 * `crypto.subtle`, que é assíncrono, nem `node:crypto`, que exigiria
 * `nodejs_compat` só pra isto).
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `ETag` FRACO (`W/"..."`) — não `"..."` forte. CDNs/proxies reversos
 * (Cloudflare incluso) descartam um ETag FORTE ao aplicar compressão em
 * trânsito (gzip/brotli automáticos), porque um validador forte declara
 * "byte-idêntico" e a compressão muda os bytes — um ETag FRACO sinaliza
 * "semanticamente equivalente" e sobrevive a essa transformação (achado
 * ao vivo #5134, confirmado contra `arquivo.diar.ia.br` em produção). O
 * hash em si (FNV-1a) já não pretendia ser validador forte.
 */
export function weakEtag(body: string): string {
  return `W/"${fnv1aHex(body)}"`;
}

/**
 * `If-None-Match` casa contra `etag`? Comparação FRACA (RFC 7232 §2.3.2 —
 * a única válida pra GET/HEAD condicional): ignora o prefixo `W/` dos dois
 * lados antes de comparar o opaque-tag. `*` casa qualquer ETag
 * (representação existe). Múltiplos valores separados por vírgula — casa
 * se QUALQUER um bater.
 */
export function ifNoneMatchMatches(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const stripWeak = (t: string) => t.trim().replace(/^W\//, "");
  const target = stripWeak(etag);
  return trimmed.split(",").some((candidate) => stripWeak(candidate) === target);
}

/**
 * `If-Modified-Since` casa contra `lastModifiedHttpDate` (RFC 7231 §3.3, já
 * em formato HTTP-date — ver `toHttpDate` abaixo)? "Não modificado desde" é
 * verdadeiro quando o recurso NÃO mudou depois da data pedida, ou seja
 * `lastModified <= ifModifiedSince`. Datas inválidas em qualquer lado (não
 * deveria acontecer com um crawler bem-comportado, mas headers HTTP são
 * input não confiável) fazem a função devolver `false` — nunca 304 indevido
 * por um parse ruim.
 */
export function ifModifiedSinceMatches(header: string, lastModifiedHttpDate: string): boolean {
  const ims = Date.parse(header);
  const lm = Date.parse(lastModifiedHttpDate);
  if (Number.isNaN(ims) || Number.isNaN(lm)) return false;
  return lm <= ims;
}

/**
 * `YYYY-MM-DD` → formato RFC 7231 (`Last-Modified`/`If-Modified-Since`).
 * Meia-noite UTC — a granularidade é o DIA de publicação editorial, não um
 * timestamp de escrita de arquivo nem hora real de envio.
 */
export function toHttpDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

/**
 * Devolve uma resposta `304 Not Modified` (corpo vazio) quando a requisição
 * condicional CASA com o `ETag`/`Last-Modified` da resposta 200 já montada
 * — ou `null` quando não casa (caller serve a resposta original tal qual).
 * Nunca chamada sobre respostas != 200 (404, 502 — essas não têm `ETag`/
 * `Last-Modified` pra casar contra nada).
 *
 * `If-None-Match` tem PRECEDÊNCIA sobre `If-Modified-Since` quando ambos
 * estão presentes (RFC 7232 §3.3: "a recipient MUST ignore If-Modified-
 * Since if the request contains an If-None-Match header") — por isso o
 * `else if` abaixo só olha `If-Modified-Since` quando não há `If-None-
 * Match` NENHUM na requisição, nunca como fallback de um `If-None-Match`
 * que não casou.
 */
export function conditionalNotModified(request: Request, response: Response): Response | null {
  if (response.status !== 200) return null;
  const etag = response.headers.get("ETag");
  const lastModified = response.headers.get("Last-Modified");
  const ifNoneMatch = request.headers.get("If-None-Match");
  let matched: boolean;
  if (ifNoneMatch !== null) {
    matched = etag !== null && ifNoneMatchMatches(ifNoneMatch, etag);
  } else {
    const ifModifiedSince = request.headers.get("If-Modified-Since");
    matched = lastModified !== null && ifModifiedSince !== null && ifModifiedSinceMatches(ifModifiedSince, lastModified);
  }
  if (!matched) return null;
  const headers = new Headers();
  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", lastModified);
  const cacheControl = response.headers.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return new Response(null, { status: 304, headers });
}
