/**
 * workers/site — fallback pra Kit quando a página estática do acervo não existe (#6429).
 *
 * Até aqui este Worker era de STATIC ASSETS PURO (sem `main`) — `[assets]`
 * servia `public/p/{slug}/index.html`/`public/index.html` direto, sem
 * script nenhum na frente. O acervo é gerado por `scripts/gen-archive-pages.ts`
 * a partir de `data/beehiiv-cache/posts/*.json` (gated por
 * `publishing.newsletter.read_backend`, hoje ainda `"beehiiv"`) — uma edição
 * publicada só pelo Kit (desde o switchover de ENVIO do #6114, 26/08/2026)
 * nunca entra nesse cache, então a página estática nunca é gerada e
 * `/p/{slug}` responde 404 no nosso domínio pra toda edição nova.
 *
 * Achado ao vivo (#6429): o botão de compartilhar do WhatsApp embutido no
 * e-mail aponta pro nosso permalink (`https://diar.ia.br/p/{slug}`), então
 * todo leitor que compartilhou a edição do dia mandou um link morto — sem
 * ver erro nenhum (quem recebe o clique é o CONTATO dele, não ele).
 *
 * Fix de curto prazo, este `main`: quando `env.ASSETS.fetch` devolve 404
 * pra um path `/p/{slug}`, redireciona (302) pro permalink hospedado no Kit
 * (`https://{EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/{slug}`) — confirmado
 * ao vivo na issue que o Kit já serve a página pública (`public: true`) pra
 * broadcast publicado só lá. Mantém o e-mail já enviado (com o link antigo)
 * funcional retroativamente e cobre toda edição nova até o fix definitivo
 * (gen-archive-pages.ts ler do Kit — escopo do #463/#6184) — o fallback
 * some sozinho quando a página própria passar a existir, porque o `if`
 * abaixo só dispara em 404.
 *
 * `run_worker_first = true` no `wrangler.toml` (mudança irmã desta) garante
 * que este script rode ANTES do asset ganhar a request — mesmo invariante
 * já documentado em `workers/livros/wrangler.toml`/`workers/cursos/wrangler.toml`.
 *
 * Qualquer outro path (`/`, `/subscribe`, acervo que EXISTE) segue
 * exatamente como antes — `env.ASSETS.fetch(request)` é sempre a 1ª coisa
 * chamada, e só um 404 especificamente em `/p/{slug}` muda de rumo.
 *
 * #7657 — 2ª responsabilidade deste script: `/img/{key}` serve as capas das
 * edições a partir do KV `POLL`, os MESMOS bytes que `workers/poll` já servia
 * em `eia.diar.ia.br/img/{key}`. Motivo: as capas da home vinham de um host
 * DIFERENTE do documento, e um bloqueador de conteúdo no navegador do leitor
 * que corte o subdomínio derruba as 7 imagens da home de uma vez — sem gerar
 * log nosso, então sem como medir quantos leitores veem a página quebrada
 * (reproduzido ao vivo em 08/09/2026, ver a issue). Servindo na mesma origem
 * do documento não há hostname de terceiro pra um filtro cortar.
 *
 * `eia.diar.ia.br/img/{key}` continua no ar, permanentemente: toda edição já
 * ENVIADA por e-mail e todas as páginas `/p/{slug}` do acervo carregam aquela
 * URL. Este path é adição, nunca substituição.
 */
