/**
 * workers/reativar/src/index.ts (#4476 item 3)
 *
 * Link de confirmação PERSONALIZADO pro segmento Pending do canal Brevo
 * próprio do editor (`data/snippets/brevo-diaria-pending-intro.md`) —
 * substitui o formulário de cadastro genérico da Beehiiv (2 etapas: clica →
 * digita o e-mail de novo) por 1 clique só. O e-mail chega via merge tag da
 * Brevo (`?email={{ contact.EMAIL }}`), SEM assinatura HMAC até o #8194 (hoje leva também `&t={{ contact.REATIVAR_TOKEN }}`, ver abaixo; sem token segue assim) — mesmo padrão
 * já usado no link de voto "É IA?" desde a decisão #1186 (modo merge-tag,
 * `inject-poll-sig.ts` removido — ver CLAUDE.md §Publicação manual requer
 * prep-manual-publish.ts).
 *
 * Rota: GET /?email=X → busca a subscription existente por e-mail, DELETA o
 * registro Pending travado e CRIA uma nova do zero (mesma mecânica de
 * `promoteBeehiivSubscription`, `scripts/evaluate-brevo-diaria.ts` — mas
 * essa via é acionada por CLIQUE explícito do usuário, não por inferência de
 * score sobre abertura passiva; ver #4476 item 2 — as duas vias de promoção
 * nunca colidem porque `evaluate-brevo-diaria.ts` checa auto-confirmação
 * Beehiiv ANTES de avaliar score).
 *
 * ## Link sem token: risco FECHADO pelo double opt-in (#7723) — com token, ver #8194 abaixo
 *
 * A URL não é assinada, então qualquer terceiro que descubra o padrão pode
 * chamá-la com e-mail alheio, sem prova de posse da caixa. De 260802 até
 * 09/09/2026 isso foi RISCO ACEITO (racional da #1186: o pior caso é a pessoa
 * passar a RECEBER a newsletter, não vazamento nem ação destrutiva; reverter
 * é 1 clique de unsubscribe; volume baixo, população cap 300).
 *
 * O #7723 fecha o risco **no caminho Kit**, sem precisar de HMAC: o clique na
 * URL cria o assinante como `inactive` e o vincula ao designer form, então a
 * ativação passa a depender de um clique no e-mail de confirmação, que só
 * chega ao DONO do endereço. No pior caso um terceiro faz o dono receber um
 * e-mail que ele ignora.
 *
 * ⚠️ **O fechamento é CONDICIONAL a `SUBSCRIBE_BACKEND === "kit"`**, e isso é
 * config, não garantia de código. O caminho Beehiiv (`activateSubscription`,
 * abaixo) NÃO foi tocado pelo #7723: continua fazendo DELETE+CREATE com
 * `double_opt_override: "off"` e ativando direto, sem confirmação nenhuma —
 * ou seja, sob aquele backend o risco original permanece exatamente como
 * descrito acima. Hoje `wrangler.toml` fixa `kit`, mas um rollback, um
 * ambiente novo ou um `.dev.vars` incompleto reverte o comportamento em
 * silêncio. Esta ressalva existe porque a 1ª versão desta nota dizia "a URL
 * sozinha não ativa mais ninguém", sem qualificar — afirmação mais forte que
 * o código sustenta (achado do review da PR #7760).
 *
 * **#7894**: o caminho Beehiiv legado (`activateSubscription`) não ganhou
 * guard de DOI equivalente ao do Kit — decisão consciente, não lacuna
 * esquecida: sem tráfego real hoje (`SUBSCRIBE_BACKEND = "kit"` fixo em
 * `wrangler.toml`, único ambiente, sem `[env.*]` que sobrescreva), portar o
 * mecanismo inteiro pra um caminho morto não paga o custo. O mínimo que
 * fecha o risco de regressão silenciosa — a config voltar a apontar pro
 * caminho sem-DOI sem ninguém notar — é `test/reativar-legacy-beehiiv-path-
 * disabled-7894.test.ts`, que falha se `SUBSCRIBE_BACKEND` deixar de estar
 * fixo em `"kit"`.
 *
 * **#8194 — token assinado**: o link da Brevo passou a levar
 * `&t={{ contact.REATIVAR_TOKEN }}` (`scripts/lib/shared/reativar-token.ts`).
 * Com token válido (`REATIVAR_SECRET`), o clique já prova posse da caixa e o
 * assinante é ativado direto, sem DOI — cadastro novo nasce `active`, e quem
 * já era `inactive` é promovido pelo vínculo ao form de sistema
 * `KIT_ACTIVATE_FORM_ID` (o upsert com `state:"active"` não promove, medido
 * ao vivo). Sem token ou com token inválido, vale tudo o que está descrito
 * acima (DOI) — **exceto** estado terminal (`cancelled`/`bounced`/
 * `complained`), que aborta ANTES do DOI mesmo sem token (#8269 item 4,
 * decisão registrada na issue: a versão original do guard só cobria o
 * caminho com token, o que deixava o caminho DOI mandar um e-mail de
 * confirmação pra quem já tinha reclamado de spam ou tido bounce — nada
 * nesse caminho prova posse nova da caixa, então não há razão pra tratar os
 * dois caminhos diferente aqui). Riscos aceitos pelo editor: encaminhamento
 * e scanners de link.
 *
 * O que NÃO mudou nem no caminho Kit: continua sem KV/rate-limit por IP.
 * Chamadas em massa à URL ainda geram e-mails de confirmação não solicitados —
 * é abuso de envio, não mais ativação indevida. Se o volume aparecer, é aí
 * que o rate-limit entra.
 *
 * ## Verificação ao vivo (#4476 item 3) — CONFIRMADA em 260802
 *
 * O teste anterior (2 contatos sintéticos, `@example.com`/`@mailinator.com`)
 * ficou inconclusivo: os 2 caíram em `status:"invalid"` (domínio disposable)
 * antes de chegar em `pending`. Um teste seguinte, com 1 contato Pending
 * REAL (autorizado explicitamente pelo editor), fechou a lacuna:
 * `reactivate_existing:true` **não mudou o status** (continuou `pending`).
 * Deletar o registro e criar do zero **ativou direto** (`validating` →
 * `active` em segundos). Esta versão do Worker já reflete essa mecânica —
 * `reactivate_existing` foi removido, não é mais usado em lugar nenhum.
 *
 * ## Guard de descadastro nativo pendente (#4538 item B)
 *
 * Antes do DELETE+CREATE, `checkNativeUnsubscribePending` consulta
 * `GET /v3/contacts/{email}` na Brevo — se `emailBlacklisted === true` (a
 * pessoa clicou no link de opt-out nativo do bloco de intro, ver
 * `data/snippets/brevo-diaria-pending-intro.md`, ou já foi propagado por
 * `scripts/evaluate-brevo-diaria.ts` passo 0), o clique em `?email=` NÃO
 * ativa direto — renderiza `renderNativeUnsubscribePage` explicando a
 * situação e oferecendo o cadastro normal como opt-in explícito. Fecha o
 * cenário 1 da issue #4538: clique tardio no CTA de uma edição antiga
 * reativando quem já disse não, em silêncio.
 *
 * Fail-OPEN quando `BREVO_DIARIA_API_KEY` está ausente (secret novo — mesmo
 * padrão de "1ª execução/armamento pendente do editor" já usado pros outros
 * secrets operacionais introduzidos sem sessão live, ver #4320/#4382): a
 * checagem é pulada e `activateSubscription` roda como se este guard não
 * existisse — nunca pior que o comportamento pré-#4538. Fail-open também em
 * erro de rede/HTTP da Brevo (timeout, 4xx/5xx) — um hiccup da Brevo não pode
 * travar TODO o fluxo de confirmação por causa de uma checagem que cobre um
 * edge case raro (população cap 300).
 *
 * Severidade do log NÃO é uniforme entre as 3 causas de fail-open (#4545
 * review — silent-failure-hunter): secret ausente é esperado/documentado
 * (`console.warn`); erro HTTP não-2xx e exceção de rede são falhas REAIS
 * (`console.error`) — em especial 401/403, que pode ser credencial
 * INVÁLIDA/REVOGADA (bug persistente) e não um hiccup transitório, logado com
 * mensagem própria pra não se perder no bucket genérico. O retorno
 * (`NativeUnsubscribeCheck`) também distingue os 3 casos de "não consegui
 * confirmar" (`status: "unknown"`, com `reason`) de "confirmei que NÃO está
 * pendente" (`status: "confirmed_not_pending"`) — `activateSubscription` só
 * bloqueia em `"confirmed_pending"`, tudo mais (incluindo `unknown`) segue
 * (fail-open preservado).
 *
 * ## Contadores de alarme durável (#4551)
 *
 * Cada um dos 3 motivos de fail-open acima incrementa um contador cumulativo
 * no KV opcional `REATIVAR_ALARM` (ver `scripts/lib/shared/reativar-alarm-counters.ts`
 * pras chaves + rationale completo) — mesmo padrão de `Diaria-Cursos-Error-Alarm`
 * (#4320/#4382): sem isso, o único sinal de uma `BREVO_DIARIA_API_KEY`
 * revogada ou de erro persistente da Brevo era `console.error`/`console.warn`
 * em `wrangler tail`, que ninguém olha ativamente. **Só o mecanismo de
 * contagem está implementado nesta unidade** — o binding `REATIVAR_ALARM`
 * ainda não foi criado (`wrangler kv namespace create REATIVAR_ALARM`, ver
 * `wrangler.toml`), e a task agendada de leitura/alarme por e-mail (mesmo
 * papel de `scripts/cursos-error-alarm.ts`) fica pendente do editor, mesma
 * disciplina já normalizada em CLAUDE.md pros #4320/#4382/#4490/#4534. Até
 * lá, `incrementReativarAlarmCounter` é NO-OP fail-soft (binding ausente).
 */

