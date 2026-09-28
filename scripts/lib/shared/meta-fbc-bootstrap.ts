/**
 * scripts/lib/shared/meta-fbc-bootstrap.ts (#8978)
 *
 * Grava o cookie `_fbc` da Meta em `domain=.diar.ia.br` no PRIMEIRO
 * carregamento de uma página com `fbclid` na URL — fecha o gap medido no
 * Events Manager: `CompleteRegistration` só tinha `fbc` em 33% dos eventos
 * (só quem chegou e assinou SEM sair da mesma página/host onde o clique
 * pago aconteceu).
 *
 * ## Por que o pixel da Meta sozinho não bastava
 *
 * O pixel (via GTM ou `fbq` inline) também grava `_fbc` ao ver `fbclid`, mas
 * SEM domínio explícito no `Set-Cookie` o cookie fica HOST-ONLY (preso ao
 * host exato que carregou a página — `eia.diar.ia.br` OU `diar.ia.br`,
 * nunca os dois). O funil deste projeto atravessa mais de um host/path
 * antes do cadastro (`eia.diar.ia.br` → `/evento/agente-ia` → `diar.ia.br/
 * assinar`, por exemplo) — um `_fbc` preso ao host de entrada não chega ao
 * formulário de cadastro se o visitante navegar pra outro host no meio.
 * Este módulo é gravado PARA o domínio registrável (`.diar.ia.br`), então
 * sobrevive a esses saltos.
 *
 * ## Nunca fabrica `fbc` sem `fbclid` real (pedido explícito da #8978)
 *
 * Só grava quando a URL da página TEM `fbclid` na querystring — nenhum
 * fallback, nenhuma heurística. Cookie já existente NUNCA é sobrescrito
 * (preserva o timestamp do PRIMEIRO clique, que é o que a Meta quer pra
 * atribuição de janela de 7 dias — sobrescrever a cada visita subsequente
 * do mesmo `fbclid` reiniciaria essa janela).
 *
 * ## Lado servidor — fallback em cascata, não duplicado aqui
 *
 * A leitura/derivação server-side do `fbc` (cookie → `click_id` do form →
 * `fbclid` no header `Referer`) já vive em
 * `extractMetaCapiClientSignals`/`buildFbcFromClickId`/`buildFbcFromReferer`
 * (`meta-capi.ts`) — este módulo só cobre o lado BROWSER (garantir que o
 * cookie exista e sobreviva entre hosts), não duplica a lógica de
 * derivação.
 *
 * Fronteira `lib/shared/` (#2747): zero `node:*`, só string/regex — mesmo
 * padrão de `visitor-id.ts`/`meta-capi.ts`.
 */

// #8978 (fleet review item 5): mesmo charset de `FBCLID_RE` — import direto
// de `meta-capi.ts` (não duplicado), sem risco de ciclo: `meta-capi.ts`
// nunca importa este módulo.
import { FBCLID_RE } from "./meta-capi.ts";

/** Mesmo formato canônico que `meta-capi.ts` valida (`FB_COOKIE_RE`):
 * `fb.{subdomainIndex}.{creationTimeMs}.{payload}`. `subdomainIndex` 1 =
 * cookie de domínio (`.diar.ia.br`), coerente com `buildFbcFromClickId`. */
const FBC_SUBDOMAIN_INDEX = 1;

/** ~90 dias — janela de atribuição de clique da Meta é bem mais curta (7
 * dias), mas o cookie oficial `_fbc` que o pixel da Meta gravaria também
 * usa uma validade longa; manter o mesmo horizonte evita este cookie
 * expirar ANTES do `_fbp`/cookie nativo da Meta na mesma máquina. */
const FBC_COOKIE_MAX_AGE_SEC = 7776000;

/**
 * Snippet JS (sem `<script>` em volta — mesmo contrato dos demais
 * bootstraps deste módulo/`seo-meta.ts`) que grava `_fbc` em
 * `domain=.diar.ia.br` quando (a) a URL atual tem `fbclid` E (b) o cookie
 * `_fbc` ainda não existe. `try/catch` em volta de tudo — mesma disciplina
 * dos demais snippets deste projeto.
 *
 * @pure — a saída é sempre a mesma string; o snippet roda no BROWSER.
 */
export function metaFbcBootstrapJs(): string {
  return (
    "try {" +
    "if (/(^|\\.)diar\\.ia\\.br$/.test(window.location.hostname)) {" +
    "var fbclid = new URLSearchParams(window.location.search).get('fbclid');" +
    // #8978 (fleet review item 5): valida o charset do `fbclid` ANTES de
    // gravar — mesma regra que o servidor (`FBCLID_RE`) já aplicava do lado
    // dele; sem isso um `fbclid` malformado/injetado na querystring virava
    // `_fbc` cru gravado no cookie do domínio inteiro.
    `var FBCLIDRE = new RegExp(${JSON.stringify(FBCLID_RE.source)});` +
    "if (fbclid && FBCLIDRE.test(fbclid) && !/(?:^|; )_fbc=/.test(document.cookie)) {" +
    `var fbc = 'fb.${FBC_SUBDOMAIN_INDEX}.' + Date.now() + '.' + fbclid;` +
    `document.cookie = '_fbc=' + fbc + '; Max-Age=${FBC_COOKIE_MAX_AGE_SEC}; Domain=.diar.ia.br; Path=/; SameSite=Lax';` +
    "}" +
    "}" +
    "} catch (e) {}"
  );
}

/**
 * #8978 (fleet review, achado 1 do #8983 + finding pós-merge sobre
 * `buildFbcFromReferer`): expressão JS (sem `<script>`/atribuição em volta —
 * cola direto como VALOR de uma propriedade de objeto, mesmo contrato de
 * `clientOriginSignalPayloadFieldsJs`) que lê `_fbc`/`_fbp` do
 * `document.cookie` da PÁGINA ATUAL — nunca de outro host, JS não lê cookie
 * cross-origin. Cobre o cadastro cross-origin (POST pra `eia.diar.ia.br` a
 * partir de `diar.ia.br`/`livros`/`cursos`): o cookie nunca chega no header
 * `Cookie` do request (sem `credentials: "include"`, decisão de escopo — ver
 * PR #8983), então o SERVIDOR só recebe o valor se o CLIENTE mandar no
 * corpo. String vazia quando o cookie não existe — nunca `undefined`/erro,
 * pra manter o objeto de payload JS válido (`JSON.stringify` não aceita
 * `undefined` numa propriedade sem removê-la, o que mudaria o formato do
 * corpo entre "campo ausente" e "campo vazio" sem necessidade).
 * @pure
 */
export function fbCookieValueFromDocumentCookieJs(cookieName: "_fbc" | "_fbp"): string {
  return `(function () { var m = document.cookie.match(/(?:^|; )${cookieName}=([^;]+)/); return m ? m[1] : ""; })()`;
}
