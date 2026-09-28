/**
 * scripts/lib/shared/visitor-id.ts (#8978)
 *
 * ID first-party ANÔNIMO e ESTÁVEL por navegador — o `external_id` que a
 * Meta recomenda mandar em TODO evento (pixel + CAPI) pra melhorar o Event
 * Match Quality (EMQ). Achado no Events Manager (dataset `1285191740325112`,
 * 28/09/2026): `CompleteRegistration` tinha EMQ 7,7/10 e a Meta estimava
 * +14,21% de conversões adicionais mandando `external_id` — maior ganho
 * isolado disponível sem pedir telefone (fora de escopo, decisão do editor).
 *
 * ## O que é, o que NÃO é
 *
 * Um UUID v4 gerado no PRIMEIRO carregamento de página que roda este
 * snippet, gravado num cookie próprio (`_dia_vid`) — NUNCA e-mail, nome ou
 * qualquer dado que identifique a pessoa fora deste projeto. Não é o mesmo
 * hash de `hashEmailForMeta` (`meta-capi.ts`) nem o `event_id` determinístico
 * de dedup — os três são identificadores DISTINTOS com propósitos distintos.
 *
 * ## Hash ou não? RAW dos dois lados — decisão registrada (#8978)
 *
 * A Meta aceita `external_id` hasheado OU em claro, desde que os DOIS lados
 * (pixel client-side e CAPI server-side) mandem o MESMO valor — igual ao
 * cuidado já documentado pro par (`event_id`, `event_time`) em
 * `CompleteRegistrationDedup` (meta-capi.ts). Escolha aqui: **RAW, sem
 * hash**, nos dois lados. Motivos:
 *
 * 1. **Não é PII.** É um UUID aleatório que este projeto gerou — hashear um
 *    valor que já não identifica ninguém fora do cookie não protege
 *    privacidade nenhuma (diferente do e-mail, que É PII e por isso
 *    `hashEmailForMeta` hasheia).
 * 2. **Evita mais uma janela de divergência de virada de dia/timing.** O
 *    `event_id` já tem essa armadilha documentada (hash depende do DIA UTC
 *    do `event_time` — ver `computeCompleteRegistrationEventId`). Hashear o
 *    `external_id` client-side exigiria Web Crypto assíncrono ANTES do
 *    `fbq('init', ...)`, criando uma corrida (fbq dispara antes do hash
 *    resolver = pixel sai sem o campo) que simplesmente não existe mandando
 *    o UUID cru — `fbq('init', ...)` já é síncrono no snippet de bootstrap.
 * 3. **Simetria trivial de auditar**: o mesmo valor lido do cookie aparece
 *    idêntico nos dois lados, sem fórmula pra manter sincronizada em dois
 *    lugares (browser e Worker).
 *
 * ## Fronteira `lib/shared/` (#2747)
 *
 * Zero import de `node:*` — só string/regex/Web Crypto opcional (usado só
 * no FALLBACK de geração, ver `visitorIdBootstrapJs`), pra rodar idêntico em
 * Node (scripts/testes) e no runtime Cloudflare Workers, mesmo padrão de
 * `meta-capi.ts`.
 */

/** Nome do cookie first-party. Curto e prefixado (`_dia_`) pra não colidir
 * com cookies de terceiros (`_fbp`/`_fbc` são da Meta, `_ga` do GA, etc). */
export const DIA_VISITOR_ID_COOKIE_NAME = "_dia_vid";

/** ~2 anos — mesma ordem de grandeza da validade de `_fbp`/`_fbc` da Meta
 * (que também usam long-lived first-party cookies pra advanced matching). */
export const DIA_VISITOR_ID_COOKIE_MAX_AGE_SEC = 63072000;

/** Domínio registrável do projeto — o cookie é sempre gravado aqui
 * (`domain=.diar.ia.br`), nunca host-only, pra sobreviver a saltos entre
 * `eia.diar.ia.br` ↔ `diar.ia.br` ↔ `/evento/agente-ia` (#8978: são hosts/
 * paths diferentes do mesmo Worker/domínio, e o visitante frequentemente
 * atravessa mais de um antes de assinar). */
export const DIA_VISITOR_ID_COOKIE_DOMAIN = ".diar.ia.br";