import { REATIVAR_ALARM_COUNTER_KEYS, incrementReativarAlarmCounter } from "../../../scripts/lib/shared/reativar-alarm-counters.ts";
import { BREVO_DIARIA_REATIVAR_CLIQUE_UTM } from "../../../scripts/lib/shared/utm-registry.ts"; // #4530
import { unlinkFromBrevoListShared } from "../../../scripts/lib/shared/brevo-list-unlink.ts"; // #4535
import { buildOrigemOriginalCustomFields } from "../../../scripts/lib/shared/beehiiv-origem-original.ts"; // #5231
import { sendCompleteRegistrationEvent, logMetaCapiSendResult } from "../../../scripts/lib/shared/meta-capi.ts"; // #5504, #7776
import { applyKitSignupOriginField } from "../../../scripts/lib/shared/kit-signup-origin.ts"; // #6048
import { resolveKitCreateState, vincularKitDoiForm, extrairSubscriberId, mensagemSubscriberIdAusente } from "../../../scripts/lib/shared/kit-doi.ts"; // #7723
import { verifyReativarToken } from "../../../scripts/lib/shared/reativar-token.ts"; // #8194
import { REATIVAR_CONFIRMOU_VIA_VALUE } from "../../../scripts/lib/shared/reativar-confirmou-via.ts"; // #8438
import { PAGE_URL as CONFIRMADO_PAGE_URL, VIA_BREVO } from "../../../scripts/lib/shared/confirmado-page.ts"; // #8539

export interface Env {
  /** Secret — `wrangler secret put BEEHIIV_API_KEY`. Sem ela, 503 amigável. */
  BEEHIIV_API_KEY?: string;
  /** Secret — `wrangler secret put BEEHIIV_PUBLICATION_ID`. */
  BEEHIIV_PUBLICATION_ID?: string;
  /** Override só pra teste (mock server local) — default `https://api.beehiiv.com/v2`. */
  BEEHIIV_API_URL?: string;
  /**
   * OPCIONAL (#5231, gate) — `wrangler secret put BEEHIIV_ORIGEM_ORIGINAL_FIELD`.
   * Nome do custom field na Beehiiv onde `buildOrigemOriginalCustomFields`
   * (`scripts/lib/shared/beehiiv-origem-original.ts`) grava a origem de
   * aquisição preservada do DELETE+CREATE. Ausente = gate OFF, comportamento
   * de hoje (sem `custom_fields` novo) — o editor só define depois de criar
   * o custom field `origem_original` na Beehiiv (item 1 da #5231); valor
   * recomendado é a constante `ORIGEM_ORIGINAL_FIELD_NAME` do mesmo módulo.
   * Mesmo padrão de `BEEHIIV_NAME_FIELD` (`workers/poll/src/subscribe.ts`).
   */
  BEEHIIV_ORIGEM_ORIGINAL_FIELD?: string;
  /**
   * Secret — `wrangler secret put BREVO_DIARIA_API_KEY` (#4538 item B).
   * Mesma key de `platform.config.json` → `brevo_diaria.api_key_env`
   * (`BREVO_DIARIA_API_KEY`). OPCIONAL: sem ela, o guard de descadastro
   * nativo pendente (`checkNativeUnsubscribePending`) é pulado (fail-open —
   * ver cabeçalho do módulo), nunca 503.
   */
  BREVO_DIARIA_API_KEY?: string;
  /** Override só pra teste (mock server local) — default `https://api.brevo.com/v3`. */
  BREVO_API_URL?: string;
  /**
   * Secret — `wrangler secret put BREVO_DIARIA_LIST_ID` (#4535). List id Brevo
   * do canal `brevo_diaria` (mesmo valor de `platform.config.json` →
   * `brevo_diaria.list_id`, hoje 7). OPCIONAL: sem ele (ou sem
   * `BREVO_DIARIA_API_KEY`), `unlinkReativarFromBrevoList` pula o unlink com
   * log estruturado — nunca derruba a ativação Beehiiv já feita. A varredura
   * diária (`evaluate-brevo-diaria.ts`, #4534) continua sendo a rede de
   * segurança que eventualmente desvincula mesmo sem esta chamada instantânea.
   */
  BREVO_DIARIA_LIST_ID?: string;
  /**
   * Binding OPCIONAL (#4551) — `wrangler kv namespace create REATIVAR_ALARM`,
   * ainda NÃO criado (ação pendente do editor, mesmo padrão dos #4320/#4382).
   * Sem ele, `incrementReativarAlarmCounter` é pulado (fail-soft) — mesmo
   * padrão de `SUBSCRIBERS_KV` opcional em `workers/poll/wrangler.toml`
   * (#3399/#4054): nunca quebra o fluxo principal por causa de um binding de
   * OBSERVABILIDADE ausente. Ver `scripts/lib/shared/reativar-alarm-counters.ts`.
   */
  REATIVAR_ALARM?: KVNamespace;
  /** #5504: Meta Conversions API — mesmo secret/mecanismo de
   * `workers/poll/src/index.ts` (ver docstring lá). OPCIONAL — ausente =
   * `sendCompleteRegistrationEvent` é no-op silencioso. */
  META_CAPI_ACCESS_TOKEN?: string;
  /**
   * #6048 (Fase 2/2, migração Beehiiv → Kit, #461/#463): seleção de backend
   * de ativação — mesmo padrão de `workers/poll/src/index.ts` (Fase 1,
   * #6082). Ausente/qualquer valor != "kit" → Beehiiv (default,
   * comportamento de hoje). Nenhum dispatch externo lê esta var ainda —
   * switchover manual do editor.
   */
  SUBSCRIBE_BACKEND?: string;
  /** Secret — `wrangler secret put KIT_API_KEY`. Sem ela,
   * `activateSubscriptionKit` retorna `not_configured` mesmo com
   * `SUBSCRIBE_BACKEND === "kit"` (mesmo padrão de `BEEHIIV_API_KEY` ausente). */
  KIT_API_KEY?: string;
  /** Override só pra teste (mock server local) — default `https://api.kit.com/v4`. */
  KIT_API_URL?: string;
  /** #7723: designer form do Kit com "Send confirmation email" ligado. É o
   * VÍNCULO a ele que dispara o e-mail de confirmação. Aqui ele fecha o risco
   * do link sem HMAC descrito no topo deste arquivo: sem o clique de
   * confirmação, a URL sozinha não ativa mais ninguém. VAR, não secret. */
  KIT_DOI_FORM_ID?: string;
  /** #8194 — secret (`wrangler secret put REATIVAR_SECRET`) do token assinado
   *  do botão da Brevo. Ausente = nenhum token vale, todo clique segue o DOI. */
  REATIVAR_SECRET?: string;
  /** #8194 — form de SISTEMA do Kit (sem e-mail de confirmação) usado pra
   *  promover `inactive → active` quando o token é válido: o upsert
   *  `POST /v4/subscribers {state:"active"}` NÃO muda o estado de quem já
   *  existe como `inactive` (medido ao vivo 16/09/2026), o vínculo a este form
   *  muda. VAR em `wrangler.toml`. Ausente = só cadastros novos ativam direto. */
  KIT_ACTIVATE_FORM_ID?: string;
  /** Nomes dos custom fields Kit onde gravar UTM/referring-site de reativação
   * (Kit não tem atribuição nativa — achado ao vivo #6048) — nenhum criado
   * em produção ainda, degrade gracioso. */
  KIT_UTM_SOURCE_FIELD?: string;
  KIT_UTM_MEDIUM_FIELD?: string;
  KIT_UTM_CAMPAIGN_FIELD?: string;
  KIT_REFERRING_SITE_FIELD?: string;
  /** #6048 — nome do custom field Kit que recebe o marcador de "entrou pelo
   *  funil" (`KIT_NATIVE_SIGNUP_MARKER`, scripts/lib/shared/kit-signup-origin.ts).
   *  VAR, não secret (mesmo tratamento dos demais `KIT_*_FIELD` acima —
   *  nome de custom field não é sensível, ver SECRETS.md do poll). Já
   *  criado em produção (`origem_cadastro`, 25/08/2026) — falta só setar a
   *  var pra ligar. Mesmo degrade gracioso ausente dos demais `KIT_*_FIELD`
   *  acima. */
  KIT_ORIGEM_CADASTRO_FIELD?: string;
  /**
   * #8438 — nome do custom field Kit (`confirmou_via`) onde o worker grava
   * `REATIVAR_CONFIRMOU_VIA_VALUE` ("brevo-reativar") SEMPRE que o clique chega
   * com token válido (#8194) — independente de origem de aquisição. É o único
   * sinal MEDÍVEL de "clicou no botão" pra quem entrou por google-ads/clarice/
   * diaria-apex (a UTM de reativação só carimba campos VAZIOS, #8235).
   * VAR, não secret (mesmo tratamento dos demais `KIT_*_FIELD` acima — nome de
   * custom field não é sensível). Ausente = field NUNCA é escrito, e
   * `evaluate-brevo-diaria.ts` Passo 1 lê como vazio → comportamento de hoje
   * (`self_confirmed_kit`/`self_confirmed_beehiiv`). Mesmo degrade gracioso
   * dos demais `KIT_*_FIELD`. */
  KIT_CONFIRMOU_VIA_FIELD?: string;
}

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;

/** Timeout explícito do fetch pra Beehiiv — mesmo racional de
 * `SUBSCRIBE_FETCH_TIMEOUT_MS` em `workers/poll/src/subscribe.ts` (#4438):
 * sem timeout, uma rede instável deixaria o `await` pendurado indefinidamente. */
export const ACTIVATE_FETCH_TIMEOUT_MS = 8000;