import { EXPECTED_SUBSCRIBE_REDIRECT_HOST } from "../../../scripts/lib/apex-cutover.ts";
// #7657: mesmo miolo que workers/poll usa em eia.diar.ia.br/img/{key}.
import { imageKeyFromPath, serveKvImage, type KvImageStore, type R2ImageStore } from "../../../scripts/lib/shared/kv-image.ts";
// #7737: página de confirmação do double opt-in, movida de
// eia.diar.ia.br/confirmado (Worker `poll`, que agora só faz 301 pra cá) —
// render puro em scripts/lib/shared/, sem import cross-worker (ver
// docstring do módulo).
import { handleConfirmadoPage } from "../../../scripts/lib/shared/confirmado-page.ts";
// #8062: mesma instrumentação de bot de IA / Referer de assistente que
// workers/arquivo/src/index.ts já tem — este Worker (apex diar.ia.br) era o
// único dos 4 sem NENHUM contador, apesar de ser a superfície com mais URLs
// indexadas (263 no GSC) e mais provável de ser citada por um assistente.
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts";
import {
  matchAiFetchBot,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  incrementAiFetchCounter,
} from "../../../scripts/lib/shared/ai-fetch-counters.ts";
// #7915/#8498: instrumentação de CLIQUE do redirect /apoiar/ir — ver docstring
// de apoiar-counters.ts. O contador não é pagamento confirmado; a confirmação
// continua vindo do apoia.se/Stripe fora deste repo.
import { apoiarClickCounterKey, apoiarLegacyCounterKey, incrementApoiarCounter } from "../../../scripts/lib/shared/apoiar-counters.ts";
import { DIARIA_APOIASE_URL } from "../../../scripts/lib/canonical-urls.ts";
import {
  APOIAR_REDIRECT_UTM_SOURCE,
  APOIAR_REDIRECT_UTM_MEDIUM,
  APOIAR_REDIRECT_UTM_CAMPAIGN,
} from "../../../scripts/lib/shared/utm-registry.ts";
// #8355: ETag fraco + Last-Modified + 304 condicional pras páginas do
// acervo (`/p/{slug}`) — mesmo padrão já em produção em
// workers/arquivo/src/index.ts (#4909/#5134), extraído pra scripts/lib/shared/
// porque este Worker é o 2º consumidor (ver docstring do módulo pro porquê
// de `arquivo` não ter sido migrado pra importar daqui nesta mesma PR).
import { weakEtag, toHttpDate, conditionalNotModified } from "../../../scripts/lib/shared/http-conditional.ts";
// #8355: arquivo de chave do IndexNow — mesmo padrão já usado por
// workers/cursos e workers/livros (#5703), que por sua vez generalizou o
// que nasceu em workers/arquivo (#4909 item 2).
import { matchIndexNowKeyPath } from "../../../scripts/lib/shared/indexnow-key-route.ts";
// #8982: CliqueIngresso perdia quase todo o clique real (navegação cancelava
// o pixel) — o beacon reenvia o MESMO evento via CAPI, dedupado pela Meta
// contra o disparo client-side pelo par (event_name, event_id). Ver docstring
// completa em click-beacon.ts.
import {
  parseClickBeaconBody,
  validateClickBeacon,
  clickBeaconCustomData,
  CLICK_BEACON_ENDPOINT,
} from "../../../scripts/lib/shared/click-beacon.ts";
import {
  extractMetaCapiClientSignals,
  sendMetaCapiCustomEvent,
  logMetaCapiSendResult,
} from "../../../scripts/lib/shared/meta-capi.ts";
// #10082: abandono de carrinho da Hotmart (webhook), gravado sem dados
// pessoais — ver docstring de hotmart-abandono.ts.
import {
  HOTMART_WEBHOOK_PATH,
  HOTMART_ABANDONOS_PATH,
  ABANDONO_TTL_SECONDS,
  buildAbandonoRecord,
  cleanToken,
  abandonoKvKey,
  fitsKvMetadata,
  lerAbandonos,
  resolvePeriodo,
} from "../../../scripts/lib/shared/hotmart-abandono.ts";
// #10734: compras aprovadas/canceladas/reembolsadas/chargeback da Hotmart,
// na mesma URL e com o mesmo hottok do abandono — ver hotmart-vendas.ts.
import {
  HOTMART_VENDAS_PATH,
  VENDA_TTL_SECONDS,
  buildVendaRecord,
  isVendaEvent,
  vendaKvKey,
  vendaFitsKvMetadata,
  lerVendas,
  saldoLiquido,
} from "../../../scripts/lib/shared/hotmart-vendas.ts";
import { secretMatches } from "../../../scripts/lib/shared/secret-compare.ts";