/** Formato aceito: UUID (v4 gerado por `crypto.randomUUID()`) OU o fallback
 * hex de 32 chars sem hífen que `visitorIdBootstrapJs` usa quando
 * `crypto.randomUUID` está ausente (Safari antigo/contexto não-seguro).
 * Frouxo de propósito — o valor nunca é usado como segredo, só como
 * correlação; um formato rígido demais rejeitaria um valor legítimo do
 * fallback e faria o servidor tratar um visitante real como sem sinal. */
const VISITOR_ID_RE = /^[0-9a-fA-F-]{16,64}$/;

/** @pure */
export function isValidVisitorId(value: string | undefined | null): value is string {
  return typeof value === "string" && value.length > 0 && VISITOR_ID_RE.test(value);
}

/** Lê UM cookie do header `Cookie` cru — mesma lógica de
 * `readCookieValue` (meta-capi.ts), duplicada aqui de propósito (função
 * trivial, ~6 linhas) pra não criar import circular entre os dois módulos
 * (meta-capi.ts importa deste arquivo pra extrair o `external_id`).
 * @pure */
export function readVisitorIdFromCookieHeader(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== DIA_VISITOR_ID_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return isValidVisitorId(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Snippet JS (sem `<script>` em volta, mesmo contrato de
 * `renderAnalyticsHead`/`pushSignupConversionEventJs` em `seo-meta.ts`) que:
 *
 * 1. Lê `_dia_vid` do `document.cookie`; se ausente/inválido, gera um novo
 *    (`crypto.randomUUID()`, com fallback pra navegador sem suporte) e
 *    grava o cookie em `domain=.diar.ia.br` (só quando o host atual É
 *    `diar.ia.br` ou subdomínio — nunca em preview local/localhost, onde o
 *    domínio não existiria e o `Set-Cookie` seria silenciosamente
 *    descartado pelo browser de qualquer forma).
 * 2. Expõe `window.__DIA_VID__` pra qualquer script na MESMA página que
 *    precise do valor síncrono (ex: `fbq('init', PIXEL, {external_id: ...})`
 *    nas páginas que inicializam o pixel diretamente, sem passar por GTM —
 *    ver `workers/site/public/evento/agente-ia/{a,b}/index.html`).
 * 3. Empurra `{ external_id: <valor> }` pro `dataLayer` ANTES do GTM
 *    carregar (`renderAnalyticsHead` embute este snippet primeiro) — é o
 *    contrato que a variável do GTM (Data Layer Variable `external_id`) lê
 *    pra alimentar o campo "External ID" da tag Meta Pixel (User-Provided
 *    Data / Advanced Matching). **A configuração dessa variável/campo no
 *    painel do GTM não é automatizável daqui** — ver instruções manuais no
 *    corpo do PR/issue #8978.
 *
 * `try/catch` em volta de tudo: mesma disciplina de `pushSignupConversionEventJs`
 * — um `document.cookie` bloqueado (extensão de privacidade, contexto
 * sandboxed) nunca pode quebrar a página.
 *
 * @pure (a saída é sempre a mesma string — o snippet é executado no
 * BROWSER, este módulo só a produz).
 */
export function visitorIdBootstrapJs(): string {
  return (
    "try {" +
    `var COOKIE=${JSON.stringify(DIA_VISITOR_ID_COOKIE_NAME)};` +
    `var DOMAIN=${JSON.stringify(DIA_VISITOR_ID_COOKIE_DOMAIN)};` +
    `var MAXAGE=${DIA_VISITOR_ID_COOKIE_MAX_AGE_SEC};` +
    "var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));" +
    "var vid = m && /^[0-9a-fA-F-]{16,64}$/.test(m[1]) ? m[1] : null;" +
    "if (!vid) {" +
    "vid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : " +
    "'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });" +
    "if (/(^|\\.)diar\\.ia\\.br$/.test(window.location.hostname)) {" +
    "document.cookie = COOKIE + '=' + vid + '; Max-Age=' + MAXAGE + '; Domain=' + DOMAIN + '; Path=/; SameSite=Lax';" +
    "}" +
    "}" +
    "window.__DIA_VID__ = vid;" +
    "window.dataLayer = window.dataLayer || [];" +
    "window.dataLayer.push({ external_id: vid });" +
    "} catch (e) {}"
  );
}