/** Espera antes de 1 releitura, só quando o CREATE responde `status:
 * "validating"` (#4476, achado ao vivo 260802): estado transitório — a
 * Beehiiv processa a validação de e-mail de forma assíncrona e resolve pra
 * `active` em poucos segundos (confirmado ao vivo: releitura ~alguns
 * segundos depois já mostrava `active`). Sem este retry, `handleConfirm`
 * mostraria "ainda não confirmado" pra quem na verdade só precisava de mais
 * 1-2s. Não faz retry pra outros status (ex: `invalid`) — são terminais. */
export const CONFIRM_RETRY_DELAY_MS = 2000;

// ── validação (pura) ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedEmailParam =
  | { ok: true; email: string }
  | { ok: false; error: "missing_email" | "invalid_email" };

/** Pura — extrai e valida `?email=` da query string. Nunca lança. */
export function parseEmailParam(url: URL): ParsedEmailParam {
  const raw = url.searchParams.get("email");
  if (!raw || raw.trim() === "") return { ok: false, error: "missing_email" };
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };
  return { ok: true, email };
}

// ── guard de descadastro nativo pendente (#4538 item B) ────────────────────

/**
 * Resultado de `checkNativeUnsubscribePending` (#4545 review —
 * type-design-analyzer): distingue "confirmei que a pessoa pediu pra sair"
 * de "não consegui confirmar nada, default seguro é seguir" — os dois
 * colapsavam no mesmo `false` antes desta correção, obscurecendo qual dos 2
 * motivos causou o fail-open num log/debug. `unknown.reason` carrega a causa
 * específica; `activateSubscription` só bloqueia em `"confirmed_pending"`.
 */
export type NativeUnsubscribeCheck =
  | { status: "confirmed_pending" }
  | { status: "confirmed_not_pending" }
  | { status: "unknown"; reason: "no_api_key" | "http_error" | "network_error" };

/**
 * `GET /v3/contacts/{email}` na Brevo — `confirmed_pending` se
 * `emailBlacklisted === true` (descadastro NATIVO, ação própria da pessoa —
 * mesmo sinal que `scripts/evaluate-brevo-diaria.ts` passo 0 detecta e
 * propaga pra Beehiiv). Fail-OPEN (`status: "unknown"`) quando
 * `BREVO_DIARIA_API_KEY` está ausente, ou em qualquer erro de rede/HTTP — ver
 * rationale completo no cabeçalho do módulo. `fetchImpl` injetável pra teste,
 * nunca rede real nos testes (#633).
 */