export interface Env {
  ASSETS: Fetcher;
  /** #7657: KV `POLL` — o MESMO namespace que `workers/poll` lê. Só leitura
   *  aqui; quem escreve continua sendo a pipeline (upload-images-public.ts). */
  POLL: KvImageStore;
  /** #11412: bucket R2 de mídia — fallback de `/img/{key}` para as imagens
   *  novas (`img/{AAMMDD}/…`), mesmo contrato de `workers/poll`. Opcional:
   *  sem o binding no `wrangler.toml`, só o KV. */
  MEDIA?: R2ImageStore;
  /** #8062: KV `CURSOS_SUBSCRIBERS` — o MESMO namespace que
   *  `workers/arquivo`/`workers/cursos` usam, prefixo próprio
   *  (`counter:ai-fetch:site:`). `incrementAiFetchCounter` trata KV ausente
   *  como no-op — binding opcional em runtime mesmo sendo declarado real. */
  CURSOS_SUBSCRIBERS?: KVNamespace;
  /** #8355: chave opaca gerada pelo editor em indexnow.org/documentation,
   *  provisionada via `wrangler secret put INDEXNOW_KEY --name diaria-site`
   *  (fora deste repo, análogo a `workers/cursos`/`workers/livros`, #5703).
   *  Serve `GET /{INDEXNOW_KEY}.txt` — é assim que o Bing confirma que quem
   *  pinga é dono do host. Ausente = nenhuma rota nova (fallback normal). */
  INDEXNOW_KEY?: string;
  /** #8982: mesmo secret dos workers `poll`/`cursos`/`reativar`
   *  (`wrangler secret put META_CAPI_ACCESS_TOKEN --name diaria-site`) — o
   *  beacon de `CliqueIngresso_{A|B}` reenvia via CAPI. Ausente = no-op
   *  fail-soft (`sendMetaCapiCustomEvent` retorna `not_configured`), o
   *  beacon sempre responde 204 de qualquer forma — nunca bloqueia o
   *  clique real. */
  META_CAPI_ACCESS_TOKEN?: string;
  /** #10082: hottok da conta Hotmart (Ferramentas > Webhook), comparado com o
   *  cabeçalho `X-HOTMART-HOTTOK` de cada chamada do webhook. Provisionado
   *  com `wrangler secret put HOTMART_HOTTOK --name diaria-site`. Ausente =
   *  o webhook recusa tudo (503), nunca grava sem autenticar. */
  HOTMART_HOTTOK?: string;
  /** #10082: token da leitura `GET /hotmart/abandonos` (cabeçalho
   *  `Authorization: Bearer ...`), consumido pelo repositório vjpixel/vtsd
   *  (cópia no Doppler). Provisionado com `wrangler secret put
   *  HOTMART_ABANDONOS_TOKEN --name diaria-site`. Ausente = a leitura recusa
   *  tudo (503). */
  HOTMART_ABANDONOS_TOKEN?: string;
  /** #10734: token da leitura `GET /hotmart/vendas` (cabeçalho
   *  `Authorization: Bearer ...`). Separado do token dos abandonos de
   *  propósito: as vendas levam valor e hash de e-mail, e quem lê abandonos
   *  (vjpixel/vtsd) não precisa delas. Provisionado com `wrangler secret put
   *  HOTMART_VENDAS_TOKEN --name diaria-site`. Ausente = a leitura recusa
   *  tudo (503). */
  HOTMART_VENDAS_TOKEN?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Hex do SHA-256 do corpo bruto, sem normalizar (ao contrário do
 * `sha256Hex` de subscriber-verify.ts, que normaliza e-mail): id
 * determinístico para evento sem `id`. */
async function bodyHashHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * #10082: `POST /webhooks/hotmart` — webhook da Hotmart. Grava o evento
 * `PURCHASE_OUT_OF_SHOPPING_CART` e, desde o #10734, os de venda
 * (`HOTMART_VENDA_EVENTS`, via `handleHotmartVenda`); outros eventos recebem 200 e
 * são ignorados com aviso no log (a Hotmart reenvia o que não recebe 2xx, e
 * um evento a mais marcado no painel não deve virar fila de reenvio). O
 * registro vai para o KV `CURSOS_SUBSCRIBERS` com prefixo próprio, e também
 * como metadata da chave, para a leitura listar sem um `get` por registro.
 * Os logs levam só motivo, chave e tamanho: nunca o corpo (tem nome, e-mail
 * e telefone) nem o hottok.
 */
async function handleHotmartWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.HOTMART_HOTTOK) {
    console.error("hotmart-webhook: HOTMART_HOTTOK não configurado; chamada recusada (503)");
    return jsonResponse({ ok: false, error: "not_configured" }, 503);
  }
  if (!(await secretMatches(request.headers.get("X-HOTMART-HOTTOK"), env.HOTMART_HOTTOK))) {
    console.warn(`hotmart-webhook: hottok ${request.headers.has("X-HOTMART-HOTTOK") ? "diferente" : "ausente"}; recusado (401)`);
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const raw = await request.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn(`hotmart-webhook: corpo não é JSON (${raw.length} caracteres); recusado (400)`);
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }
  const bodyHash = await bodyHashHex(raw);
  if (isVendaEvent((payload as Record<string, unknown> | null)?.event)) return handleHotmartVenda(payload, bodyHash, env);
  const built = buildAbandonoRecord(payload, Date.now(), bodyHash);
  if (!built.ok) {
    if (built.reason === "not_abandono") {
      const root = (payload ?? {}) as Record<string, unknown>;
      // Passa pelo mesmo filtro de formato: o log nunca leva texto livre do corpo.
      const evento = cleanToken(root.event, 60) ?? "(formato inválido)";
      const versao = cleanToken(root.version, 10) ?? "?";
      console.warn(`hotmart-webhook: evento ignorado: ${evento} (versão ${versao})`);
      return jsonResponse({ ok: true, ignored: true });
    }
    console.warn(`hotmart-webhook: corpo sem a forma de evento (${Array.isArray(payload) ? "array" : typeof payload}); recusado (400)`);
    return jsonResponse({ ok: false, error: built.reason }, 400);
  }
  if (!env.CURSOS_SUBSCRIBERS) {
    console.error("hotmart-webhook: KV CURSOS_SUBSCRIBERS indisponível (503)");
    return jsonResponse({ ok: false, error: "storage_unavailable" }, 503);
  }
  const record = built.record;
  const key = abandonoKvKey(record);
  if (record.criado_em_origem === "recebimento") {
    console.warn(`hotmart-webhook: creation_date ausente ou inválido em ${key}; usada a hora do recebimento`);
  }
  // Defesa: o registro cabe com folga (só ASCII, campos curtos), mas se um
  // dia não couber, grava sem metadata e a leitura usa o valor.
  const metadataOk = fitsKvMetadata(record);
  if (!metadataOk) console.warn(`hotmart-webhook: registro maior que o limite de metadata em ${key}; gravado só no valor`);
  try {
    await env.CURSOS_SUBSCRIBERS.put(key, JSON.stringify(record), {
      ...(metadataOk ? { metadata: record } : {}),
      expirationTtl: ABANDONO_TTL_SECONDS,
    });
  } catch (err) {
    // 5xx de propósito: a Hotmart reenvia, e o reenvio grava na mesma chave.
    console.error(`hotmart-webhook: falha ao gravar ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ ok: false, error: "storage_error" }, 500);
  }
  console.log(`hotmart-webhook: abandono gravado ${key}`);
  return jsonResponse({ ok: true });
}

/**
 * #10734: grava um evento de venda da Hotmart (já autenticado e com o JSON
 * lido por `handleHotmartWebhook`). Mesmo KV e mesmo desenho do abandono:
 * registro por allowlist, também como metadata, 5xx em falha de gravação
 * para a Hotmart reenviar (o reenvio cai na mesma chave). O log leva só a
 * chave (dia, transação e evento), nunca o corpo, o e-mail nem o hash.
 */
async function handleHotmartVenda(payload: unknown, bodyHash: string, env: Env): Promise<Response> {
  const built = await buildVendaRecord(payload, Date.now(), bodyHash);
  if (!built.ok) {
    // Inalcançável hoje (o chamador já conferiu o evento); defesa.
    return jsonResponse({ ok: false, error: built.reason }, 400);
  }
  if (!env.CURSOS_SUBSCRIBERS) {
    console.error("hotmart-webhook: KV CURSOS_SUBSCRIBERS indisponível (503)");
    return jsonResponse({ ok: false, error: "storage_unavailable" }, 503);
  }
  const record = built.record;
  const key = vendaKvKey(record);
  if (record.criado_em_origem === "recebimento") {
    console.warn(`hotmart-webhook: creation_date ausente ou inválido em ${key}; usada a hora do recebimento`);
  }
  if (record.valor_liquido === null) console.warn(`hotmart-webhook: venda sem comissão PRODUCER legível em ${key}; valor líquido null`);
  if (record.email_hash === null) console.warn(`hotmart-webhook: venda sem e-mail de comprador válido em ${key}; email_hash null`);
  const metadataOk = vendaFitsKvMetadata(record);
  if (!metadataOk) console.warn(`hotmart-webhook: registro maior que o limite de metadata em ${key}; gravado só no valor`);
  try {
    await env.CURSOS_SUBSCRIBERS.put(key, JSON.stringify(record), {
      ...(metadataOk ? { metadata: record } : {}),
      expirationTtl: VENDA_TTL_SECONDS,
    });
  } catch (err) {
    console.error(`hotmart-webhook: falha ao gravar ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ ok: false, error: "storage_error" }, 500);
  }
  console.log(`hotmart-webhook: venda gravada ${key}`);
  return jsonResponse({ ok: true });
}

const PERIODO_ERROS = {
  bad_format: "use de=AAAA-MM-DD e ate=AAAA-MM-DD",
  invalid_date: "data inexistente",
  range_inverted: "ate antes de de",
  range_too_long: "período maior que o permitido",
} as const;

/**
 * #10082: `GET /hotmart/abandonos?de=AAAA-MM-DD&ate=AAAA-MM-DD` — registros
 * de abandono do período (dias em Brasília, inclusivos; só um dos dois vale
 * como um dia; sem nenhum, hoje; até `ABANDONOS_MAX_DIAS`). Autenticada por
 * `Authorization: Bearer <HOTMART_ABANDONOS_TOKEN>`, fail-closed.
 *
 * Resposta 200: `{ ok, de, ate, total, registros, ignorados }`, registros
 * em ordem de `criado_em`; `ignorados` lista chaves com conteúdo inválido
 * (puladas, sem derrubar o período). Erros: 400 (período), 401 (token),
 * 503 (segredo ou KV ausente), 502 (falha do KV, com o dia). A listagem do
 * KV pode levar até ~1 minuto para mostrar um registro novo.
 */
async function handleHotmartAbandonos(request: Request, env: Env, reqUrl: URL): Promise<Response> {
  if (!env.HOTMART_ABANDONOS_TOKEN) return jsonResponse({ ok: false, error: "not_configured" }, 503);
  const bearer = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!(await secretMatches(bearer, env.HOTMART_ABANDONOS_TOKEN))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const periodo = resolvePeriodo(reqUrl.searchParams.get("de"), reqUrl.searchParams.get("ate"), Date.now());
  if (!periodo.ok) return jsonResponse({ ok: false, error: periodo.reason, mensagem: PERIODO_ERROS[periodo.reason] }, 400);
  if (!env.CURSOS_SUBSCRIBERS) return jsonResponse({ ok: false, error: "storage_unavailable" }, 503);
  let lidos;
  try {
    lidos = await lerAbandonos(env.CURSOS_SUBSCRIBERS, periodo.dias);
  } catch (err) {
    console.error(`hotmart-abandonos: falha ao ler o KV (${periodo.de} a ${periodo.ate}): ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ ok: false, error: "storage_error" }, 502);
  }
  if (lidos.ignorados.length) console.warn(`hotmart-abandonos: ${lidos.ignorados.length} chave(s) com conteúdo inválido puladas`);
  return jsonResponse({
    ok: true,
    de: periodo.de,
    ate: periodo.ate,
    total: lidos.registros.length,
    registros: lidos.registros,
    ignorados: lidos.ignorados,
  });
}

/**
 * #10734: `GET /hotmart/vendas?de=AAAA-MM-DD&ate=AAAA-MM-DD` — eventos de
 * venda do período (mesmas regras de período da leitura de abandonos),
 * deduplicados por transação + evento, mais o saldo líquido por moeda.
 * Autenticada por `Authorization: Bearer <HOTMART_VENDAS_TOKEN>`,
 * fail-closed. Resposta 200: `{ ok, de, ate, total, registros, saldo,
 * ignorados, duplicados }`. Erros: 400, 401, 503, 502 (como abandonos).
 */
async function handleHotmartVendas(request: Request, env: Env, reqUrl: URL): Promise<Response> {
  if (!env.HOTMART_VENDAS_TOKEN) return jsonResponse({ ok: false, error: "not_configured" }, 503);
  const bearer = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!(await secretMatches(bearer, env.HOTMART_VENDAS_TOKEN))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const periodo = resolvePeriodo(reqUrl.searchParams.get("de"), reqUrl.searchParams.get("ate"), Date.now());
  if (!periodo.ok) return jsonResponse({ ok: false, error: periodo.reason, mensagem: PERIODO_ERROS[periodo.reason] }, 400);
  if (!env.CURSOS_SUBSCRIBERS) return jsonResponse({ ok: false, error: "storage_unavailable" }, 503);
  let lidas;
  try {
    lidas = await lerVendas(env.CURSOS_SUBSCRIBERS, periodo.dias);
  } catch (err) {
    console.error(`hotmart-vendas: falha ao ler o KV (${periodo.de} a ${periodo.ate}): ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ ok: false, error: "storage_error" }, 502);
  }
  if (lidas.ignorados.length) console.warn(`hotmart-vendas: ${lidas.ignorados.length} chave(s) com conteúdo inválido puladas`);
  return jsonResponse({
    ok: true,
    de: periodo.de,
    ate: periodo.ate,
    total: lidas.registros.length,
    registros: lidas.registros,
    saldo: saldoLiquido(lidas.registros),
    ignorados: lidas.ignorados,
    duplicados: lidas.duplicados,
  });
}