export async function checkNativeUnsubscribePending(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeUnsubscribeCheck> {
  const apiKey = env.BREVO_DIARIA_API_KEY;
  if (!apiKey) {
    // Esperado/documentado (secret novo, armamento pendente do editor) —
    // console.warn, não console.error. Diferente dos branches abaixo, que
    // são falhas reais.
    console.warn(JSON.stringify({ event: "reativar_brevo_guard_skipped", reason: "BREVO_DIARIA_API_KEY ausente" }));
    await incrementReativarAlarmCounter(env.REATIVAR_ALARM, REATIVAR_ALARM_COUNTER_KEYS.noApiKey);
    return { status: "unknown", reason: "no_api_key" };
  }
  const base = env.BREVO_API_URL ?? "https://api.brevo.com/v3";
  try {
    const res = await fetchImpl(`${base}/contacts/${encodeURIComponent(email)}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "confirmed_not_pending" }; // contato nunca existiu na Brevo — nada a bloquear
    if (!res.ok) {
      // console.error (não warn) — isto É uma falha real, diferente do caso
      // "secret ausente" acima. 401/403 especificamente pode ser credencial
      // INVÁLIDA/REVOGADA (bug persistente), não um hiccup — mensagem
      // própria pra não se perder no bucket genérico de erro.
      if (res.status === 401 || res.status === 403) {
        console.error(
          JSON.stringify({
            event: "reativar_brevo_guard_auth_error",
            status: res.status,
            hint: "BREVO_DIARIA_API_KEY provavelmente inválida/revogada — não é o mesmo caso de 'não configurada'",
          }),
        );
        await incrementReativarAlarmCounter(env.REATIVAR_ALARM, REATIVAR_ALARM_COUNTER_KEYS.httpErrorAuthDenied);
      } else {
        console.error(JSON.stringify({ event: "reativar_brevo_guard_non_2xx", status: res.status }));
      }
      await incrementReativarAlarmCounter(env.REATIVAR_ALARM, REATIVAR_ALARM_COUNTER_KEYS.httpError);
      return { status: "unknown", reason: "http_error" }; // fail-open — ver cabeçalho do módulo
    }
    const body = (await res.json().catch(() => null)) as { emailBlacklisted?: boolean } | null;
    return body?.emailBlacklisted === true ? { status: "confirmed_pending" } : { status: "confirmed_not_pending" };
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_brevo_guard_failed", error: String(e) }));
    await incrementReativarAlarmCounter(env.REATIVAR_ALARM, REATIVAR_ALARM_COUNTER_KEYS.networkError);
    return { status: "unknown", reason: "network_error" }; // fail-open — ver cabeçalho do módulo
  }
}

// ── ativação (I/O) ───────────────────────────────────────────────────────

export interface ActivateResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "beehiiv_error" | "native_unsubscribe_pending";
  /**
   * `data.status` da subscription APÓS o CREATE (ou o status já-`active`
   * encontrado no GET inicial, se a pessoa clicar 2x — idempotente). `ok:true`
   * reflete só o HTTP 2xx da última chamada; `beehiivStatus` carrega o estado
   * REAL, que `handleConfirm` usa pra decidir a página certa — nunca confiar
   * só no HTTP 2xx (achado do teste ao vivo #4476: POST pode responder 2xx
   * mesmo quando a subscription não fica `active`, ex: `status:"invalid"`).
   */
  beehiivStatus?: string | null;
  /**
   * #8539 — `true` quando o assinante **já estava `active` antes deste
   * request**, e portanto ESTE clique não confirmou nada.
   *
   * Existe porque `beehiivStatus: "active"` sozinho não distingue duas
   * coisas que agora têm consequências diferentes:
   *
   *  - a ativação ACONTECEU neste request (confirmação real), e
   *  - o assinante já estava ativo — clique repetido, ou promovido antes por
   *    um caminho que não é clique nenhum (`scripts/evaluate-brevo-diaria.ts`
   *    promove por score de abertura, sem depender de clique).
   *
   * Enquanto o desfecho de sucesso era uma página HTML sem tag, a diferença
   * era inócua. Desde que o sucesso redireciona pra uma página que mede
   * conversão, tratar os dois igual faria o segundo caso disparar uma
   * conversão de anúncio por uma confirmação que não houve — e conversão
   * contada não tem desfazer. Só `alreadyActive !== true` redireciona.
   */
  alreadyActive?: boolean;
}

/**
 * DELETE + CREATE — não mais `reactivate_existing` (#4476, mecânica
 * corrigida a partir do teste ao vivo 260802, ver header do módulo).
 * `fetchImpl` injetável pra teste — nunca faz rede real nos testes (#633).
 *
 * Passos:
 * 1. `GET .../subscriptions/by_email/{email}` — se já `active`, idempotente
 *    (pessoa clicou 2x, ou a via de score já promoveu): retorna sem tocar
 *    em nada. Se 404 (nunca existiu), pula direto pro passo 3.
 * 2. Se existe e não é `active`: `DELETE .../subscriptions/{id}` — remove o
 *    registro Pending travado. 404 aqui (sumiu entre o GET e o DELETE) não é
 *    erro, só segue.
 * 3. `POST .../subscriptions {email, send_welcome_email:false}` — cria do
 *    zero, SEM `reactivate_existing` (não há mais o que reativar). Cadastro
 *    novo ativa direto, sem double opt-in (mudança de fluxo da publicação) —
 *    é essa transição que o teste ao vivo confirmou.
 *
 * #5231: o mesmo corpo do GET do passo 1 também alimenta
 * `buildOrigemOriginalCustomFields` (`lib/shared/beehiiv-origem-original.ts`)
 * — preserva `utm_source`/`utm_medium`/`utm_campaign`/`referring_site`/
 * `created` originais num custom field do CREATE, em vez de deixá-los serem
 * sobrescritos silenciosamente pela UTM constante de reativação do passo 3.
 * Fail-soft: GET sem esses campos (ou corpo malformado) nunca bloqueia a
 * ativação, só resulta em nenhum custom field extra no CREATE.
 */
export async function activateSubscription(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ActivateResult> {
  const apiKey = env.BEEHIIV_API_KEY;
  const pubId = env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !pubId) {
    // #4476 achado silent-failure-hunter: sem log estruturado, um secret
    // ausente/rotacionado ficava invisível em wrangler tail/Workers Logs —
    // mesmo padrão de `event`/contexto já usado em workers/poll/src/vote.ts.
    // Nunca loga o email (dado pessoal) neste ponto — a config ausente não
    // depende do contato.
    console.error(JSON.stringify({ event: "reativar_not_configured", missing_api_key: !apiKey, missing_pub_id: !pubId }));
    return { ok: false, status: 503, reason: "not_configured" };
  }

  const base = env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
  const authHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  // 1) estado atual (idempotência — já active não precisa de mais nada).
  let existing: { id: string; status: string } | null = null;
  // #5231: origem original (utm_source/medium/campaign/referring_site/
  // created) lida do MESMO corpo do GET — hoje só se extraía `data.id`/
  // `data.status`. `undefined` (nunca lança) quando o corpo não tem `data`
  // ou nenhum campo de origem reconhecível — fail-soft, a ativação segue com
  // a UTM constante de sempre. Gated por `env.BEEHIIV_ORIGEM_ORIGINAL_FIELD`
  // (ver docstring de `beehiiv-origem-original.ts`): secret ausente =
  // `undefined` sempre, mesmo com origem no GET — o editor liga só depois de
  // criar o custom field na Beehiiv (#5231 item 1).
  let origemOriginalCustomFields: ReturnType<typeof buildOrigemOriginalCustomFields> = undefined;
  try {
    const getRes = await fetchImpl(`${base}/publications/${pubId}/subscriptions/by_email/${encodeURIComponent(email)}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (getRes.status === 404) {
      existing = null;
    } else if (!getRes.ok) {
      console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "get", status: getRes.status }));
      return { ok: false, status: getRes.status, reason: "beehiiv_error" };
    } else {
      // #4488 review (silent-failure-hunter, achado crítico): um 2xx com
      // corpo malformado/truncado NÃO pode virar "existing:null" em
      // silêncio — isso pularia o DELETE e recriaria exatamente o bug que
      // esta PR corrige (POST puro contra um e-mail que já tem registro
      // Pending travado). Loga e falha explícito, mesmo tratamento dos
      // outros passos, em vez de `.catch(() => null)`.
      let body: { data?: { id?: string; status?: string } } | null = null;
      try {
        body = (await getRes.json()) as { data?: { id?: string; status?: string } };
      } catch (e) {
        console.error(JSON.stringify({ event: "reativar_response_parse_failed", step: "get", status: getRes.status, error: String(e) }));
        return { ok: false, status: 502, reason: "beehiiv_error" };
      }
      existing = body?.data?.id ? { id: body.data.id, status: body.data.status ?? "" } : null;
      origemOriginalCustomFields = buildOrigemOriginalCustomFields(
        body as Parameters<typeof buildOrigemOriginalCustomFields>[0],
        env.BEEHIIV_ORIGEM_ORIGINAL_FIELD,
      );
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "get", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }

  if (existing?.status === "active") {
    // #8539: `alreadyActive` — este request não confirmou nada (ver docstring
    // do campo em `ActivateResult`). Sem isso o redirect de sucesso dispararia
    // conversão pra clique repetido.
    return { ok: true, status: 200, beehiivStatus: "active", alreadyActive: true };
  }

  // 1.5) guard de descadastro nativo pendente (#4538 item B) — SÓ checado
  // quando estamos de fato prestes a fazer DELETE+CREATE (já passou pela
  // idempotência acima). Só bloqueia em "confirmed_pending" — "unknown"
  // (não consegui checar) segue como fail-open, mesmo tratamento de
  // "confirmed_not_pending" (ver `checkNativeUnsubscribePending`).
  const nativeCheck = await checkNativeUnsubscribePending(env, email, fetchImpl);
  if (nativeCheck.status === "confirmed_pending") {
    console.warn(JSON.stringify({ event: "reativar_blocked_native_unsubscribe_pending" }));
    return { ok: true, status: 200, reason: "native_unsubscribe_pending" };
  }

  // 2) deleta o registro travado (se existir e não for active).
  if (existing) {
    try {
      const delRes = await fetchImpl(`${base}/publications/${pubId}/subscriptions/${existing.id}`, {
        method: "DELETE",
        headers: authHeaders,
        signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
      });
      if (!delRes.ok && delRes.status !== 404) {
        console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "delete", status: delRes.status }));
        return { ok: false, status: delRes.status, reason: "beehiiv_error" };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "delete", error: String(e) }));
      return { ok: false, status: 502, reason: "beehiiv_error" };
    }
  }

  // 3) cria do zero.
  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        send_welcome_email: false,
        // #5095: ISENÇÃO OBRIGATÓRIA, não conveniência. Este caminho DELETA o
        // registro existente (passo 2, acima) e recria do zero. Com o double
        // opt-in da publicação ligado e sem este override, cada reativação
        // apagaria um assinante e o recriaria em `pending` — ele pararia de
        // receber a diária até clicar num e-mail de confirmação que ele não
        // pediu, e a Beehiiv não expõe jeito programático de promover
        // pending→active. O clique na campanha Brevo JÁ é o opt-in explícito.
        double_opt_override: "off",
        // #4530: atribuição — sem isto, todo cadastro criado por este caminho
        // caía como "api: direct / (none)" na Beehiiv, indistinguível de
        // qualquer outro cadastro via API.
        utm_source: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source,
        utm_medium: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium,
        utm_campaign: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign,
        referring_site: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
        // #5231: preserva a origem de aquisição ORIGINAL (lida do GET do
        // passo 1) num custom field — sem isto, o DELETE+CREATE acima
        // sobrescreve utm_source/medium/campaign/referring_site com a
        // constante fixa acima, perdendo pra sempre a origem real do
        // contato. GATED por `env.BEEHIIV_ORIGEM_ORIGINAL_FIELD` (secret,
        // off por padrão) — só tem efeito real (e só é enviado) depois que o
        // editor criar o custom field `origem_original` na Beehiiv (#5231
        // item 1) E setar o secret; até lá `origemOriginalCustomFields` é
        // sempre `undefined`, comportamento idêntico a antes desta feature.
        ...(origemOriginalCustomFields ? { custom_fields: origemOriginalCustomFields } : {}),
      }),
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "create", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (!res.ok) {
    console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "create", status: res.status }));
    return { ok: false, status: res.status, reason: "beehiiv_error" };
  }

  let beehiivStatus: string | null = null;
  try {
    const body = (await res.json()) as { data?: { status?: string } };
    beehiivStatus = body.data?.status ?? null;
  } catch (e) {
    console.warn(JSON.stringify({ event: "reativar_response_parse_failed", step: "create", status: res.status, error: String(e) }));
  }

  // Estado transitório — 1 retry curto antes de aceitar como resultado final
  // (ver `CONFIRM_RETRY_DELAY_MS`). Falha na releitura mantém o
  // `beehiivStatus` original ("validating") — `handleConfirm` trata como
  // não-confirmado, fail-safe (nunca mostra sucesso sem confirmar de fato).
  if (beehiivStatus === "validating") {
    await sleepImpl(CONFIRM_RETRY_DELAY_MS);
    try {
      const recheck = await fetchImpl(`${base}/publications/${pubId}/subscriptions/by_email/${encodeURIComponent(email)}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
      });
      if (recheck.ok) {
        const body = (await recheck.json().catch(() => null)) as { data?: { status?: string } } | null;
        if (body?.data?.status) beehiivStatus = body.data.status;
      } else {
        // #4488 review (silent-failure-hunter): não é uma exceção (não cai
        // no catch abaixo), mas também não pode passar batido sem log — só
        // o GET inicial tinha essa disciplina antes.
        console.warn(JSON.stringify({ event: "reativar_recheck_non_2xx", status: recheck.status }));
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: "reativar_recheck_failed", error: String(e) }));
    }
  }

  return { ok: true, status: res.status, beehiivStatus };
}

/**
 * #6048 (Fase 2/2, migração Beehiiv → Kit, #461/#463): equivalente Kit de
 * `activateSubscription` acima — MAIS SIMPLES que o caminho Beehiiv, não
 * DELETE+CREATE. Achados ao vivo reusados sem redescobrir (ver docstring
 * completa de `subscribeToKit` em `workers/poll/src/subscribe.ts`, Fase 1
 * #6082):
 *
 * - `POST /v4/subscribers` é IDEMPOTENTE por e-mail — não existe o problema
 *   Beehiiv de "registro Pending travado que precisa ser deletado antes de
 *   recriar" (esse problema É a razão de existir do DELETE+CREATE acima).
 *   Um único POST com `state: "active"` faz o mesmo trabalho de reativação
 *   que o passo 3 do caminho Beehiiv faz — sem passo 1 (GET pra decidir) nem
 *   passo 2 (DELETE) serem estruturalmente necessários.
 * - `state: "active"` bypassa qualquer confirmação — mesmo efeito do
 *   `double_opt_override: "off"` da Beehiiv (ver bloco DOUBLE OPT-IN em
 *   `workers/poll/src/subscribe.ts`).
 *
 * Ainda assim, mantemos 1 GET inicial (`?email_address=`) só pra idempotência
 * honesta — pessoa clica 2x, ou a via de score do `evaluate-brevo-diaria.ts`
 * já promoveu — e pro guard de descadastro nativo pendente (#4538 item B,
 * `checkNativeUnsubscribePending`, backend-agnóstico — Brevo é a fonte desse
 * guard nos dois caminhos).
 *
 * ## Preservação de "origem original" — Kit: #8235 (supera o texto histórico abaixo)
 *
 * Os `KIT_UTM_*_FIELD` foram ligados no #6318 e o upsert passou a sobrescrever
 * a origem de quem já existia (teste pago 2608: `google-ads` → `brevo-diaria`
 * no clique do Confirmar). Desde o #8235, quando o assinante já existe, o
 * worker lê os campos atuais pelo GET SINGULAR (`readKitSubscriberFields`) e
 * só manda no POST os campos de origem (`utm_*`, `referring_site`,
 * `origem_cadastro`) que estão VAZIOS (`filterKitOrigemFields`). Leitura
 * falhou → nenhum campo de origem vai (fail-closed), a ativação segue. Vale
 * com e sem token. Log `reativar_kit_origem_preservada` quando algo é poupado.
 * Cadastro novo continua recebendo a UTM de reativação.
 *
 * Texto histórico (pré-#8235):
 *
 * O caminho Beehiiv (`activateSubscription`) lê a UTM original do GET e a
 * preserva num `custom_fields` dedicado antes do DELETE+CREATE sobrescrever
 * a atribuição com a UTM constante de reativação (`buildOrigemOriginalCustomFields`).
 * Para Kit, este PR NÃO reimplementa esse mecanismo — degrade gracioso
 * documentado explicitamente (mesmo padrão do #6048 Fase 1 pra UTM/nome):
 * Kit não tem UTM nativo, só via `fields` customizado, e nenhum
 * `KIT_ORIGEM_ORIGINAL_FIELD` foi criado em produção. Diferente da Beehiiv,
 * o upsert do Kit só sobrescreve os `fields` que o POST de fato enviar — se
 * nenhum `KIT_UTM_*_FIELD` estiver configurado, o POST não manda `fields`
 * nenhum, e qualquer atribuição capturada no cadastro original (se algum dia
 * gravada via `subscribeToKit`) fica intocada. Ou seja: a preservação
 * acontece "de graça" pela semântica de upsert do Kit, SEM precisar do
 * mecanismo de leitura+reescrita explícito que a Beehiiv exige — mas só
 * enquanto os `KIT_UTM_*_FIELD` de reativação continuarem ausentes; ligá-los
 * reintroduz a mesma sobrescrita que o #5231 resolveu do lado Beehiiv, sem
 * mitigação equivalente aqui. Fica pra quando/se o editor decidir ligar
 * atribuição de reativação via Kit (trabalho futuro, sem issue própria).
 *
 * ## Marcador de origem de cadastro (#6048) — LIMITAÇÃO CONHECIDA no early-return
 *
 * `applyKitSignupOriginField` (grava `KIT_NATIVE_SIGNUP_MARKER` em
 * `KIT_ORIGEM_CADASTRO_FIELD`, ver `scripts/lib/shared/kit-signup-origin.ts`)
 * só é alcançado no upsert (passo 2 abaixo) — o early-return de idempotência
 * (passo 1, `existingState === "active"`) sai ANTES desse bloco. Um
 * assinante que já está `active` no Kit no momento do clique de reativação
 * — o caso mais provável sendo alguém copiado pela sync Beehiiv→Kit
 * (#6091/#6093) — nunca recebe o marcador por essa via, mesmo clicando de
 * verdade no link. Achado do fleet review pré-merge do #6127 (25/08/2026):
 * silencioso e sem teste até então; agora logado (`reativar_kit_marker_not_backfilled`)
 * quando `KIT_ORIGEM_CADASTRO_FIELD` está configurado, pra ficar observável
 * em vez de indistinguível de "marcador nunca precisou". Backfillar via
 * PATCH nesse caminho é possível mas muda o early-return de no-op puro pra
 * escrita condicional — decisão de produto que fica pro editor, não
 * implementada aqui.
 */
export async function activateSubscriptionKit(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
  // #8194: `true` quando o link trouxe token assinado válido — o clique já
  // prova posse da caixa, então ativa direto em vez de disparar o DOI.
  confirmedByToken = false,
): Promise<ActivateResult> {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({ event: "reativar_kit_not_configured" }));
    return { ok: false, status: 503, reason: "not_configured" };
  }

  const base = env.KIT_API_URL ?? "https://api.kit.com/v4";
  const authHeaders = { "X-Kit-Api-Key": apiKey, Accept: "application/json" };

  // 1) idempotência — já active não precisa de mais nada.
  // #8235: `existingId` indica que o assinante JÁ existe — decide, no passo 2,
  // se os campos de origem precisam ser lidos pelo GET singular antes do upsert.
  let existingId: string | number | undefined;
  let existsAlready = false;
  try {
    // #8235 (hotfix): `status=all` é obrigatório — sem ele o endpoint de lista do
    // Kit devolve SÓ assinantes active, então um inactive (exatamente o público
    // do botão Confirmar) voltava como inexistente e o upsert sobrescrevia a
    // origem. Medido ao vivo em 17/09/2026 com fixture +probe.
    const getRes = await fetchImpl(`${base}/subscribers?email_address=${encodeURIComponent(email)}&status=all`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (!getRes.ok) {
      // #6129: corpo da resposta (truncado) — só o status não distingue rede
      // caída de config errada (ex: KIT_API_KEY inválida, custom field com
      // nome errado) nos logs.
      const getBodyText = await getRes.text().catch(() => "<unreadable>");
      console.error(
        JSON.stringify({ event: "reativar_kit_non_2xx", step: "get", status: getRes.status, body: getBodyText.slice(0, 500) }),
      );
      return { ok: false, status: getRes.status, reason: "beehiiv_error" };
    }
    const body = (await getRes.json().catch(() => null)) as
      | { subscribers?: { id?: string | number; state?: string; email_address?: string }[] }
      | null;
    // #8235 (review da #8266): a lista pode devolver assinante que NÃO bate o
    // e-mail buscado (busca aproximada — mesmo achado do #7373 em
    // getKitSubscriberByEmail). Só match exato conta como "este assinante".
    // Lista não vazia SEM match exato = ambíguo: trata como existente com
    // estado e id desconhecidos — a ativação segue, mas nenhum campo de origem
    // é gravado (readKitSubscriberFields sem id → null → fail-closed).
    const lista = body?.subscribers ?? [];
    const alvo = email.trim().toLowerCase();
    const match = lista.find((s) => (s.email_address ?? "").trim().toLowerCase() === alvo);
    if (lista.length > 0 && !match) {
      console.warn(JSON.stringify({ event: "reativar_kit_lookup_sem_match_exato", resultados: lista.length }));
    }
    const existingState = match?.state;
    existsAlready = match != null || lista.length > 0;
    existingId = match?.id;
    // #8194/#8269 item 4: nunca ressuscita quem saiu (cancelled/complained/
    // bounced) — o clique no botão da Brevo não desfaz um descadastro no
    // Kit. Vale COM ou SEM token (decisão #8269: a assimetria original —
    // guard só no caminho com token — deixava o caminho SEM token, que
    // ainda dispara o DOI, mandar um e-mail de confirmação pra um endereço
    // `complained`/`bounced`; nada nessa via prova posse nova da caixa, e
    // reenviar pra quem já reclamou de spam é o dano que este guard existe
    // pra evitar em primeiro lugar).
    if (existingState && existingState !== "active" && existingState !== "inactive") {
      console.warn(JSON.stringify({ event: "reativar_kit_estado_terminal", state: existingState, token: confirmedByToken }));
      return { ok: true, status: 200, beehiivStatus: existingState };
    }
    if (existingState === "active") {
      // #6048/#6127: este early-return pula o bloco de `fields` abaixo —
      // um assinante que chega aqui JÁ ativo no Kit nunca recebe o
      // marcador `origem_cadastro` (ver "Marcador de origem..." na
      // docstring acima). Log estruturado só quando o marcador estaria
      // configurado, pra não gerar ruído em ambientes onde a var nem
      // existe ainda.
      if (env.KIT_ORIGEM_CADASTRO_FIELD) {
        console.warn(JSON.stringify({ event: "reativar_kit_marker_not_backfilled", reason: "already_active" }));
      }
      // #8539: ver docstring de `alreadyActive` em `ActivateResult`.
      return { ok: true, status: 200, beehiivStatus: "active", alreadyActive: true };
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_kit_fetch_failed", step: "get", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }

  // 1.5) guard de descadastro nativo pendente (#4538 item B) — mesmo guard
  // backend-agnóstico do caminho Beehiiv (fonte é sempre Brevo).
  const nativeCheck = await checkNativeUnsubscribePending(env, email, fetchImpl);
  if (nativeCheck.status === "confirmed_pending") {
    console.warn(JSON.stringify({ event: "reativar_kit_blocked_native_unsubscribe_pending" }));
    return { ok: true, status: 200, reason: "native_unsubscribe_pending" };
  }

  // 2) upsert direto — sem DELETE, ver docstring acima. `fields` só vai no
  // corpo quando os respectivos KIT_*_FIELD estão configurados — e, desde o
  // #8235, só os campos que ainda estão VAZIOS no assinante (ver seção
  // "Preservação de origem original" na docstring).
  const desired: Record<string, string> = {};
  if (env.KIT_UTM_SOURCE_FIELD) desired[env.KIT_UTM_SOURCE_FIELD] = BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source;
  if (env.KIT_UTM_MEDIUM_FIELD) desired[env.KIT_UTM_MEDIUM_FIELD] = BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium;
  if (env.KIT_UTM_CAMPAIGN_FIELD) desired[env.KIT_UTM_CAMPAIGN_FIELD] = BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign;
  if (env.KIT_REFERRING_SITE_FIELD) desired[env.KIT_REFERRING_SITE_FIELD] = BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite;
  // #6048: marcador "entrou pelo funil" — distingue de quem só foi copiado
  // da Beehiiv pelo sync unidirecional (necessário pra segmentar o envio
  // sem entrega duplicada, ver scripts/lib/shared/kit-signup-origin.ts).
  // NÃO cobre o early-return acima (assinante já active) — ver docstring
  // desta função pra essa limitação conhecida (achado do fleet review,
  // #6127) e o log estruturado que sinaliza quando isso acontece.
  applyKitSignupOriginField(desired, env);

  // #8438: sinal MEDÍVEL de "clicou no botão de confirmar" — escrito SEMPRE
  // que o clique chegou com token válido (#8194), independente de origem de
  // aquisição. Diferente das UTM de reativação (que o #8235 proibe de
  // sobrescrever origem já preenchida), este field é ORTEGONAL à origem: quem
  // entrou por google-ads/clarice/diaria-apex já tem utm_source gravado, então
  // o clique NUNCA carimba a origem — e aí o fato de "clicou" era
  // indistinguível de "quem era esse contato antes". Com este field, o
  // `evaluate-brevo-diaria.ts` Passo 1 lê `confirmou_via` e refinamento o
  // `resolution_reason` pra `self_confirmed_kit_botao`.
  //
  // Fail-soft: sem `KIT_CONFIRMOU_VIA_FIELD` configurado, o field NUNCA é
  // escrito — o evaluate lê como vazio e o comportamento de hoje é
  // preservado (`self_confirmed_kit`/`self_confirmed_beehiiv`). O `via` é
  // condicional a `confirmedByToken`: no caminho DOI (sem token) NINGUÉM
  // clicou no botão de fato, então não há o que medir — e escrever o field
  // ali seria um falso positivo (o evaluate veria "botão" pra quem só
  // recebeu o e-mail de DOI e ainda não clicou).
  // #8518: `confirmou_via` é ORTOGONAL à origem (ver comentário acima) —
  // precisa ficar FORA de `desired` antes de passar por
  // `filterKitOrigemFields`, senão uma falha de leitura do GET singular
  // (`current === null`, fail-closed) descarta TODOS os campos de `desired`
  // indiscriminadamente, `confirmou_via` incluído, e a perda de medição sai
  // logada como `reativar_kit_origem_preservada` — rótulo que só faz
  // sentido pra campo de origem. Extraído aqui e mesclado de volta em
  // `fields` depois do filtro, incondicional ao resultado da leitura.
  let confirmouViaField: Record<string, string> = {};
  if (confirmedByToken && env.KIT_CONFIRMOU_VIA_FIELD) {
    confirmouViaField = { [env.KIT_CONFIRMOU_VIA_FIELD]: REATIVAR_CONFIRMOU_VIA_VALUE };
  }

  // #8235: assinante que já existe → lê os campos atuais pelo GET SINGULAR
  // (o endpoint de lista pode servir `fields` defasado) e nunca sobrescreve
  // origem já gravada. Leitura falhou → não grava NENHUM campo de origem
  // (fail-closed), mas a ativação segue.
  let fields: Record<string, string> = desired;
  if (existsAlready && Object.keys(desired).length > 0) {
    const current = await readKitSubscriberFields(base, authHeaders, existingId, fetchImpl);
    fields = filterKitOrigemFields(desired, current);
    const preservados = Object.keys(desired).filter((k) => !(k in fields));
    if (preservados.length > 0) {
      console.warn(
        JSON.stringify({
          event: "reativar_kit_origem_preservada",
          // `leitura_falhou`: GET singular não devolveu os campos — nada de
          // origem é gravado (fail-closed); `campo_preenchido`: o assinante já
          // tinha valor nesses campos.
          motivo: current === null ? "leitura_falhou" : "campo_preenchido",
          campos: preservados,
          utm_source_atual:
            current !== null && env.KIT_UTM_SOURCE_FIELD ? (current[env.KIT_UTM_SOURCE_FIELD] ?? null) : null,
          token: confirmedByToken,
        }),
      );
    }
  }

  // #8518: mescla `confirmou_via` de volta em `fields` DEPOIS do filtro de
  // origem, incondicional ao resultado de `readKitSubscriberFields` — é o
  // único jeito de honrar o "independente de origem" que motivou o #8438.
  if (Object.keys(confirmouViaField).length > 0) {
    fields = { ...fields, ...confirmouViaField };
  }

  // #7723: double opt-in também aqui — e neste worker ele não é só
  // conformidade, é o conserto de um risco DOCUMENTADO E ACEITO no topo deste
  // arquivo: o link de reativação SEM token válido (#8194) não tem assinatura HMAC, então qualquer
  // terceiro que descubra o padrão da URL pode "confirmar" e-mail alheio sem
  // prova de posse da caixa. Em agosto/2026 o risco foi aceito por falta de
  // alternativa barata ("o pior caso é a pessoa passar a RECEBER"). O DOI é
  // essa alternativa: criar `inactive` + vincular ao form faz a ativação
  // depender de um clique no e-mail que só chega ao dono do endereço. O link
  // sem HMAC deixa de ativar ninguém sozinho.
  //
  // #8194: com token assinado válido, o clique já É a prova de posse — ativa
  // direto, sem DOI.
  const createState = confirmedByToken ? "active" : resolveKitCreateState(env.KIT_DOI_FORM_ID, "reativar");

  const postBody: Record<string, unknown> = { email_address: email, state: createState };
  if (Object.keys(fields).length > 0) postBody.fields = fields;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/subscribers`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(postBody),
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_kit_fetch_failed", step: "create", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (!res.ok) {
    // #6129: mesmo racional do branch "get" acima — corpo (truncado) em vez
    // de só o status.
    const bodyText = await res.text().catch(() => "<unreadable>");
    console.error(
      JSON.stringify({ event: "reativar_kit_non_2xx", step: "create", status: res.status, body: bodyText.slice(0, 500) }),
    );
    return { ok: false, status: res.status, reason: "beehiiv_error" };
  }

  // #7723: vincula ao designer form — é o vínculo que dispara o e-mail de
  // confirmação. Só quando o assinante nasceu `inactive` por este caminho.
  // Best-effort: nunca falha a reativação.
  if (createState === "inactive") {
    const extraido = await extrairSubscriberId(res);
    if (extraido.ok) {
      await vincularKitDoiForm({
        apiKey,
        base,
        formId: env.KIT_DOI_FORM_ID,
        subscriberId: extraido.id,
        referrer: `https://reativar.diar.ia.br/?utm_source=${encodeURIComponent(BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source)}&utm_medium=${encodeURIComponent(BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium)}&utm_campaign=${encodeURIComponent(BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign)}`,
        fetchImpl,
        timeoutMs: ACTIVATE_FETCH_TIMEOUT_MS,
        log: (m) => console.error(JSON.stringify({ event: "reativar_kit_doi_link_failed", detail: m })),
      });
    } else {
      console.error(
        JSON.stringify({
          event: "reativar_kit_doi_sem_subscriber_id",
          status: res.status,
          email,
          motivo: extraido.motivo,
          detail: mensagemSubscriberIdAusente(extraido, email, res.status),
        }),
      );
    }
  }

  if (confirmedByToken) {
    return promoteKitWithToken(env, apiKey, base, email, res, fetchImpl);
  }

  // Kit confirma na resposta o `state` que o POST mandou (achado ao vivo
  // #6048, Fase 1) — sem o estado transitório "validating" da Beehiiv, então
  // sem retry necessário. Com DOI, esse estado é `inactive` até a pessoa
  // confirmar: o retorno reflete isso em vez de afirmar "active".
  return { ok: true, status: res.status, beehiivStatus: createState };
}

/**
 * #8235 — lê os custom fields atuais de um assinante Kit pelo GET SINGULAR
 * `/v4/subscribers/{id}`. O endpoint de lista (`?email_address=`) pode servir
 * `fields` defasado, então nunca é usado pra decidir preservação.
 *
 * Retorna `null` em QUALQUER falha (sem id, non-2xx, exceção, corpo sem
 * `subscriber.fields`) — quem chama trata `null` como "origem desconhecida"
 * e não grava campo de origem nenhum.
 */
export async function readKitSubscriberFields(
  base: string,
  headers: Record<string, string>,
  id: string | number | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, string | null> | null> {
  if (id == null || id === "") {
    console.error(JSON.stringify({ event: "reativar_kit_origem_sem_id" }));
    return null;
  }
  try {
    const r = await fetchImpl(`${base}/subscribers/${encodeURIComponent(String(id))}`, {
      headers,
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "<unreadable>");
      console.error(
        JSON.stringify({ event: "reativar_kit_non_2xx", step: "get_fields", status: r.status, body: t.slice(0, 300) }),
      );
      return null;
    }
    const text = await r.text().catch(() => "");
    let j: { subscriber?: { fields?: Record<string, string | null> | null } } | null = null;
    try {
      j = JSON.parse(text);
    } catch {
      console.error(JSON.stringify({ event: "reativar_kit_origem_sem_fields", motivo: "json_invalido", body: text.slice(0, 300) }));
      return null;
    }
    const f = j?.subscriber?.fields;
    if (f == null || typeof f !== "object") {
      console.error(
        JSON.stringify({
          event: "reativar_kit_origem_sem_fields",
          motivo: "sem_campo_fields",
          // só as chaves — o corpo do assinante traz e-mail.
          chaves: j?.subscriber ? Object.keys(j.subscriber) : null,
        }),
      );
      return null;
    }
    return f;
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_kit_fetch_failed", step: "get_fields", error: String(e) }));
    return null;
  }
}

/**
 * #8235 — dos campos de origem que o reativar QUERIA gravar, mantém só os que
 * estão vazios no assinante. `current === null` (leitura falhou) → nenhum.
 * Reativação não é aquisição (regra de `acquisition-class.ts`), então nenhuma
 * origem existente é sobrescrita — pagas, Clarice, formulários próprios. @pure
 */
export function filterKitOrigemFields(
  desired: Record<string, string>,
  current: Record<string, string | null | undefined> | null,
): Record<string, string> {
  if (current === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(desired)) {
    const atual = current[k];
    if (atual == null || String(atual).trim() === "") out[k] = v;
  }
  return out;
}

/**
 * #8194 — pós-upsert do caminho com token. Cadastro novo já nasce `active`
 * pelo POST. Quem já existia `inactive` (clicou antes e não confirmou o DOI,
 * ou veio do pool Kit do #8192) continua `inactive` mesmo com
 * `state:"active"` no upsert — medido ao vivo em 16/09/2026. O vínculo ao form
 * de sistema (`KIT_ACTIVATE_FORM_ID`, sem e-mail de confirmação) é o que
 * promove. O estado final vem sempre de `GET /subscribers/{id}`: o corpo do
 * POST do vínculo ainda diz `inactive` mesmo quando a promoção funcionou.
 */
async function promoteKitWithToken(
  env: Env,
  apiKey: string,
  base: string,
  email: string,
  createRes: Response,
  fetchImpl: typeof fetch,
): Promise<ActivateResult> {
  const headers = { "X-Kit-Api-Key": apiKey, Accept: "application/json" };
  const extraido = await extrairSubscriberId(createRes);
  if (!extraido.ok) {
    console.error(
      JSON.stringify({
        event: "reativar_kit_token_sem_subscriber_id",
        detail: mensagemSubscriberIdAusente(extraido, email, createRes.status),
      }),
    );
    return { ok: true, status: createRes.status, beehiivStatus: null };
  }
  const readState = async (): Promise<string | null> => {
    const r = await fetchImpl(`${base}/subscribers/${extraido.id}`, {
      headers,
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { subscriber?: { state?: string } } | null;
    return j?.subscriber?.state ?? null;
  };
  try {
    let state = await readState();
    if (state === "inactive" && env.KIT_ACTIVATE_FORM_ID) {
      const link = await fetchImpl(`${base}/forms/${env.KIT_ACTIVATE_FORM_ID}/subscribers/${extraido.id}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ referrer: "https://reativar.diar.ia.br/?via=token" }),
        signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
      });
      if (!link.ok) {
        const t = await link.text().catch(() => "<unreadable>");
        console.error(JSON.stringify({ event: "reativar_kit_token_promote_failed", status: link.status, body: t.slice(0, 300) }));
      }
      state = await readState();
    }
    if (state === "inactive") {
      // Promoção não aconteceu (form ausente, vínculo falhou, Kit mudou o
      // comportamento). Cai no DOI em vez de deixar a pessoa presa: sem isto,
      // `handleConfirm` mostraria "enviamos um e-mail de confirmação" sem
      // nenhum e-mail ter saído (achado do review da PR #8196).
      console.error(JSON.stringify({ event: "reativar_kit_token_nao_ativou_fallback_doi", state }));
      await vincularKitDoiForm({
        apiKey,
        base,
        formId: env.KIT_DOI_FORM_ID,
        subscriberId: extraido.id,
        referrer: "https://reativar.diar.ia.br/?via=token-fallback",
        fetchImpl,
        timeoutMs: ACTIVATE_FETCH_TIMEOUT_MS,
        log: (m) => console.error(JSON.stringify({ event: "reativar_kit_doi_link_failed", detail: m })),
      });
    } else if (state !== "active") {
      console.error(JSON.stringify({ event: "reativar_kit_token_nao_ativou", state }));
    }
    return { ok: true, status: 200, beehiivStatus: state };
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_kit_fetch_failed", step: "token_promote", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
}

// ── HTML (puro) ───────────────────────────────────────────────────────────

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — diar.ia.br</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center;color:#1a1a1a}
h1{font-size:1.4rem;margin-bottom:0.5rem}
p{color:#555;line-height:1.5}
a{color:#0a5}
</style></head>
<body>${body}</body></html>`;
}

/**
 * #8539 — desfecho de um clique em quem JÁ estava `active` antes do request:
 * clique repetido, ou alguém que `scripts/evaluate-brevo-diaria.ts` já havia
 * promovido por score de abertura, sem clique nenhum.
 *
 * Página própria, e NÃO o redirect de sucesso, porque a página de destino
 * mede conversão de anúncio: mandar este caso pra lá contaria uma confirmação
 * que não aconteceu neste clique. Para a pessoa o resultado é o mesmo (está
 * inscrita) e o texto diz isso sem prometer nada novo.
 */
export function renderJaConfirmadoPage(): string {
  return page(
    "Inscrição já confirmada",
    `<h1>Tudo certo por aqui</h1><p>Sua inscrição já estava confirmada — não precisa fazer mais nada. A diária continua chegando de segunda a sexta.</p><p><a href="https://diar.ia.br">Voltar pra diar.ia.br</a></p>`,
  );
}

export function renderMissingEmailPage(): string {
  return page(
    "Link inválido",
    `<h1>Link inválido</h1><p>Este link de confirmação não tem um e-mail associado. Volte no e-mail que você recebeu e clique no botão de novo.</p>`,
  );
}

export function renderInvalidEmailPage(): string {
  return page(
    "Link inválido",
    `<h1>Link inválido</h1><p>O e-mail deste link não parece válido. Volte no e-mail que você recebeu e clique no botão de novo.</p>`,
  );
}

export function renderErrorPage(): string {
  return page(
    "Algo deu errado",
    `<h1>Algo deu errado</h1><p>Não conseguimos confirmar seu cadastro agora. Tente de novo em alguns minutos, ou confirme direto em <a href="https://diar.ia.br">diar.ia.br</a>.</p>`,
  );
}

/**
 * #4476 self-review (achado do teste ao vivo): a Beehiiv pode responder 2xx
 * ao POST sem que a subscription fique `active` de fato (ex: `status:
 * "invalid"`). Página distinta de `renderErrorPage` — o clique FOI recebido
 * e processado (não é um erro de rede/config), só o resultado não é o
 * esperado; a mensagem orienta a pessoa a tentar de novo pela via genérica
 * em vez de sugerir um problema técnico do lado do site.
 */
export function renderNotConfirmedPage(): string {
  return page(
    "Ainda não confirmado",
    `<h1>Ainda não confirmado</h1><p>Recebemos seu clique, mas não conseguimos confirmar o cadastro automaticamente. Tente se cadastrar direto em <a href="https://diar.ia.br">diar.ia.br</a>.</p>`,
  );
}

/**
 * #7723 — página de "falta 1 passo", o desfecho NORMAL do clique desde que o
 * double opt-in entrou neste worker.
 *
 * Sem ela, o clique caía em `renderNotConfirmedPage` (achado do review desta
 * PR): com DOI o cadastro nasce `inactive`, e `handleConfirm` só tratava
 * `"active"` como sucesso — ou seja, TODO clique legítimo veria "não
 * conseguimos confirmar" e seria mandado se recadastrar em outro lugar, o que
 * geraria um segundo DOI pendente. O cadastro tinha funcionado; só a leitura
 * do resultado é que estava presa ao estado antigo.
 *
 * A distinção que a copy precisa carregar: não é falha nem é fim: é "chegou um
 * e-mail, clica nele". Por isso não reusa nenhuma das duas páginas existentes.
 */
export function renderConfirmacaoEnviadaPage(): string {
  return page(
    "Falta 1 passo",
    `<h1>Falta 1 passo</h1><p>Enviamos um e-mail de confirmação para você agora. Abra e clique no botão para voltar a receber a diar.ia.br.</p><p>Se não chegar em alguns minutos, confira o spam.</p>`,
  );
}

/**
 * #4538 item B — a pessoa pediu pra sair (descadastro nativo detectado via
 * `checkNativeUnsubscribePending`) e este link de confirmação NÃO reativa
 * automaticamente. Oferece o cadastro normal como opt-in explícito, em vez
 * de assumir que o clique (numa edição antiga, possivelmente esquecida na
 * caixa de entrada) ainda reflete a vontade atual da pessoa.
 */
export function renderNativeUnsubscribePage(): string {
  return page(
    "Você pediu pra sair",
    `<h1>Você pediu pra sair</h1><p>Identificamos que você se descadastrou da diária recentemente. Por isso não reativamos automaticamente por este link. Se foi engano ou você mudou de ideia, cadastre-se de novo em <a href="https://diar.ia.br">diar.ia.br</a>.</p>`,
  );
}

// ── desvincular da lista Brevo no clique (#4535) ────────────────────────

/**
 * Depois que `activateSubscription` confirma `beehiivStatus === "active"`,
 * a pessoa não precisa mais receber a diária pelo canal Brevo Pending — sem
 * este passo, ela ficava vinculada à lista 7 e recebia os dois canais até a
 * próxima varredura do `evaluate-brevo-diaria.ts` (#4534, até 1 dia depois).
 * Mesma chamada de `unlinkFromBrevoList` (`scripts/evaluate-brevo-diaria.ts`),
 * via `unlinkFromBrevoListShared` (`scripts/lib/shared/brevo-list-unlink.ts`).
 *
 * **Fail-soft obrigatório:** `BREVO_DIARIA_API_KEY`/`BREVO_DIARIA_LIST_ID`
 * ausentes, ou qualquer falha HTTP/rede da Brevo, NUNCA vira erro pro usuário
 * nem reverte a ativação Beehiiv já feita — o unlink é best-effort; a
 * varredura diária continua sendo a rede de segurança que eventualmente
 * desvincula mesmo sem esta chamada instantânea. Nunca loga o e-mail.
 */
export async function unlinkReativarFromBrevoList(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const apiKey = env.BREVO_DIARIA_API_KEY;
  const listIdRaw = env.BREVO_DIARIA_LIST_ID;
  const listId = listIdRaw !== undefined ? Number(listIdRaw) : NaN;
  if (!apiKey || !listIdRaw || Number.isNaN(listId)) {
    // Esperado/documentado (secrets novos, armamento pendente do editor) —
    // console.warn, não console.error, mesma disciplina de
    // `reativar_brevo_guard_skipped` acima.
    console.warn(
      JSON.stringify({
        event: "reativar_brevo_unlink_skipped",
        reason: "BREVO_DIARIA_API_KEY/BREVO_DIARIA_LIST_ID ausente ou inválido",
      }),
    );
    return;
  }
  const base = env.BREVO_API_URL ?? "https://api.brevo.com/v3";
  try {
    await unlinkFromBrevoListShared(apiKey, listId, email, fetchImpl, base, ACTIVATE_FETCH_TIMEOUT_MS);
  } catch (e) {
    // Falha REAL da Brevo (HTTP não-2xx ou exceção de rede) — console.error,
    // mesmo padrão de `reativar_beehiiv_non_2xx`/`reativar_fetch_failed`
    // acima. NUNCA propaga: a ativação Beehiiv já aconteceu e não é revertida.
    console.error(JSON.stringify({ event: "reativar_brevo_unlink_failed", error: String(e) }));
  }
}

// ── handler ────────────────────────────────────────────────────────────

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

/**
 * #8539 — destino do redirect de SUCESSO: a página de confirmação do apex,
 * com `?via=brevo`.
 *
 * Fonte única da URL: `PAGE_URL` de `scripts/lib/shared/confirmado-page.ts`,
 * o mesmo constante que `workers/poll/src/confirmado.ts` usa — nunca uma
 * string literal aqui, senão o rename da #8554 deixa este worker apontando
 * pro endereço velho e a confirmação passa a depender do 301.
 */
export const CONFIRMADO_REDIRECT_URL = (() => {
  // `URL`/`searchParams` e não concatenação: hoje `PAGE_URL` não tem query
  // string, mas se um dia tiver, `${...}?via=` produziria `?a=b?via=brevo`
  // em silêncio. O objeto fecha essa classe de erro de uma vez.
  const u = new URL(CONFIRMADO_PAGE_URL);
  u.searchParams.set("via", VIA_BREVO);
  return u.toString();
})();

/**
 * Redirect 303 pra página de confirmação instrumentada (#8539).
 *
 * **303 e não 302**: o método do request original é GET e o 303 diz
 * explicitamente "faça GET no destino", sem a ambiguidade histórica do 302.
 *
 * `no-store` porque a confirmação não é idempotente do ponto de vista de
 * medição: um redirect cacheado pelo navegador ou por um intermediário faria
 * o clique seguinte pular o worker inteiro — a pessoa veria a página de
 * sucesso sem que a ativação tivesse acontecido, que é exatamente o
 * fail-safe que `renderNotConfirmedPage`/`renderConfirmacaoEnviadaPage`
 * existem pra preservar.
 */
function confirmadoRedirectResponse(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...CORS_HEADERS,
      Location: CONFIRMADO_REDIRECT_URL,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export async function handleConfirm(
  url: URL,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  sleepImpl?: (ms: number) => Promise<void>,
  // #5504 hotfix: ExecutionContext OPCIONAL — habilita `ctx.waitUntil()` pro
  // disparo CAPI abaixo sem atrasar a resposta ao usuário (mesmo padrão de
  // handleJogarSubscribe/handleGateSubscribe). Sem `ctx` real (ex: teste que
  // não injeta um), cai no fallback síncrono.
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = parseEmailParam(url);
  if (!parsed.ok) {
    const html = parsed.error === "missing_email" ? renderMissingEmailPage() : renderInvalidEmailPage();
    return htmlResponse(html, 400);
  }
  // #6048: mesma seleção de backend local ao handler — env.SUBSCRIBE_BACKEND
  // não é lido por nenhum outro dispatch fora deste worker.
  const useKit = env.SUBSCRIBE_BACKEND === "kit";
  // #8194: token assinado válido = clique já vale como confirmação (só Kit).
  const tokenParam = url.searchParams.get("t");
  const confirmedByToken = useKit && (await verifyReativarToken(env.REATIVAR_SECRET, parsed.email, tokenParam));
  // Token PRESENTE mas inválido é o sinal de drift do REATIVAR_SECRET entre
  // injeção e worker (todo clique cai no DOI sem erro nenhum) — distinto de
  // `t` ausente/vazio, que é o fallback esperado de contato sem token.
  if (useKit && tokenParam && !confirmedByToken) {
    console.warn(
      JSON.stringify({ event: "reativar_token_presente_invalido", secretConfigurado: Boolean(env.REATIVAR_SECRET) }),
    );
  }
  const result = useKit
    ? await activateSubscriptionKit(env, parsed.email, fetchImpl, confirmedByToken)
    : sleepImpl
      ? await activateSubscription(env, parsed.email, fetchImpl, sleepImpl)
      : await activateSubscription(env, parsed.email, fetchImpl);
  if (!result.ok) {
    const status = result.reason === "not_configured" ? 503 : 502;
    return htmlResponse(renderErrorPage(), status);
  }
  // #4538 item B — descadastro nativo pendente: NÃO é a página de sucesso
  // nem a genérica "ainda não confirmado" (que sugere tentar de novo) —
  // página própria explicando a situação.
  if (result.reason === "native_unsubscribe_pending") {
    return htmlResponse(renderNativeUnsubscribePage(), 200);
  }
  // #4476 self-review (achado do teste ao vivo): HTTP 2xx no POST não é
  // garantia de `active` — só `beehiivStatus === "active"` conta como
  // confirmação real (mesma correção aplicada em
  // `verifyPromotedToBeehiiv`, scripts/evaluate-brevo-diaria.ts).
  // #7723 (achado do review desta PR): com o double opt-in ligado, o desfecho
  // NORMAL do clique e `inactive` — o assinante foi criado e o e-mail de
  // confirmacao saiu, falta ele clicar. Antes deste branch, esse caso caia no
  // `renderNotConfirmedPage` la embaixo: TODO clique legitimo via "nao
  // conseguimos confirmar" e era mandado se recadastrar em outro lugar, o que
  // geraria um SEGUNDO DOI pendente. O cadastro funcionava; so a leitura do
  // resultado e que continuava presa ao mundo pre-DOI.
  //
  // Nao desvincula da lista Brevo Pending aqui, de proposito: a pessoa ainda
  // nao confirmou, entao ela continua sendo Pending de fato. O unlink segue
  // amarrado ao `active` abaixo, que e quando a confirmacao existe.
  if (result.beehiivStatus === "inactive") {
    return htmlResponse(renderConfirmacaoEnviadaPage(), 200);
  }
  if (result.beehiivStatus === "active") {
    // #4535: desvincula da lista Brevo Pending SÓ quando a ativação Beehiiv
    // está de fato confirmada — best-effort, nunca bloqueia a página de
    // sucesso (ver docstring de `unlinkReativarFromBrevoList`).
    await unlinkReativarFromBrevoList(env, parsed.email, fetchImpl);
    // #8539: em vez de servir a página inline, redireciona pra página de
    // confirmação do apex — que carrega o GTM (`renderAnalyticsHead`) e por
    // isso é onde a conversão de CONFIRMAÇÃO pode ser medida. Antes disso,
    // quem confirmava por aqui era invisível pras plataformas de anúncio,
    // porque `page()` deste worker nunca carregou tag nenhuma.
    //
    // Só este ramo redireciona — ver o invariante completo na docstring de
    // `confirmadoRedirectResponse`. Todos os demais desfechos continuam com
    // página própria: `renderConfirmacaoEnviadaPage` (`inactive`, o desfecho
    // normal do DOI), `renderNotConfirmedPage` (2xx sem ativação real),
    // `renderNativeUnsubscribePage`, `renderMissingEmailPage`,
    // `renderInvalidEmailPage` e `renderErrorPage`.
    //
    // E `active` sozinho não basta: quem JÁ estava ativo antes deste request
    // (clique repetido, ou promovido por score em
    // `scripts/evaluate-brevo-diaria.ts` sem clique nenhum) não confirmou
    // nada AGORA, e mandá-lo pra página instrumentada contaria uma conversão
    // por um evento que não houve. Ver `alreadyActive` em `ActivateResult`.
    //
    // #8569: pelo mesmo motivo, o evento CAPI server-side (abaixo) só pode
    // disparar no ramo NÃO-alreadyActive — antes desta correção ele disparava
    // incondicionalmente e poluía o conjunto de anúncios com conversões que
    // não aconteceram (event_id é derivado de email+dia, não do estado da
    // assinatura, então um clique repetido em outro dia gerava evento novo).
    if (result.alreadyActive) {
      return htmlResponse(renderJaConfirmadoPage(), 200);
    }
    // #5504/hotfix pós-merge: evento pra Meta Conversions API — fire-and-
    // forget best-effort, DEPOIS da confirmação `active` NOVA (ver #8569
    // acima — nunca para quem já estava active). Fail-soft: sem
    // META_CAPI_ACCESS_TOKEN é no-op; qualquer erro nunca chega aqui (ver
    // scripts/lib/shared/meta-capi.ts). `ctx.waitUntil()` adia o envio pra
    // depois da resposta ao usuário — o `await` direto (achado do review
    // pós-merge #5504) atrasava a resposta em até
    // `META_CAPI_FETCH_TIMEOUT_MS` (8s) sempre que a Meta respondia lento.
    // #7776: log estruturado no meio do mesmo caminho fire-and-forget — ver
    // docstring de `logMetaCapiSendResult` (meta-capi.ts).
    // #8551: `eventName: "Reactivation"` — NUNCA `"CompleteRegistration"`
    // aqui. Este clique acontece meses depois do cadastro original, a
    // partir de um e-mail de reativação da Brevo, sem `fbc`/click id
    // confiável — disparar `CompleteRegistration` (o evento de OTIMIZAÇÃO
    // do conjunto "BR · conversao · sem teto") a partir daqui poluiria o
    // aprendizado do conjunto com conversões que não vieram de anúncio.
    // `workers/poll`/`workers/cursos` continuam com o default
    // `"CompleteRegistration"` — eles disparam no SUBMIT do form, o evento
    // real que o conjunto otimiza.
    const sendEvent = logMetaCapiSendResult(
      sendCompleteRegistrationEvent(
        { email: parsed.email, eventSourceUrl: url.toString(), eventName: "Reactivation" },
        { accessToken: env.META_CAPI_ACCESS_TOKEN, fetchImpl },
      ),
      "reativar",
    );
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(sendEvent);
    } else {
      await sendEvent;
    }
    // O redirect acontece DEPOIS do `unlinkReativarFromBrevoList` (await
    // acima) e DEPOIS de agendar o CAPI — o `ctx.waitUntil()` mantém o envio
    // vivo além da resposta, então redirecionar não o cancela.
    return confirmadoRedirectResponse();
  }
  return htmlResponse(renderNotConfirmedPage(), 200);
}

export default {
  // #5504 hotfix: `ctx` (ExecutionContext) OPCIONAL — 3º parâmetro padrão do
  // runtime Workers, threadeado até `handleConfirm` pra habilitar
  // `ctx.waitUntil()` no disparo CAPI sem atrasar a resposta ao usuário.
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    return handleConfirm(url, env, fetch, undefined, ctx);
  },
};