/**
 * #8982: `POST /evento/agente-ia/clique` — beacon do clique em
 * `.checkout-link` (ver `workers/site/public/evento/agente-ia/script.js`).
 * SEMPRE responde 204, mesmo em corpo malformado/variante inválida/Meta
 * fora do ar — o clique real já foi registrado client-side (`fbq
 * trackCustom`); isto é só o reforço server-side que sobrevive à navegação
 * que o clique dispara em seguida. `ctx.waitUntil` adia o envio CAPI pra
 * depois da resposta (mesmo padrão de `workers/poll/src/subscribe.ts`,
 * #5504) — mas aqui a resposta em si não carrega nada que dependa do envio,
 * então nem `await` faria diferença visível; `waitUntil` só garante que o
 * isolate não seja reciclado antes do fetch pra Meta terminar.
 */
async function handleAgenteIaClique(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    const raw = await request.text();
    const parsed = parseClickBeaconBody(raw);
    const v = validateClickBeacon(parsed);
    if (v.ok) {
      const clientSignals = extractMetaCapiClientSignals(request.headers, {
        fbcBody: parsed.fbc,
        fbpBody: parsed.fbp,
        externalIdBody: parsed.externalId,
      });
      const referer = request.headers.get("Referer");
      const eventSourceUrl = referer || new URL(request.url).origin + "/evento/agente-ia/";
      const send = sendMetaCapiCustomEvent(
        {
          eventName: v.eventName,
          eventId: v.eventId,
          eventSourceUrl,
          // #10079: posicao + origem da visita (origem/utm_campaign/utm_content).
          customData: clickBeaconCustomData(parsed, v),
          clientSignals,
        },
        { accessToken: env.META_CAPI_ACCESS_TOKEN },
      );
      const logged = logMetaCapiSendResult(send, "site", eventSourceUrl);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(logged);
      } else {
        await logged;
      }
    }
  } catch {
    // fail-soft total — o beacon nunca pode falhar visivelmente pro cliente.
  }
  return new Response(null, { status: 204 });
}

/** Casa `/p/{slug}` (com ou sem barra final — `html_handling` já resolve a
 * canonicalização pro asset, mas o fallback precisa aceitar as duas formas
 * ANTES de o asset lookup decidir isso). Pura, exportada pra teste. */
export function matchArchiveSlug(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

/**
 * #8355: extrai `datePublished` (`YYYY-MM-DD`) do `<script type="application/
 * ld+json">` `NewsArticle` que `buildArchiveNewsArticleJsonLd`
 * (`scripts/lib/site-archive-pages.ts`, #8336) grava em cada página do
 * acervo. **Esta é a data EDITORIAL** — já passou pela resolução de
 * `resolvePublishTimestampMs`/`publishDateToIso` no momento da geração da
 * página (honra `beehiiv-publish-date-overrides.json`, #4796), nunca o
 * `publish_date` cru que mente pras 6 edições mais antigas (importadas em
 * bloco em 04/09/2025, datadas pelo dia do IMPORT — a 1ª edição real é
 * 27/08/2025). Ler daqui, em vez de recalcular a partir de outra fonte
 * dentro do Worker, garante que `Last-Modified` nunca divirja do
 * `datePublished` que o crawler já vê no `<head>` da mesma página.
 *
 * `undefined` (nunca lança) quando a página não carrega o JSON-LD ainda —
 * cobre o estado ATUAL das 270 páginas committed (0 têm o script até a
 * regeneração da #8358 rodar) sem quebrar nada: o Worker simplesmente não
 * emite `Last-Modified` até a página ser regenerada, o `ETag` sozinho já
 * habilita revalidação.
 */
export function extractDatePublishedFromArchivePage(html: string): string | undefined {
  const match = html.match(/"@type"\s*:\s*"NewsArticle"[^}]*"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
  return match ? match[1] : undefined;
}

/**
 * #8498: destino do redirect de apoio — `apoia.se/diaria` + query string do
 * request + UTM do menu (`utm-registry.ts`, emissor `site-apoiar-redirect`).
 * Só preenche o que o request não trouxe: UTM explícito do chamador vence.
 */
function buildApoiarTarget(reqUrl: URL): string {
  const target = new URL(DIARIA_APOIASE_URL);
  target.search = reqUrl.search;
  const defaults: Record<string, string> = {
    utm_source: APOIAR_REDIRECT_UTM_SOURCE,
    utm_medium: APOIAR_REDIRECT_UTM_MEDIUM,
    utm_campaign: APOIAR_REDIRECT_UTM_CAMPAIGN,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  }
  return target.toString();
}

/** Conta o clique do dia; `incrementApoiarCounter` já é fail-soft (nunca lança). */
async function countApoiarClick(env: Env, keyFn: (day: string) => string = apoiarClickCounterKey): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await incrementApoiarCounter(env.CURSOS_SUBSCRIBERS, keyFn(day));
}

/**
 * #8355: monta a resposta 200 (ou 304) de uma página do acervo com
 * `ETag`/`Last-Modified` — chamada só quando `env.ASSETS.fetch` já
 * confirmou 200 pra um path `/p/{slug}`. `request.method === "HEAD"` sempre
 * refaz o fetch como GET internamente: RFC 7231 §4.3.2 exige que os headers
 * de uma resposta HEAD sejam idênticos aos que a mesma GET produziria, e
 * calcular o `ETag`/extrair `datePublished` exige o corpo — que uma
 * `Response` de HEAD pode não carregar (comportamento não garantido pelo
 * binding de assets). O custo extra (1 fetch a mais) só acontece pra HEAD
 * em `/p/{slug}`, nunca pra GET nem pros demais paths.
 */
async function withArchiveCacheValidators(request: Request, response: Response, env: Env): Promise<Response> {
  let bodyResponse = response;
  if (request.method === "HEAD") {
    const getRequest = new Request(request.url, { method: "GET", headers: request.headers });
    const refetched = await env.ASSETS.fetch(getRequest);
    if (refetched.status !== 200) return response; // defensivo — nunca deveria divergir do HEAD já 200
    bodyResponse = refetched;
  }
  const body = await bodyResponse.clone().text();
  const datePublished = extractDatePublishedFromArchivePage(body);

  const headers = new Headers(bodyResponse.headers);
  headers.set("ETag", weakEtag(body));
  if (datePublished) headers.set("Last-Modified", toHttpDate(datePublished));

  const withValidators = new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  return conditionalNotModified(request, withValidators) ?? withValidators;
}

/** Página de venda da aula Conteúdo Autêntico com IA; as versões ficam em subpastas (`/a`, `/b`). */
export const CONTEUDO_AUTENTICO_PATH = "/produto/conteudo-autentico";
/** Versão para onde `CONTEUDO_AUTENTICO_PATH` redireciona. Trocar aqui ao trocar de versão. */
export const CONTEUDO_AUTENTICO_VERSAO_ATIVA = "b";

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // #8982: beacon do clique em .checkout-link (evento/agente-ia) — cedo,
    // mesmo racional de /img/{key} e /confirmada abaixo (rota, não asset).
    if (request.method === "POST" && new URL(request.url).pathname === CLICK_BEACON_ENDPOINT) {
      return handleAgenteIaClique(request, env, ctx);
    }
    // #10082: webhook da Hotmart e leitura dos abandonos — rotas, não assets.
    // Aceita com ou sem barra final (o painel da Hotmart não segue redirect).
    {
      const hotmartUrl = new URL(request.url);
      const pathname = hotmartUrl.pathname.replace(/\/+$/, "");
      if (pathname === HOTMART_WEBHOOK_PATH && request.method === "POST") return handleHotmartWebhook(request, env);
      if (pathname === HOTMART_ABANDONOS_PATH && request.method === "GET") return handleHotmartAbandonos(request, env, hotmartUrl);
      if (pathname === HOTMART_VENDAS_PATH && request.method === "GET") return handleHotmartVendas(request, env, hotmartUrl);
    }
    // #8062: mesmo par de blocos fail-soft de workers/arquivo/src/index.ts —
    // log de Referer de assistente + contador de fetch por bot nomeado.
    // ANTES de qualquer outra lógica (asset lookup, /img, /confirmada): a
    // request casa ou não casa independente do que o resto do handler faz
    // com ela, e um try/catch isolado nunca deve atrasar a resposta real.
    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) {
        logAiReferrerHit("site", aiHost, new URL(request.url).pathname);
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchReferrerCounterKey(aiHost, day, "site"));
      }
    } catch {
      // logging nunca derruba a página — mesma disciplina do catch em
      // workers/arquivo/src/index.ts.
    }
    try {
      const bot = matchAiFetchBot(request.headers.get("User-Agent"));
      if (bot) {
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchBotCounterKey(bot, day, "site"));
      }
    } catch {
      // mesma disciplina fail-soft do bloco de Referer acima.
    }
    // #7657: `/img/{key}` é resolvido ANTES do asset lookup — não existe
    // arquivo nenhum em `public/img/`, então deixar cair no `env.ASSETS`
    // primeiro só gastaria um 404 pra chegar aqui de qualquer jeito. Só GET
    // e HEAD: o KV é leitura pura, qualquer outro método cai no fluxo de
    // sempre e termina no 404 do asset (mesmo critério do dispatch de
    // `/img/*` em workers/poll/src/index.ts).
    // reqUrl: parse único reusado pelos dispatches abaixo que precisam do
    // pathname ANTES do asset lookup (/img/{key} e /confirmada) — nome não
    // é mais "imageUrl" desde que o 2º dispatch (#7737) passou a usá-lo.
    const reqUrl = new URL(request.url);
    if (request.method === "GET" || request.method === "HEAD") {
      const key = imageKeyFromPath(reqUrl.pathname);
      if (key !== null) {
        return serveKvImage(key, env.POLL, request.headers.get("If-None-Match"), env.MEDIA, request.method);
      }
    }

    // #7737: /confirmada (renomeado de /confirmado em #8554) — sem arquivo
    // em public/, mesmo racional do /img/{key} acima: resolvido ANTES do
    // asset lookup pra não gastar um 404 desnecessário. Só GET, mesmo
    // critério do dispatch em workers/poll/src/index.ts (que agora só
    // redireciona pra cá).
    if (request.method === "GET" && reqUrl.pathname === "/confirmada") {
      // #8539: `?via=` distingue os dois caminhos de confirmação (e-mail do
      // Kit vs. botão da Brevo) — só muda uma linha de copy, nunca gateia o
      // acesso à página. Ausente/desconhecido = página padrão.
      return handleConfirmadoPage(reqUrl.searchParams.get("via") ?? undefined);
    }

    // #8554: /confirmado (path antigo, pré-rename) — 301 PERMANENTE pro
    // path novo, preservando query string. Nunca pode virar 404: há e-mails
    // de confirmação do Kit já entregues apontando pro endereço antigo, e o
    // "After confirming redirect to" do form Kit `9897918` também aponta
    // pra cá até o editor atualizar manualmente no painel (ver PR body).
    // `Response.redirect` é seguro aqui — diferente do redirect interno de
    // `workers/poll` (ver docstring de `handleConfirmadoRedirect`), este
    // Worker já usa `Response.redirect` em outros dois pontos abaixo, sem
    // mutação de headers pós-resposta que o invalide.
    if (request.method === "GET" && reqUrl.pathname === "/confirmado") {
      const target = new URL("/confirmada", reqUrl);
      target.search = reqUrl.search;
      return Response.redirect(target.toString(), 301);
    }

    // /produto/conteudo-autentico — a página de venda da aula ganhou versões em
    // pastas (/a = a de 18/10/2026, /b = a corrigida em 27/10/2026), e a URL
    // dos anúncios, da home e dos cursos passa a mandar para a versão ativa.
    // 302 (e não 301): a versão ativa muda a cada teste, e o navegador não deve
    // guardar o destino. Leva a query string inteira (UTMs e fbclid chegam à
    // página e ao checkout) e o hash. Redirecionar no Worker evita o salto extra
    // de uma página com script, que custa tempo de carregamento no celular.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (reqUrl.pathname === CONTEUDO_AUTENTICO_PATH || reqUrl.pathname === `${CONTEUDO_AUTENTICO_PATH}/`)
    ) {
      const target = new URL(`${CONTEUDO_AUTENTICO_PATH}/${CONTEUDO_AUTENTICO_VERSAO_ATIVA}`, reqUrl);
      target.search = reqUrl.search;
      return Response.redirect(target.toString(), 302);
    }

    // #8563: /evento/agente-ia — hospedado como asset ESTÁTICO em
    // public/evento/agente-ia/ (cópia real dos arquivos da página do workshop,
    // #8563 follow-up). Substituiu o proxy reverso desta mesma issue — o
    // editor forneceu os arquivos originais, então servir direto via
    // `env.ASSETS` (nenhum código de rota aqui) esconde o domínio
    // chatgpt.site com menos risco que um proxy (sem dependência de rede
    // externa, sem o problema de asset relativo resolvendo contra o host
    // errado). Nenhuma rota especial necessária — cai no `env.ASSETS.fetch`
    // padrão como qualquer outra página do site.

    // #8355: arquivo de chave do IndexNow — mesmo padrão de
    // workers/cursos/workers/livros (#5703), que generalizou o que nasceu
    // em workers/arquivo (#4909 item 2). Só casa quando `env.INDEXNOW_KEY`
    // está configurada; ausente, este `if` nunca é verdadeiro e o path cai
    // no fallback normal (`env.ASSETS.fetch`), comportamento inalterado.
    if (request.method === "GET") {
      const indexNowKey = matchIndexNowKeyPath(reqUrl.pathname, env.INDEXNOW_KEY);
      if (indexNowKey) {
        return new Response(indexNowKey, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }
    }

    // #7915/#8498: /apoiar/ir — sem arquivo em public/ (é uma ROTA, não uma
    // página), resolvido ANTES do asset lookup pelo mesmo motivo do
    // /confirmada acima. É o destino do item "Apoiar" do menu e do rodapé.
    // Incrementa o contador de CLIQUE (nunca pagamento confirmado — isso
    // continua vindo do apoia.se/Stripe) e redireciona (302) pro apoia.se,
    // preservando a query string do request e acrescentando o UTM do menu
    // (só os parâmetros ausentes — UTM explícito do chamador vence).
    // Fail-soft: falha no KV nunca impede o redirect.
    if (request.method === "GET" && reqUrl.pathname === "/apoiar/ir") {
      await countApoiarClick(env);
      return Response.redirect(buildApoiarTarget(reqUrl), 302);
    }

    // #8498: /apoiar — a página foi removida (a campanha do Apoia.se é a fonte
    // única). 301 PERMANENTE pro destino em vez de 404: o path pode estar
    // indexado/linkado por fora (nunca esteve no sitemap.xml). Conta em chave
    // SEPARADA (`counter:apoiar:legacy:*`) pra não misturar com o clique do
    // menu — por ser 301, o navegador cacheia e visitas repetidas não passam
    // pelo Worker, então é um piso, não a contagem exata. Cobre também a variante com barra
    // (html_handling = "drop-trailing-slash" só age DEPOIS deste bloco).
    if (request.method === "GET" && (reqUrl.pathname === "/apoiar" || reqUrl.pathname === "/apoiar/")) {
      await countApoiarClick(env, apoiarLegacyCounterKey);
      return Response.redirect(buildApoiarTarget(reqUrl), 301);
    }

    const response = await env.ASSETS.fetch(request);

    // #8355: só pra páginas do acervo (`/p/{slug}`) servidas com sucesso —
    // ver docstring de `withArchiveCacheValidators` acima pro racional
    // completo (ETag/Last-Modified/304). Passos anteriores (`/img/{key}`,
    // `/confirmada`, `/confirmado` (301), `/apoiar/*`) já retornaram antes
    // de chegar aqui, então esta checagem nunca compete com eles.
    if (response.status === 200 && (request.method === "GET" || request.method === "HEAD")) {
      const okSlug = matchArchiveSlug(reqUrl.pathname);
      if (okSlug) return withArchiveCacheValidators(request, response, env);
    }

    if (response.status !== 404) return response;

    const url = new URL(request.url);
    const slug = matchArchiveSlug(url.pathname);
    if (!slug) return response;

    // #6429 achado do fleet review: preservar a query string (UTM do link de
    // compartilhamento) e re-encodar o slug antes de montar a URL de destino
    // — `matchArchiveSlug` só valida "sem barra", nunca sanitiza pra uso em
    // path de URL.
    const target = new URL(`https://${EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/${encodeURIComponent(slug)}`);
    target.search = url.search;
    return Response.redirect(target.toString(), 302);
  },
};
