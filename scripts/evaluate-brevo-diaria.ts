#!/usr/bin/env node
/**
 * scripts/evaluate-brevo-diaria.ts (#4266, item 4/5 do plano da issue;
 * fórmula de saída e checagem de descadastro nativo reescritas no #4476;
 * threshold de supressão corrigido pra n>=3 + janela de maturação de 48h
 * implementada no self-review pós-merge da issue #4476; piso de promoção
 * revisado de n>=2 pra n>=3 na sessão 260804 — ver
 * `scripts/lib/shared/brevo-diaria-score.ts` pro racional completo do piso.
 * Separadamente, Passo 0 corrigido no #4630 (checa Beehiiv-já-ativo E
 * `userUnsubscription` genuína antes de tratar `emailBlacklisted` como
 * descadastro nativo) e no #4633 (HTTP 404 na propagação pra Beehiiv é falha
 * PERMANENTE, não retentada pra sempre) — o racional de #4630/#4633 vive nas
 * seções `### #4630`/`### #4633` mais abaixo, NESTE arquivo, não em
 * `brevo-diaria-score.ts`)
 *
 * Avaliação periódica dos contatos `in_brevo` do canal Brevo próprio do
 * editor: recomputa a TAXA de abertura (`computeBrevoDiariaOpenRate`,
 * `scripts/lib/shared/brevo-diaria-score.ts`) e aplica a decisão do editor
 * (issue #4476, item 1 — substitui a fórmula aditiva original do #4266):
 *
 *   sends_count>=3 E openRate>51% ESTRITO (INSTANTÂNEO) → promove pra
 *                  Beehiiv (lista confirmada) — threshold revisado de
 *                  `>=50%` pra `>51%` na decisão do editor, comentário
 *                  260805b da issue #4637 (ver `brevo-diaria-score.ts`)
 *   sends_count>=3 E openRate<=20% (só envios MADUROS, >=48h — ver "Passo
 *                  2b" abaixo) → suprime (para de receber, `emailBlacklisted:
 *                  true` na Brevo — NUNCA deletado, mesma semântica de
 *                  "suprimido, marcado como tal")
 *   caso contrário (inclusive piso de amostra não atingido) → mantém, só
 *                  atualiza contadores/taxa
 *
 * ## Passo 0: descadastro NATIVO (#4476 item 7) — checado ANTES de tudo
 *
 * Antes até da auto-confirmação, cada contato `in_brevo` tem seu estado
 * Brevo atual lido (`fetchBrevoContactState`). Se `emailBlacklisted` já é
 * `true` (a pessoa clicou no link de opt-out nativo do bloco de intro — ver
 * `data/snippets/brevo-diaria-pending-intro.md`), isso é uma 3ª saída
 * TERMINAL distinta de `suppressed` (que é decisão ALGORÍTMICA por
 * engajamento baixo) — `applyNativeUnsubscribe` marca o motivo
 * separadamente (`resolution_reason: "native_unsubscribe"`) e libera o slot
 * da fila IMEDIATAMENTE, sem esperar o piso de amostra da supressão
 * algorítmica (n>=3). O MESMO `GET /contacts/{email}` que confirma
 * `emailBlacklisted` já retorna `statistics` — reusado como fonte dos
 * contadores do passo 2 (score), então isto NÃO introduz uma 2ª chamada à
 * Brevo por contato; é estritamente um passo a mais de leitura do MESMO
 * corpo de resposta, feito mais cedo no loop.
 *
 * ### Propagação pra Beehiiv (#4538) — `unsubscribe:true`, não DELETE nem PATCH status
 *
 * Até o #4538, este passo só agia do lado Brevo (unlink da lista + marca o
 * store) — o registro Pending correspondente na Beehiiv nunca era tocado,
 * ficando reativável por engano (clique tardio no CTA de uma edição antiga,
 * ou qualquer ativação em massa futura dos Pending). A moldura original da
 * issue #4538 (PATCH pra unsubscribed) estava baseada num campo que não
 * existe — investigação confirmou (doc pública da API Beehiiv,
 * https://developers.beehiiv.com/api-reference/subscriptions/delete) que o
 * campo certo é `unsubscribe: true` no MESMO endpoint `PUT
 * .../subscriptions/by_email/{email}` que `sync-apoio-nivel-beehiiv.ts` já
 * usa com sucesso pra `custom_fields` — não existe campo `status` gravável
 * nesse endpoint. A doc também desaconselha DELETE explicitamente: "We
 * recommend unsubscribing when possible instead of deleting."
 *
 * `unsubscribeInBeehiiv` (PUT) + `verifyUnsubscribedInBeehiiv` (releitura,
 * exige `status==="inactive"` explícito) seguem a MESMA disciplina de
 * escrita+releitura de `applyApoioTagEntry`/`verifyPromotedToBeehiiv` — a API
 * já provou (endpoint de `tags`) que aceita PUT com 2xx e ignora o campo em
 * silêncio. A combinação exata "`unsubscribe:true` contra um registro
 * Pending" nunca foi testada ao vivo antes desta unidade — a 1ª execução real
 * em produção (`--push`) É a validação, protegida pelo fail-safe: se a
 * releitura não confirmar `inactive`, o contato PERMANECE `in_brevo` no store
 * (nunca marcado `unsubscribed` sem confirmação) — como o descadastro NATIVO
 * já foi feito na Brevo (isso nunca é revertido, `emailBlacklisted` continua
 * `true` lá independente do que acontece aqui), a PRÓXIMA rodada detecta o
 * mesmo `emailBlacklisted:true` de novo e retenta a propagação sozinha, sem
 * precisar de nenhum estado extra persistido pra saber "isso ainda está
 * pendente" — a fonte da verdade do retry é a própria Brevo, não o store.
 *
 * ### #4630 — `emailBlacklisted` bruto NÃO é sinal suficiente de descadastro genuíno
 *
 * Achado ao vivo (260804, `marcelo.nunes@safra.com.br`): `emailBlacklisted`
 * na Brevo pode vir de `adminUnsubscription` (bounce, ação admin-side) OU
 * `userUnsubscription` (clique real no link de opt-out) — a API mistura as
 * duas causas no mesmo booleano. O bug original tratava as duas igual, E
 * nunca checava se a pessoa já estava `active` na Beehiiv (assinante
 * CONFIRMADO de verdade) antes de propagar o unsubscribe — resultado: um
 * contato já confirmado teve sua assinatura revertida por causa de um
 * `adminUnsubscription` isolado. Corrigido em 2 frentes, checadas NESTA
 * ORDEM antes de qualquer decisão:
 *
 *   1. Status Beehiiv atual (`fetchBeehiivSubscriptionStatus`, mesmo helper
 *      do Passo 1) — se já `active`, trata como auto-confirmação
 *      (`applySelfConfirmed`), independente do `emailBlacklisted` bruto.
 *      NUNCA reverte um assinante já confirmado.
 *   2. Só se não-`active`: `statistics.unsubscriptions.userUnsubscription`
 *      (não vazio) é o sinal PRIMÁRIO de descadastro genuíno — não
 *      `emailBlacklisted` sozinho. `adminUnsubscription` isolado (sem
 *      `userUnsubscription`) NÃO dispara a propagação pra Beehiiv; o
 *      contato segue pra avaliação normal (Passo 1/2).
 *
 * O status Beehiiv buscado no passo 1 desta checagem é REUSADO pelo Passo 1
 * de auto-confirmação logo abaixo quando a decisão cai pra baixo (nunca um
 * 2º GET pro mesmo contato no mesmo run).
 *
 * ### #4633 — HTTP 404 na propagação pra Beehiiv é falha PERMANENTE
 *
 * Achado ao vivo (260804, `walterhaoliveira.rj@gmail.com`): quando não
 * existe (e nunca vai existir) um registro Beehiiv pro e-mail do contato, a
 * chamada de `unsubscribeInBeehiiv` retorna HTTP 404 — diferente de uma
 * falha transitória (5xx, timeout), que se resolve numa próxima tentativa.
 * Tratar os dois casos igual (fail-safe genérico: mantém `in_brevo`, retenta
 * pra sempre) prendia o contato indefinidamente, repetindo a mesma falha
 * toda rodada sem nunca liberar o slot. `unsubscribeInBeehiiv` agora anexa
 * `.status` ao `Error` lançado; o caller distingue 404 (marca `unsubscribed`
 * direto, `resolution_reason: "native_unsubscribe_beehiiv_404"`, sem
 * confirmação — não há o que confirmar) de qualquer outro erro (mantém o
 * fail-safe original: `in_brevo`, retentado na próxima rodada).
 *
 * ## Passo 1: auto-confirmação (fecha gap registrado na própria issue #4266)
 *
 * Em seguida, cada contato `in_brevo` tem seu status Beehiiv atual
 * reconferido (`GET .../subscriptions/by_email/{email}`). Se a pessoa
 * confirmou o double opt-in por conta própria nesse meio-tempo (`status:
 * "active"`), ela é promovida por auto-confirmação (`applySelfConfirmed`),
 * independente da taxa de abertura — a issue #4266 registrou esse cenário
 * como risco de duplicidade NÃO resolvido pelo desenho original ("quem
 * confirma o opt-in depois de já ter recebido via Brevo passa a estar nas
 * duas bases"); esta rotina fecha o gap na primeira oportunidade (próxima
 * avaliação), não deixando o duplo envio se perpetuar indefinidamente.
 *
 * ## Passo 2: score (taxa de abertura + piso de amostra, 2 variantes)
 *
 * `GET /v3/contacts/{email}` da Brevo retorna `statistics.messagesSent` e
 * `statistics.opened` — arrays com 1 entrada por (campanha × evento). Um
 * mesmo contato pode ter múltiplas entradas `opened` pra UMA campanha
 * (reabriu o mesmo email); `computeCountsFromBrevoStatistics` deduplica por
 * `campaignId` — a fórmula é "quantas campanhas abriu" / "quantas recebeu",
 * não "quantos eventos de abertura", mesmo espírito de `sends_count`/
 * `opens_count` da Clarice (contagem por envio, não por evento bruto).
 *
 * ## Passo 2b: janela de maturação de 48h (issue #4476, só pra SUPRESSÃO)
 *
 * Cada entrada de `statistics.messagesSent`/`opened` carrega timestamp
 * próprio (`eventTime`/`messageSentTime`/`date`/`time` — mesmos campos que
 * `scripts/lib/brevo-stats.ts::latestEventTime` já usa pra popular
 * `last_sent_at`/`last_open_at` no store da Clarice, confirmados AO VIVO como
 * preenchidos corretamente pra `messagesSent`/`opened`, ver memória de sessão
 * 260801 "Cliques do store Clarice: não é sync defasado" — só `clicked`
 * precisou do fallback aninhado em `links[]`, adicionado no #4429).
 * `computeMatureCountsFromBrevoStatistics` reusa esse mesmo parsing
 * (`eventTimestampMs`, exportado de `brevo-stats.ts` nesta correção) pra
 * filtrar `messagesSent` a só os envios com >=48h de idade (baseado no
 * timestamp do PRÓPRIO envio, não da abertura) — `opens_count` maduro conta
 * só aberturas cujo envio correspondente já é maduro. Entrada sem timestamp
 * parseável é tratada como IMATURA (fail-safe: mais seguro excluir da conta
 * de supressão um envio de idade desconhecida do que arriscar suprimir com
 * base em dado que pode não ter tido tempo de ser aberto ainda).
 *
 * `classifyBrevoDiariaAction` (`brevo-diaria-score.ts`) recebe os DOIS
 * conjuntos de contadores (`instant` — todos os envios, avalia promoção;
 * `mature` — só >=48h, avalia supressão) e nunca mistura um no lugar do
 * outro. O `open_rate`/`opens_count`/`sends_count` REPORTADOS e persistidos
 * no store continuam sendo os INSTANTÂNEOS — a janela de maturação é
 * invisível pro que o editor vê como "taxa atual", só afeta a decisão
 * interna de supressão.
 *
 * ## Duas vias de promoção em paralelo — clique OU score (#4476 item 2)
 *
 * Esta rotina é a via de SCORE. A via de CLIQUE (link de confirmação
 * personalizado, item 3 da issue) roda por fora, num Worker (ver
 * `workers/reativar/`), e ativa a subscription Beehiiv diretamente. As duas
 * vias não colidem no caso comum: o passo 1 (auto-confirmação) acima checa
 * o status REAL da Beehiiv antes de avaliar qualquer score — se o clique já
 * promoveu a pessoa (status `active`), o passo 1 já a marca
 * `promoted_beehiiv` por auto-confirmação e o `continue` pula a avaliação de
 * score inteiramente.
 *
 * **Ressalva (#4488 review, pr-test-analyzer)**: o passo 1 só reconhece
 * `active` como confirmado — não `validating` (estado transitório de alguns
 * segundos entre DELETE+CREATE e a confirmação final, ver
 * `PROMOTION_VERIFY_RETRY_DELAY_MS`). Existe uma janela estreita (poucos
 * segundos) em que, se as duas vias avaliarem o MESMO contato nesse
 * intervalo exato, ambas poderiam disparar DELETE+CREATE concorrentemente.
 * Ambas as implementações já são auto-suficientes (buscam o id atual via
 * GET antes de decidir o que deletar, nunca confiam num id armazenado — ver
 * `promoteBeehiivSubscription`/`activateSubscription`), então o pior caso é
 * uma criação duplicada/redundante nessa janela estreita, não um crash — mas
 * não é literalmente "nunca colide". Risco aceito dado o volume baixo e a
 * janela curta; não verificado ao vivo.
 *
 * ## Promoção pra Beehiiv — DELETE + CREATE, confirmado ao vivo (260802)
 *
 * `promoteBeehiivSubscription` busca o id atual via `GET by_email`, deleta
 * a subscription Pending travada que encontrar (nunca confia num id
 * armazenado — #4488 review) e cria uma NOVA do zero — não mais
 * `POST {reactivate_existing:true}`. Teste ao vivo (260802, sessão de
 * design com o editor, autorizado explicitamente) contra um contato Pending
 * REAL (não sintético, ao contrário do teste anterior — ver histórico da
 * issue #4476): `reactivate_existing:true` **não mudou o status** (ficou
 * `pending`); deletar o registro e criar do zero **ativou direto**
 * (`validating` → `active` em segundos, sem exigir confirmação). Isso fecha
 * a lacuna que o teste anterior (2 contatos sintéticos, caíram em
 * `status:"invalid"` por domínio disposable) tinha deixado inconclusiva — a
 * hipótese central agora está confirmada, e é essa a mecânica correta.
 *
 * Se a verificação pós-escrita (`verifyPromotedToBeehiiv`, releitura de
 * `by_email`, exige `status==="active"` explícito) mostrar que não
 * confirmou, o script LOGA um warning e NÃO remove o contato da Brevo
 * (mantém `in_brevo`) — fail-safe: mais vale continuar entregando pelo canal
 * que funciona do que assumir sucesso e cortar a única entrega confirmada.
 *
 * **Vale pras duas vias (score E clique, #4476 item 2)** — o Worker
 * `workers/reativar/` (via clique) usa a mesma mecânica DELETE+CREATE.
 *
 * ## Falha por contato não aborta o run (#4398 review — silent-failure-hunter
 * + code-reviewer + pr-test-analyzer convergiram independentemente)
 *
 * Cada contato do loop principal roda dentro do seu próprio try/catch —
 * diferente de `sync-pending-to-brevo.ts` cujo padrão este módulo agora
 * espelha. Uma falha transitória de API (Brevo ou Beehiiv) num contato NUNCA
 * aborta o run inteiro: é contada em `failed`, logada, e o loop segue pro
 * próximo contato. `writeStore()` roda uma vez ao final, mas como o `store`
 * é acumulado em memória a cada sucesso e o loop nunca é abortado por uma
 * exceção não-tratada, todo progresso de contatos já processados no mesmo
 * run é persistido mesmo quando outro contato falha no meio. Falha (de
 * qualquer classe: checagem de estado Brevo, checagem de status Beehiiv,
 * promoção, supressão, ou verificação pós-escrita não confirmada) sempre
 * incrementa `failed` e o processo sai com `exit(1)` ao final — nunca
 * silenciosamente reportado como sucesso (#738). Falha no passo 0 (estado
 * Brevo) faz o contato pular pra próxima rodada inteiro (`continue` sem
 * avaliar auto-confirmação/score com dado incompleto) — mais seguro que
 * decidir com informação parcial.
 *
 * ## Reconciliação de órfãos (#4579)
 *
 * Achado da issue: `brunopierro2@gmail.com` estava vinculado à lista Brevo
 * (`listIds` incluindo o `list_id` deste canal) e recebendo envios, mas
 * **ausente de `contacts.json` inteiro** — nunca foi ingerido pelo store por
 * nenhum caminho (`sync-pending-to-brevo.ts` grava o store; um contato
 * adicionado à lista diretamente na Brevo, ou uma execução de sync
 * interrompida antes do `writeStore()`, nunca aparece aqui). Como `main()`
 * só avalia `store.contacts.filter(status === "in_brevo")`, um contato órfão
 * nunca é avaliado pra promoção/supressão e continua recebendo envios
 * indefinidamente sem que ninguém saiba que ele existe.
 *
 * `reconcileStoreWithBrevoList` fecha esse gap de OBSERVABILIDADE (não de
 * correção automática): busca `GET /contacts/lists/{id}/contacts` (Brevo,
 * fonte de verdade — mesmo endpoint/paginação de
 * `inject-poll-token-brevo.ts::iterateListContacts`) e diffa contra
 * `store.contacts` via `findOrphanContacts` (pura, testável com fixtures,
 * mesmo espírito de `checkContactCountReconciliation` em
 * `publish-daily-brevo.ts` #4532, mas do lado da avaliação/supressão, não do
 * envio — aquela função ABORTA o envio quando a enumeração diverge; esta
 * função nunca aborta nada, só REPORTA). Roda SEMPRE em `main()` — não atrás
 * de uma flag `--reconcile-only` — porque é uma leitura (nunca escreve) e
 * porque este script já roda diariamente via Task Scheduler
 * (`Diaria-Brevo-Diaria-Evaluate`, 05:30 BRT): rodar a cada invocação dá
 * observabilidade contínua de graça, sem precisar lembrar de agendar uma
 * chamada separada. Best-effort quando a chave Brevo está ausente (mesmo
 * fallback de dry-run sem key já documentado acima) e nunca aborta o run
 * principal se a chamada falhar (log de warning, segue pra avaliação normal).
 *
 * **Ação quando encontra órfãos: só loga/reporta, nunca modifica o store
 * sozinho.** A decisão de adicionar um órfão retroativamente ao store (com
 * que `sends_count`/status) versus removê-lo da lista Brevo é caso a caso —
 * o #4579 resolveu isso pro contato específico da issue (decisão do editor:
 * adicionar, é assinante ativo, sem motivo pra remover) mas essa resolução
 * não generaliza pra qualquer órfão futuro sem revisão humana.
 *
 * ## Reconciliação de seeds ausentes (#4982)
 *
 * `EDITOR_SEED_EMAILS` (`scripts/lib/editor-copy.ts`) são a sonda de
 * deliverability cross-provedor deste canal — 5 endereços, um por provedor,
 * vinculados MANUALMENTE à lista Brevo (nunca via CSV import; ver
 * `ensureEditorCopyRow` no mesmo módulo, que é o mecanismo pro fluxo Clarice,
 * não pro `brevo_diaria`). Ficarem **fora** do store por desenho é
 * INTENCIONAL — não é lacuna: são sinal técnico de onde a mensagem caiu
 * (Principal/Promoções/Spam por provedor), não assinantes reais, e
 * `findOrphanContacts` já os trata como "conhecidos" precisamente pra nunca
 * competir pelo cap de envio (`checkDailySendCap`, `publish-daily-brevo.ts`
 * #4631) nem passar pela avaliação de abertura (`runEvaluation` só itera
 * `status === "in_brevo"` do store — os seeds nunca entram ali).
 *
 * O que NÃO existia até esta issue: nenhuma checagem confirmava que os 5
 * ainda estavam de fato vinculados à lista — 2 já caíram sem detecção
 * (achado da issue). `findMissingSeedEmails` fecha esse gap simetricamente à
 * reconciliação de órfãos acima: mesmo `brevoListEmails` já buscado por
 * `fetchBrevoListEmails` (nenhuma chamada extra à Brevo), mas o diff roda no
 * sentido OPOSTO — em vez de "que e-mail da lista Brevo não está no store"
 * (órfão), pergunta "que seed esperado NÃO está na lista Brevo" (sonda
 * perdida). **Decisão do editor (briefing 260811b): alerta apenas** — mesma
 * disciplina de `reconcileStoreWithBrevoList` acima, nunca reingere o
 * contato na lista sozinho (reingestão automática exigiria uma escrita ao
 * vivo contra a Brevo fora do fluxo de CSV import já auditado; o editor
 * decide reingerir manualmente quando o alerta aparecer).
 *
 * ## Uso
 *
 *   npx tsx scripts/evaluate-brevo-diaria.ts           # dry-run (default)
 *   npx tsx scripts/evaluate-brevo-diaria.ts --push     # aplica promoções/supressões
 *
 * Como do PR #4398 (260731), `--push` ainda não foi rodado ao vivo pra vias
 * de score/supressão (guard de publicação, ver
 * `context/overnight-dispatch-rules.md` #1) — validado só via testes com
 * fetch mockado. Nota datada, não afirmação permanente: reler o histórico de
 * commits antes de assumir que isso ainda vale.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, brevoPut } from "./lib/brevo-client.ts";
import { eventTimestampMs, latestEventTime } from "./lib/brevo-stats.ts";
import {
  buildDuplicateWindowEntry,
  appendBrevoKitDuplicateWindowLog,
  type BrevoKitDuplicateWindowEntry,
} from "./lib/brevo-kit-duplicate-window.ts"; // #6705 — instrumentação/medição, não correção
import {
  computeBrevoDiariaOpenRate,
  classifyBrevoDiariaAction,
  BREVO_DIARIA_MATURATION_HOURS,
  type BrevoDiariaAction,
  type BrevoDiariaRateInput,
} from "./lib/shared/brevo-diaria-score.ts";
import {
  readStore,
  writeStore,
  applyEvaluation,
  applySelfConfirmed,
  applyNativeUnsubscribe,
  applyBrevoDiariaBounced,
  applyConvertedToKit, // #7382 — contato já ativo no Kit no momento da promoção pra Beehiiv
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { BREVO_DIARIA_PROMOCAO_SCORE_UTM } from "./lib/shared/utm-registry.ts"; // #4530
import { ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts"; // #6699 — fonte única do prefixo `kit:`
import { KIT_ORIGEM_CADASTRO_FIELD_NAME, KIT_SCORE_PROMOTION_SIGNUP_MARKER } from "./lib/shared/kit-signup-origin.ts"; // #6425 Parte B
import { buildOrigemOriginalCustomFields } from "./lib/shared/beehiiv-origem-original.ts"; // #5231
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts";
import { createOrUpdateSubscriber, getSubscriberById, getKitSubscriberByEmail } from "./lib/kit-subscribers.ts"; // #6339, #6340 item 4, #7382

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
  /** #6339 — `publishing.newsletter.backend` decide se a promoção por score
   *  escreve na Beehiiv ou no Kit (ver `promoteKitSubscription`). */
  publishing?: { newsletter?: { backend?: string } };
}

// ── contadores a partir da estatística de contato da Brevo (puro) ─────────

interface BrevoStatEvent {
  campaignId?: unknown;
}
export interface BrevoContactStatistics {
  messagesSent?: BrevoStatEvent[];
  opened?: BrevoStatEvent[];
  /** #4630 — `emailBlacklisted` sozinho mistura 2 causas bem diferentes:
   * clique real no link de opt-out (`userUnsubscription`) e qualquer ação
   * admin-side/bounce (`adminUnsubscription`). Só a 1ª é descadastro
   * GENUÍNO — a 2ª nunca deveria disparar a propagação de unsubscribe pra
   * Beehiiv (ver `hasUserUnsubscription`/Passo 0 de `runEvaluation`). */
  unsubscriptions?: {
    userUnsubscription?: unknown[];
    adminUnsubscription?: unknown[];
  };
  /** #5351 Parte B — distingue bounce de entrega genuíno (endereço
   * inválido/caixa cheia) de qualquer outra causa de `emailBlacklisted`
   * sem clique do usuário (ação admin-side/complaint na Brevo). */
  hardBounces?: BrevoStatEvent[];
}

/** Pura — `true` se existir >=1 evento de hard bounce
 * (`statistics.hardBounces`, #5351 Parte B). Campo ausente/malformado →
 * `false` (fail-safe, mesmo padrão de `hasUserUnsubscription`). */
export function hasHardBounce(statistics: BrevoContactStatistics | undefined): boolean {
  const arr = statistics?.hardBounces;
  return Array.isArray(arr) && arr.length > 0;
}

/** Pura — `true` só se existir >=1 evento de descadastro por INICIATIVA DO
 * USUÁRIO (`statistics.unsubscriptions.userUnsubscription`, não vazio).
 * `adminUnsubscription` isolado (bounce, ação admin-side na Brevo) NUNCA
 * torna isto `true` — é justamente a distinção que faltava no #4630. Campo
 * ausente/malformado → `false` (fail-safe: sem confirmação explícita de
 * clique do usuário, não assume descadastro genuíno). */
export function hasUserUnsubscription(statistics: BrevoContactStatistics | undefined): boolean {
  const arr = statistics?.unsubscriptions?.userUnsubscription;
  return Array.isArray(arr) && arr.length > 0;
}

/** Pura — dedup por campaignId (uma campanha reaberta várias vezes conta 1x). */
function uniqueCampaignIds(events: BrevoStatEvent[] | undefined): number {
  if (!Array.isArray(events)) return 0;
  const ids = new Set(events.map((e) => e.campaignId).filter((v) => v !== undefined));
  return ids.size;
}

/** Contadores INSTANTÂNEOS — todos os envios/aberturas, sem filtro de idade.
 * Único input usado pra avaliar PROMOÇÃO (ver `classifyBrevoDiariaAction`). */
export function computeCountsFromBrevoStatistics(
  statistics: BrevoContactStatistics | undefined,
): BrevoDiariaRateInput {
  return {
    sends_count: uniqueCampaignIds(statistics?.messagesSent),
    opens_count: uniqueCampaignIds(statistics?.opened),
  };
}

const MATURATION_MS = BREVO_DIARIA_MATURATION_HOURS * 60 * 60 * 1000;

/**
 * Pura — como `computeCountsFromBrevoStatistics`, mas filtra `messagesSent`/
 * `opened` a só envios MADUROS (>=48h de idade, issue #4476 "Janela de
 * maturação") — usado EXCLUSIVAMENTE pra avaliar SUPRESSÃO. A maturidade é
 * decidida pelo timestamp do PRÓPRIO envio (`eventTimestampMs` de uma
 * entrada de `messagesSent`), não da abertura: um envio de 10 dias atrás
 * continua maduro mesmo que tenha sido aberto ontem. `opens_count` maduro
 * conta só aberturas cujo `campaignId` está no conjunto de envios maduros —
 * nunca uma abertura "solta" sem o envio correspondente já confirmado maduro.
 *
 * Entrada sem timestamp parseável (`eventTimestampMs` retorna `null`) é
 * tratada como IMATURA — fail-safe: mais seguro excluir da conta de
 * supressão um envio de idade desconhecida do que arriscar contar como
 * "não abriu" um envio que pode não ter tido tempo de ser aberto ainda.
 *
 * `nowMs` injetável pra teste (default `Date.now()` — nunca real em teste,
 * #633).
 */
export function computeMatureCountsFromBrevoStatistics(
  statistics: BrevoContactStatistics | undefined,
  nowMs: number = Date.now(),
): BrevoDiariaRateInput {
  const sentEvents = Array.isArray(statistics?.messagesSent) ? statistics!.messagesSent! : [];
  const matureCampaignIds = new Set<unknown>();
  for (const e of sentEvents) {
    if (e?.campaignId === undefined) continue;
    const ts = eventTimestampMs(e);
    if (ts === null) continue; // timestamp desconhecido → imaturo, fail-safe
    if (nowMs - ts >= MATURATION_MS) matureCampaignIds.add(e.campaignId);
  }
  const openedEvents = Array.isArray(statistics?.opened) ? statistics!.opened! : [];
  const openedMatureIds = new Set<unknown>();
  for (const e of openedEvents) {
    if (e?.campaignId !== undefined && matureCampaignIds.has(e.campaignId)) {
      openedMatureIds.add(e.campaignId);
    }
  }
  return { sends_count: matureCampaignIds.size, opens_count: openedMatureIds.size };
}

/**
 * I/O — `GET /contacts/{email}` UMA vez, extrai contadores (instantâneos E
 * maduros) + `emailBlacklisted` (#4476 item 7). Fonte única pro passo 0
 * (descadastro nativo) E pro passo 2 (score) — nunca 2 GETs pro mesmo
 * contato no mesmo run.
 */
export interface BrevoContactState {
  /** Instantâneo — todos os envios, usado pra avaliar/reportar promoção. */
  sends_count: number;
  opens_count: number;
  /** Maduro (>=48h) — usado EXCLUSIVAMENTE pra avaliar supressão. */
  mature_sends_count: number;
  mature_opens_count: number;
  emailBlacklisted: boolean;
  /** #4630 — sinal PRIMÁRIO de descadastro genuíno (clique do usuário no
   * link nativo). `emailBlacklisted` sozinho não basta — ver
   * `hasUserUnsubscription`. */
  userUnsubscribed: boolean;
  /** #5351 Parte B — sinal de bounce de entrega genuíno (vs. ação
   * admin-side/complaint), usado só quando `emailBlacklisted && !userUnsubscribed`
   * pra escolher entre `resolution_reason` `"native_bounce"`/`"native_admin_block"`. */
  hardBounced: boolean;
  /** #6705 — ISO do envio Brevo mais recente (`statistics.messagesSent`,
   * `latestEventTime`), ou `null` se nunca houve envio. Usado exclusivamente
   * pela instrumentação da janela de duplicidade Kit×Brevo (ver
   * `lib/brevo-kit-duplicate-window.ts`) — nunca influencia a decisão de
   * promoção/supressão em si. */
  last_messagesSent_at: string | null;
}

export async function fetchBrevoContactState(apiKey: string, email: string): Promise<BrevoContactState> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status !== 200) {
    throw new Error(`GET /contacts/${email} falhou (HTTP ${res.status}) — não foi possível ler estado.`);
  }
  const counts = computeCountsFromBrevoStatistics(res.body?.statistics);
  const mature = computeMatureCountsFromBrevoStatistics(res.body?.statistics);
  return {
    ...counts,
    mature_sends_count: mature.sends_count,
    mature_opens_count: mature.opens_count,
    emailBlacklisted: res.body?.emailBlacklisted === true,
    userUnsubscribed: hasUserUnsubscription(res.body?.statistics),
    hardBounced: hasHardBounce(res.body?.statistics),
    last_messagesSent_at: latestEventTime(res.body?.statistics?.messagesSent),
  };
}

// ── status Beehiiv atual (auto-confirmação) ────────────────────────────────

/** I/O — status atual da subscription na Beehiiv (`null` se 404 — não encontrada). */
export async function fetchBeehiivSubscriptionStatus(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}?`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

// ── decisão pura por contato ────────────────────────────────────────────

export interface ContactEvaluation {
  email: string;
  /** Instantâneos — reportados/persistidos no store (o editor vê a taxa
   * ATUAL, não a recortada pela janela de maturação). */
  opens_count: number;
  sends_count: number;
  open_rate: number;
  action: BrevoDiariaAction;
}

export interface EvaluateContactCounts {
  /** Todos os envios, sem filtro de idade — avalia PROMOÇÃO, é o par
   * reportado/persistido. */
  instant: BrevoDiariaRateInput;
  /** Só envios com >=48h de idade — avalia SUPRESSÃO (issue #4476, "Janela
   * de maturação"). */
  mature: BrevoDiariaRateInput;
}

/** Pura — combina contadores frescos (instantâneos + maduros) + fórmula/
 * threshold num veredito só. `open_rate`/`opens_count`/`sends_count`
 * retornados são sempre os INSTANTÂNEOS — a janela de maturação afeta só a
 * decisão interna de supressão (`classifyBrevoDiariaAction`), nunca o que é
 * reportado/persistido. */
export function evaluateContact(counts: EvaluateContactCounts): Omit<ContactEvaluation, "email"> {
  const open_rate = computeBrevoDiariaOpenRate(counts.instant);
  return { ...counts.instant, open_rate, action: classifyBrevoDiariaAction(counts) };
}

// ── aplicação (I/O) ─────────────────────────────────────────────────────

/**
 * Suprime na Brevo — `emailBlacklisted: true`, NUNCA deleta (decisão do
 * editor). NÃO desvincula da lista sozinho (ver `unlinkFromBrevoList`,
 * chamada separadamente pelo caller — mesma composição do caminho de
 * promoção) — #4398 review: sem o unlink, `totalSubscribers` da lista
 * (consumido por `checkDailySendCap` em `publish-daily-brevo.ts`) infla
 * indefinidamente conforme supressões acumulam, eventualmente bloqueando
 * envios mesmo com a população `in_brevo` real bem abaixo do cap.
 */
export async function suppressInBrevo(apiKey: string, email: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, { emailBlacklisted: true });
}

/** Desvincula da lista Brevo (contato promovido/suprimido não precisa mais deste canal). */
export async function unlinkFromBrevoList(apiKey: string, listId: number, email: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, { unlinkListIds: [listId] });
}

/**
 * **#4633** — erro nominal (não um cast estrutural ad-hoc) pra carregar o
 * código HTTP de uma chamada à API da Beehiiv que falhou. Segue o precedente
 * já existente no codebase (`Brevo429Signal` em `scripts/lib/brevo-client.ts`,
 * checado via `instanceof`) em vez de `Error & { status?: number }` + 2
 * assertions estruturais não relacionadas (uma no throw, outra no catch) —
 * um rename futuro de `.status` quebraria essas assertions silenciosamente,
 * sem sinal do compilador, reintroduzindo a classe de bug do #4633
 * (type-design-analyzer, review do #4650).
 */
export class BeehiivHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BeehiivHttpError";
  }
}

/**
 * Propaga o descadastro NATIVO detectado no passo 0 pra Beehiiv (#4538) —
 * `PUT .../subscriptions/by_email/{email}` com `{unsubscribe: true}`, o campo
 * documentado pela API pública (não `status`, que não é gravável nesse
 * endpoint — ver cabeçalho do módulo pro histórico da investigação). Nunca
 * DELETE (a doc da Beehiiv desaconselha — remove o histórico do registro).
 *
 * Lança em qualquer falha HTTP — o caller (`runEvaluation`) decide o
 * fail-safe (nunca reverte o descadastro já feito na Brevo; mantém o contato
 * `in_brevo` e retenta na próxima rodada quando a propagação não é
 * confirmada, ver `verifyUnsubscribedInBeehiiv`).
 *
 * **#4633** — lança `BeehiivHttpError` (carrega `.status`, o código HTTP da
 * resposta) pra que o caller distinga 404 (PERMANENTE — nenhum registro
 * Beehiiv pra este e-mail, nunca vai confirmar) de qualquer outro erro
 * (transitório — 5xx, timeout — retenta na próxima rodada como antes). Sem
 * essa distinção, um contato sem registro Beehiiv ficava preso em `in_brevo`
 * indefinidamente, sendo reavaliado e falhando do mesmo jeito toda rodada.
 */
export async function unsubscribeInBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ unsubscribe: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BeehiivHttpError(
      `Beehiiv API PUT subscriptions/by_email/${email} (unsubscribe:true) falhou (HTTP ${res.status}): ${text}`,
      res.status,
    );
  }
}

/**
 * Releitura pós-propagação (#4538) — confirma `status === "inactive"`
 * explicitamente, nunca só o 2xx do PUT (mesma armadilha do endpoint de
 * `tags` da Beehiiv, que aceita o PUT e ignora o campo em silêncio — ver
 * `sync-apoio-nivel-beehiiv.ts`). Reusa `fetchBeehiivSubscriptionStatus`
 * (mesmo helper de `verifyPromotedToBeehiiv`/passo 1).
 *
 * Retry curto (#4545 review — silent-failure-hunter): se a releitura
 * imediata não mostrar `"inactive"`, espera `PROMOTION_VERIFY_RETRY_DELAY_MS`
 * e releê mais uma vez antes de declarar não-confirmado — mesmo racional de
 * `verifyPromotedToBeehiiv` (eventual consistency da Beehiiv, já documentada
 * no cabeçalho do módulo). Diferente de `verifyPromotedToBeehiiv`, que só
 * retenta quando o status intermediário vem nomeado como `"validating"`,
 * aqui o retry é INCONDICIONAL — esta combinação exata (`unsubscribe:true`
 * contra um registro Pending) nunca rodou ao vivo antes desta unidade, então
 * não há confirmação de que produza um status transitório nomeado
 * equivalente; mais seguro assumir que pode haver atraso e sempre dar 1
 * segunda chance antes de reportar falha.
 */
export async function verifyUnsubscribedInBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const status = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
  if (status === "inactive") return true;
  await sleepImpl(PROMOTION_VERIFY_RETRY_DELAY_MS);
  const recheck = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
  return recheck === "inactive";
}

/**
 * Promove pra Beehiiv via DELETE + CREATE — não mais `reactivate_existing`
 * (#4476, achado ao vivo 260802): testado contra um contato Pending REAL
 * (não sintético) — `POST /subscriptions {reactivate_existing:true}` NÃO
 * ativa um registro legado (status ficou `pending`, sem mudança). Deletar o
 * registro travado e criar do zero SIM ativa direto (`validating` → `active`
 * em segundos, sem exigir confirmação) — bate com a mudança de fluxo da
 * publicação (cadastro novo não exige mais double opt-in; só registros
 * legados, criados sob o fluxo antigo, ficam presos).
 *
 * #4488 review (3 agentes convergiram independentemente no mesmo achado):
 * NÃO confia mais num `subscriptionId` armazenado (`contact.beehiiv_subscription_id`,
 * capturado na ingestão) — busca o id ATUAL via `GET .../subscriptions/by_email`
 * antes de decidir o que deletar, mesmo padrão de `activateSubscription`
 * (`workers/reativar/`). Um id armazenado pode ficar obsoleto (ex: uma
 * tentativa anterior de promoção já deletou+recriou o registro mas a
 * verificação pós-escrita falhou antes do store ser atualizado — a próxima
 * tentativa reusaria um id já morto) — e um id vazio/malformado faria a URL
 * do DELETE cair no endpoint de COLEÇÃO (`/subscriptions/` sem id), que pode
 * não 404 e passar batido pela tolerância a "já sumiu". Buscar o id fresco
 * fecha as duas classes de bug de uma vez. Sem registro existente (`null`),
 * pula direto pro CREATE.
 *
 * #5231: o mesmo corpo do GET acima também alimenta
 * `buildOrigemOriginalCustomFields` (`lib/shared/beehiiv-origem-original.ts`)
 * — preserva `utm_source`/`utm_medium`/`utm_campaign`/`referring_site`/
 * `created` originais num custom field do CREATE, em vez de deixá-los serem
 * sobrescritos silenciosamente pela UTM constante de reativação abaixo.
 * Fail-soft: GET sem esses campos (ou corpo malformado) nunca bloqueia a
 * promoção, só resulta em nenhum custom field extra no CREATE.
 */
export async function promoteBeehiivSubscription(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = beehiivApiBase();
  const authHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  const getRes = await fetchImpl(`${base}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`, {
    headers: authHeaders,
  });
  let existingId: string | null = null;
  // #5231: origem original (utm_source/medium/campaign/referring_site/created)
  // lida do MESMO corpo do GET — hoje só se extraía `data.id`. `undefined`
  // (nunca lança) quando o corpo não tem `data` ou nenhum campo de origem
  // reconhecível — fail-soft, a promoção segue com a UTM constante de sempre.
  // Gated por `BEEHIIV_ORIGEM_ORIGINAL_FIELD` (ver docstring de
  // `beehiiv-origem-original.ts`): env var ausente = `undefined` sempre,
  // mesmo com origem no GET — o editor liga só depois de criar o custom
  // field na Beehiiv (#5231 item 1).
  let origemOriginalCustomFields: ReturnType<typeof buildOrigemOriginalCustomFields> = undefined;
  if (getRes.status === 404) {
    existingId = null;
  } else if (!getRes.ok) {
    throw new Error(`Beehiiv API GET /subscriptions/by_email/${email} falhou (HTTP ${getRes.status})`);
  } else {
    const body = await getRes.json().catch((e) => {
      throw new Error(`Beehiiv API GET /subscriptions/by_email/${email} corpo não-parseável: ${e}`);
    });
    existingId = (body as { data?: { id?: string } })?.data?.id || null;
    origemOriginalCustomFields = buildOrigemOriginalCustomFields(
      body as Parameters<typeof buildOrigemOriginalCustomFields>[0],
      process.env.BEEHIIV_ORIGEM_ORIGINAL_FIELD,
    );
  }

  if (existingId) {
    const delRes = await fetchImpl(`${base}/publications/${publicationId}/subscriptions/${existingId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!delRes.ok && delRes.status !== 404) {
      const text = await delRes.text().catch(() => "");
      throw new Error(`Beehiiv API DELETE /subscriptions/${existingId} falhou pra ${email} APÓS localizar o registro (HTTP ${delRes.status}): ${text}`);
    }
  }

  const res = await fetchImpl(`${base}/publications/${publicationId}/subscriptions`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      send_welcome_email: false,
      // #5095: ISENÇÃO OBRIGATÓRIA, mesmo motivo do `workers/reativar` — este
      // caminho também DELETA e recria o registro. Com double opt-in ligado na
      // publicação e sem override, a promoção por score rebaixaria o assinante
      // pra `pending` em vez de promovê-lo, sem volta programática. Agrava:
      // este script roda DESASSISTIDO todo dia às 05:30 BRT
      // (`Diaria-Brevo-Diaria-Evaluate`), então a regressão seria silenciosa e
      // diária.
      double_opt_override: "off",
      // #4530: atribuição — sem isto, todo cadastro promovido por score caía
      // como "api: direct / (none)" na Beehiiv, indistinguível de qualquer
      // outro cadastro via API.
      utm_source: BREVO_DIARIA_PROMOCAO_SCORE_UTM.source,
      utm_medium: BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium,
      utm_campaign: BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign,
      referring_site: BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
      // #5231: preserva a origem de aquisição ORIGINAL (lida do GET acima)
      // num custom field — sem isto, o DELETE+CREATE acima sobrescreve
      // utm_source/medium/campaign/referring_site com a constante fixa
      // acima, perdendo pra sempre a origem real do contato. GATED por
      // `BEEHIIV_ORIGEM_ORIGINAL_FIELD` (off por padrão) — só tem efeito
      // real (e só é enviado) depois que o editor criar o custom field
      // `origem_original` na Beehiiv (#5231 item 1) E ligar o env var; até
      // lá `origemOriginalCustomFields` é sempre `undefined`, comportamento
      // idêntico a antes desta feature.
      ...(origemOriginalCustomFields ? { custom_fields: origemOriginalCustomFields } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const deleteNote = existingId ? `APÓS deletar ${existingId}` : "sem registro anterior pra deletar";
    throw new Error(`Beehiiv API POST /subscriptions falhou pra ${email} ${deleteNote} (HTTP ${res.status}): ${text}`);
  }
}

/** Espera antes de 1 releitura, só quando o status vier `"validating"` — ver
 * `CONFIRM_RETRY_DELAY_MS` em `workers/reativar/src/index.ts` (mesmo achado
 * ao vivo 260802, duplicado aqui por serem deployables separados: este
 * script Node não importa do Worker Cloudflare). */
export const PROMOTION_VERIFY_RETRY_DELAY_MS = 2000;

/**
 * Releitura pós-promoção — `true` só se o status for `active` (direto, ou
 * após 1 retry curto quando vier `validating`, ver abaixo). Fail-safe: se
 * ainda `pending`, `invalid`, ou qualquer outro status não-`active` mesmo
 * após o retry, o caller mantém o contato `in_brevo` em vez de cortar a
 * única entrega confirmada (ver disclaimer no cabeçalho).
 *
 * Duas correções acumuladas aqui, ambas de testes ao vivo (#4476/#4488):
 * (1) a checagem original (`status !== "pending"`) tratava QUALQUER status
 * diferente de "pending" como confirmado — incluindo `"invalid"` (Beehiiv
 * pode aceitar o POST com 2xx mesmo quando a validação de e-mail/domínio
 * rejeita o contato) — corrigido pra exigir `"active"` explícito. (2) o
 * status pode vir `"validating"` (transitório — a Beehiiv processa a
 * validação de e-mail de forma assíncrona e resolve pra `active` em poucos
 * segundos, confirmado ao vivo) — sem o retry abaixo, o contato ficaria
 * preso em `in_brevo` até a PRÓXIMA rodada notar por acidente, mesmo já
 * estando `active` de fato segundos depois.
 */

export async function verifyPromotedToBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const status = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
  if (status === "active") return true;
  // #4476, achado ao vivo 260802: logo após DELETE+CREATE (promoteBeehiivSubscription),
  // a subscription pode estar "validating" (transitório, a Beehiiv processa a
  // validação de e-mail de forma assíncrona) — sem este retry, o contato ficaria
  // preso em in_brevo até a PRÓXIMA rodada de evaluate-brevo-diaria.ts notar por
  // acidente, mesmo já estando active de fato segundos depois.
  if (status === "validating") {
    await sleepImpl(PROMOTION_VERIFY_RETRY_DELAY_MS);
    const recheck = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
    return recheck === "active";
  }
  return false;
}

/**
 * promoteKitSubscription / verifyPromotedToKit (#6339)
 *
 * `promoteBeehiivSubscription`/`verifyPromotedToBeehiiv` acima escrevem e
 * verificam na Beehiiv — mecânica desenhada quando a Beehiiv era o backend
 * de ENVIO da diária. Desde o switchover do #6114
 * (`platform.config.json` → `publishing.newsletter.backend === "kit"`), a
 * Beehiiv não publica mais nada — a promoção só continuava chegando aos
 * assinantes promovidos por uma ponte de sync diária e temporária
 * (`scripts/sync-beehiiv-subscribers-kit.ts`, Beehiiv → Kit, até 24h de
 * atraso), não porque escrever na Beehiiv siga sendo o caminho certo.
 *
 * Estas duas funções são o par que escreve/verifica direto no backend que
 * de fato publica hoje (Kit) — usadas pelo `runEvaluation` quando
 * `newsletterBackend === "kit"` (que é sempre, em produção, desde o
 * #6114). Se o backend voltar a mudar (rollback do #6114, ou uma 3ª
 * plataforma no futuro), quem mexer aqui precisa revisitar qual das duas
 * funções (`*ToBeehiiv`/`*ToKit`) o `newsletterBackend` deve escolher — a
 * ramificação em si (não qual backend é o "certo") é o que sobrevive a
 * trocas futuras.
 *
 * Mecânica, mais simples que o par Beehiiv: `POST /v4/subscribers` do Kit é
 * idempotente por e-mail e `state: "active"` bypassa qualquer fluxo de
 * confirmação (achado ao vivo #6048, ver `kit-subscribers.ts`) — não existe
 * aqui o equivalente do DELETE+CREATE nem do estado transitório
 * `"validating"` da Beehiiv. Ainda assim, `verifyPromotedToKit` releê via
 * `GET /v4/subscribers/{id}` em vez de confiar no corpo da resposta do
 * POST — mesma disciplina do par Beehiiv e do restante do módulo (nunca
 * confiar só no status da mutação, ver as "armadilhas" documentadas em
 * `kit-client.ts`), mesmo que o #6048 sugira que, pra este endpoint
 * específico, a resposta do POST já seria confiável.
 */
export async function promoteKitSubscription(email: string, apiKey: string): Promise<{ id: number }> {
  // #6425 Parte B: regressão do switchover — este POST saía sem `fields`,
  // então todo cadastro promovido por score entrava no Kit sem atribuição
  // nenhuma (indistinguível de "api: direct/(none)"), igual ao par Beehiiv
  // resolvia via `BREVO_DIARIA_PROMOCAO_SCORE_UTM` (#4530). Também grava o
  // marcador `origem_cadastro` próprio (nem funil Worker, nem sync em lote
  // da Beehiiv) — ver `scripts/lib/shared/kit-signup-origin.ts`.
  const subscriber = await createOrUpdateSubscriber(
    {
      email_address: email,
      state: "active",
      fields: {
        utm_source: BREVO_DIARIA_PROMOCAO_SCORE_UTM.source,
        utm_medium: BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium,
        utm_campaign: BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign,
        referring_site: BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
        [KIT_ORIGEM_CADASTRO_FIELD_NAME]: KIT_SCORE_PROMOTION_SIGNUP_MARKER,
      },
    },
    { apiKey },
  );
  return { id: subscriber.id };
}

/** Releitura pós-promoção pro Kit — `true` só se `state === "active"`
 *  (ver docstring de `promoteKitSubscription` acima). Fail-safe: qualquer
 *  outro estado (ou erro de rede, propagado ao caller) mantém o contato
 *  `in_brevo` em vez de assumir sucesso. */
export async function verifyPromotedToKit(id: number, apiKey: string): Promise<boolean> {
  const subscriber = await getSubscriberById(id, { apiKey });
  return subscriber.state === "active";
}

/**
 * decidePromoteToBeehiivAction (#7382)
 *
 * Achado ao vivo (03/09/2026): a promoção por score pra Beehiiv escolhia o
 * destino só por `newsletterBackend`, sem NUNCA checar se a pessoa já
 * estava `active` no Kit — 4 casos confirmados de contato recebendo a
 * edição em dobro (Kit + Beehiiv), com janelas de até 14 dias entre a
 * promoção e a limpeza manual. Mesma disciplina de duas metades de
 * `decideBeehiivDeactivateAction` em `kit-ramp-cohort.ts` (tagueia de um
 * lado, decide o outro por resultado REAL, não planejado) — aqui invertida:
 * antes de ESCREVER na Beehiiv, checar se a pessoa já recebe pelo Kit.
 *
 * Pura — recebe o resultado JÁ RESOLVIDO da checagem Kit (nunca faz I/O),
 * mesmo padrão do par citado acima. Só se aplica quando `newsletterBackend
 * !== "kit"` (o caminho que ESCREVE na Beehiiv) — quando o backend é o
 * próprio Kit, a promoção já vai pro Kit, e o par oposto (Beehiiv×Kit
 * timing) é escopo do #6705/#7357, não deste guard.
 *
 * Fail-safe pro lado do NUNCA duplicar: `kitCheckAvailable: false` (sem
 * `KIT_API_KEY`, ou falha transitória de API) decide `skip_kit_check_unavailable`
 * — o caller mantém o contato `in_brevo` pra reavaliar na próxima rodada,
 * em vez de arriscar promover sem saber se já está ativo no Kit. Mesmo
 * espírito de "verificação não confirmada → mantém in_brevo" já usado no
 * restante deste módulo (`verifyPromotedToBeehiiv`/`verifySuppressedInBrevo`).
 */
export type PromoteToBeehiivAction = "promote" | "skip_active_on_kit" | "skip_kit_check_unavailable";

export function decidePromoteToBeehiivAction(input: { kitCheckAvailable: boolean; kitActive: boolean }): PromoteToBeehiivAction {
  if (!input.kitCheckAvailable) return "skip_kit_check_unavailable";
  if (input.kitActive) return "skip_active_on_kit";
  return "promote";
}

/** Prefixo sintético de `beehiiv_subscription_id` pra contato ingerido a
 *  partir do cohort `inactive` do Kit — convenção de
 *  `sync-kit-inactive-to-brevo.ts` (#6340 item 3), mesmo padrão de
 *  `curated:`/`sunset:` já usados por outros scripts de ingestão.
 *
 *  #6699 — re-exportado a partir de `ORIGIN_PREFIX.KIT`
 *  (`scripts/lib/shared/brevo-diaria-origin.ts`, o módulo canônico de
 *  parser/construtor de origem, #6678) em vez de um literal `"kit:"`
 *  independente. Antes deste fix, este arquivo, `brevo-diaria-store.ts` e o
 *  módulo canônico definiam o mesmo prefixo 3× — mudar `ORIGIN_PREFIX.KIT`
 *  não propagava pra cá nem pro store, e nenhum teste existente pegava a
 *  divergência (ver `test/brevo-diaria-origin-consumers-6699.test.ts`).
 *  Mantido como constante própria (em vez de substituir todo uso por
 *  `ORIGIN_PREFIX.KIT` inline) porque o nome `KIT_ORIGIN_ID_PREFIX` já é
 *  amplamente referenciado neste arquivo e documentado em comentários de
 *  outros módulos (`brevo-diaria-store.ts`). */
export const KIT_ORIGIN_ID_PREFIX = ORIGIN_PREFIX.KIT;

/**
 * #6340 item 4 (fix C, review pós-merge) — resultado discriminado de
 * `parseKitSubscriberId`. Antes deste fix a função retornava `number | null`,
 * onde `null` colapsava DOIS casos que o caller trata de forma diferente:
 * "não é origem Kit" (no-op, cai no caminho Beehiiv) e "é origem Kit mas o
 * id está malformado" (conta como anomalia — ver `runEvaluation`). A união
 * discriminada torna a distinção verificável pelo compilador (`switch`
 * exaustivo no call site) em vez de depender de um `.startsWith()` refeito
 * por fora, redundante com o já feito dentro da própria função.
 */
export type KitOriginParseResult =
  | { kind: "not-kit" }
  | { kind: "kit-malformed"; raw: string }
  | { kind: "kit-valid"; id: number };

/**
 * #6340 item 4 — extrai o id numérico de subscriber Kit de um
 * `beehiiv_subscription_id` no formato sintético `kit:${kit_subscriber_id}`
 * (ver `KIT_ORIGIN_ID_PREFIX`). `{kind: "not-kit"}` para qualquer coisa que
 * não comece com esse prefixo (origem Beehiiv — `sub_...`/id bruto — ou
 * qualquer outra origem sintética como `curated:`/`sunset:`); `{kind:
 * "kit-malformed", raw}` para um sufixo malformado depois do prefixo já
 * confirmado (ver validação abaixo); `{kind: "kit-valid", id}` caso
 * contrário. Parse defensivo de propósito: um `beehiiv_subscription_id`
 * corrompido nunca pode derrubar a rodada inteira de `runEvaluation` — o
 * caller trata `kit-malformed` como "não dá pra determinar o subscriber Kit
 * desta origem agora" (anomalia — conta em `failed`), nunca como "não é
 * origem Kit" (`not-kit`, no-op) — ver o `log` de warn específico pra esse
 * caso em `runEvaluation`.
 *
 * #6340 item 4 fix E (review pós-merge) — validação por regex de dígitos
 * (`^[0-9]+$`) em vez de `Number(raw)` cru: `Number()` aceita espaço em
 * branco (`Number(" 123") === 123`) e notação científica
 * (`Number("1e2") === 100`), ambos passando por `Number.isInteger` — a
 * docstring anterior prometia rejeitar "não-numérico" sem de fato rejeitar
 * esses dois casos. O prefixo (`KIT_ORIGIN_ID_PREFIX = "kit:"`) é
 * case-sensitive por `.startsWith()` — `"Kit:123"` cai em `not-kit` (não
 * `kit-malformed`), silenciosamente tratado como origem Beehiiv; isso é
 * intencional (o produtor único, `sync-kit-inactive-to-brevo.ts`, sempre
 * escreve o prefixo em minúsculas via `KIT_ORIGIN_ID_PREFIX`, ver fix D) mas
 * é uma armadilha se algum futuro produtor variar o case — coberto por
 * teste (`test/evaluate-brevo-diaria-kit-self-confirm-6340.test.ts`).
 */
const KIT_SUBSCRIBER_ID_RE = /^[0-9]+$/;

export function parseKitSubscriberId(beehiivSubscriptionId: string): KitOriginParseResult {
  if (!beehiivSubscriptionId.startsWith(KIT_ORIGIN_ID_PREFIX)) return { kind: "not-kit" };
  const raw = beehiivSubscriptionId.slice(KIT_ORIGIN_ID_PREFIX.length);
  if (!KIT_SUBSCRIBER_ID_RE.test(raw)) return { kind: "kit-malformed", raw };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { kind: "kit-malformed", raw };
  return { kind: "kit-valid", id };
}

/**
 * Releitura pós-supressão (#4398 review: `suppressInBrevo`/`unlinkFromBrevoList`
 * dependiam só do PUT não lançar, diferente de `ingestContactToBrevo`/
 * `verifyPromotedToBeehiiv`, que sempre releem antes de confiar no sucesso —
 * precedente documentado: a Beehiiv já aceitou um PATCH com 200 ignorando a
 * escrita silenciosamente, ver `sync-apoio-nivel-beehiiv.ts`). Como
 * `applyEvaluation` move o contato pra um status TERMINAL (`suppressed`) que
 * o loop nunca mais reavalia, uma falha silenciosa aqui seria permanente —
 * `true` só se `emailBlacklisted` estiver confirmado E o contato não constar
 * mais na lista (`listId`). O caller mantém o contato em `in_brevo`
 * (fail-safe, mesmo padrão de `verifyPromotedToBeehiiv`) se isto retornar
 * `false`.
 */
export async function verifySuppressedInBrevo(apiKey: string, listId: number, email: string): Promise<boolean> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status !== 200) return false;
  const blacklisted = res.body?.emailBlacklisted === true;
  const listIds: unknown = res.body?.listIds;
  const stillInList = Array.isArray(listIds) && listIds.includes(listId);
  return blacklisted && !stillInList;
}

// ── reconciliação de órfãos (#4579) ────────────────────────────────────────

interface BrevoListContactsPage {
  contacts?: Array<{ email?: string }>;
}

/**
 * I/O — todos os e-mails vinculados a uma lista Brevo, paginado
 * (`GET /contacts/lists/{listId}/contacts`, mesmo endpoint/paginação de
 * `inject-poll-token-brevo.ts::iterateListContacts` — não reusado diretamente
 * porque não é exportado de lá, e este caller só precisa do e-mail, não
 * `id`/`attributes`). Falha alto em qualquer status != 200 (mesma disciplina
 * do #4532 documentada no cabeçalho de `iterateListContacts`) — uma resposta
 * 404/403/5xx NUNCA é tratada como "lista vazia", que produziria um
 * falso-negativo silencioso ("zero órfãos") quando na verdade a chamada
 * falhou.
 */
export async function fetchBrevoListEmails(apiKey: string, listId: number): Promise<string[]> {
  const limit = 50;
  let offset = 0;
  const emails: string[] = [];
  for (;;) {
    const { status, body } = await brevoGet(apiKey, `/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`);
    if (status !== 200) {
      throw new Error(
        `GET /contacts/lists/${listId}/contacts (offset=${offset}) retornou status ${status} — abortando ` +
          "reconciliação de órfãos (#4579, nunca trata resposta não-200 como lista vazia).",
      );
    }
    const contacts = (body as BrevoListContactsPage).contacts ?? [];
    for (const c of contacts) {
      if (c.email) emails.push(c.email);
    }
    if (contacts.length < limit) break;
    offset += limit;
  }
  return emails;
}

/**
 * Pura — diff entre os e-mails vinculados à lista Brevo (fonte de verdade) e
 * o store local (`store.contacts`, QUALQUER status — um contato já
 * `promoted_beehiiv`/`suppressed`/`unsubscribed` também conta como
 * "conhecido", mesmo que o `unlinkFromBrevoList` correspondente tenha
 * falhado silenciosamente e ele ainda apareça vinculado na Brevo). Retorna
 * só os e-mails presentes na Brevo que NUNCA foram ingeridos no store — o
 * caso do #4579 (`brunopierro2@gmail.com`: vinculado à lista, recebendo
 * envios, mas ausente de `contacts.json` inteiro, então `runEvaluation`
 * nunca o avalia, já que `main()` só itera `status === "in_brevo"`).
 *
 * Mesmo espírito de `checkContactCountReconciliation`
 * (`publish-daily-brevo.ts`, #4532) — a "função irmã" citada na issue — mas
 * do lado da avaliação/supressão, não do envio: aquela função ABORTA o envio
 * quando a enumeração diverge da contagem da lista; esta função nunca aborta
 * nada, só REPORTA — a ação correta (adicionar retroativamente vs. remover
 * da lista) é decisão do editor caso a caso (#4579 item 1), não algo que
 * este guard deva resolver sozinho.
 *
 * Dedup do input pelo e-mail normalizado — a mesma pessoa não conta 2x mesmo
 * que a API devolva a mesma linha em páginas adjacentes (raro, mas o dedup é
 * gratuito e evita relatar o mesmo órfão >1x).
 *
 * `EDITOR_SEED_EMAILS` (sonda de inbox placement por provedor,
 * `platform.config.json > brevo_diaria.note`) fica deliberadamente vinculada
 * à lista 7 sem nunca ser ingerida por `sync-pending-to-brevo.ts` — sem essa
 * exclusão, o guard flagaria os mesmos 5 e-mails como órfãos TODO dia,
 * diluindo o sinal de alerta pra quando um órfão de verdade aparecer (achado
 * do self-review, #4579).
 */
export function findOrphanContacts(
  brevoListEmails: string[],
  store: BrevoDiariaStore,
  expectedNonStoreEmails: readonly string[] = EDITOR_SEED_EMAILS,
): string[] {
  const known = new Set([...store.contacts.map((c) => c.email), ...expectedNonStoreEmails.map((e) => normalizeEmail(e))]);
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const raw of brevoListEmails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (!known.has(email)) orphans.push(email);
  }
  return orphans;
}

/**
 * Pura — diff no sentido OPOSTO de `findOrphanContacts` (#4982): em vez de
 * achar e-mails na lista Brevo ausentes do store, acha `seedEmails`
 * (default `EDITOR_SEED_EMAILS`) ausentes da lista Brevo — a sonda de
 * deliverability caiu da lista sem que ninguém percebesse (achado da issue:
 * 2 dos 5 já sumiram silenciosamente). Normaliza (case/trim) antes de
 * comparar, mesmo critério de `findOrphanContacts`/`normalizeEmail`. Ordem
 * do retorno segue a ordem de `seedEmails`, não a da lista Brevo.
 */
export function findMissingSeedEmails(
  brevoListEmails: string[],
  seedEmails: readonly string[] = EDITOR_SEED_EMAILS,
): string[] {
  const present = new Set(brevoListEmails.map((e) => normalizeEmail(e)).filter(Boolean));
  const missing: string[] = [];
  for (const raw of seedEmails) {
    const email = normalizeEmail(raw);
    if (email && !present.has(email)) missing.push(email);
  }
  return missing;
}

export interface OrphanReconciliationSummary {
  brevoListCount: number;
  orphanEmails: string[];
  /** #4982 — `EDITOR_SEED_EMAILS` esperados na lista Brevo mas ausentes (sonda caiu). */
  missingSeedEmails: string[];
}

/**
 * I/O — orquestra a reconciliação de órfãos (#4579): busca a lista Brevo
 * inteira (`fetchBrevoListEmails`), calcula o diff puro (`findOrphanContacts`)
 * contra o store dado, e LOGA o resultado através do `log` injetado (mesmo
 * padrão de logging estruturado do resto do arquivo) — NUNCA escreve no
 * store; a persistência de uma correção (adicionar/remover) é sempre ação
 * manual separada do editor. Chamada por `main()` ANTES da avaliação normal,
 * best-effort (ver `main()` — se a chave Brevo estiver ausente, o caller
 * pula esta chamada inteiramente; se a chamada lançar, o caller loga um
 * warning e segue pra avaliação normal sem abortar o run).
 */
export async function reconcileStoreWithBrevoList(params: {
  brevoApiKey: string;
  listId: number;
  store: BrevoDiariaStore;
  log: (msg: string) => void;
}): Promise<OrphanReconciliationSummary> {
  const { brevoApiKey, listId, store, log } = params;
  const brevoListEmails = await fetchBrevoListEmails(brevoApiKey, listId);
  const orphanEmails = findOrphanContacts(brevoListEmails, store);
  if (orphanEmails.length > 0) {
    log(
      `ALERTA reconciliação (#4579): ${orphanEmails.length} contato(s) vinculado(s) à lista Brevo ${listId} ` +
        `MAS AUSENTE(S) do store local (${store.contacts.length} contato(s) rastreado(s) no total) — nunca ` +
        `avaliado(s) pra promoção/supressão: ${orphanEmails.join(", ")}. Store NÃO modificado automaticamente — ` +
        "decisão de adicionar retroativamente (ou remover da lista) é do editor, caso a caso (#4579 item 1).",
    );
  } else {
    log(
      `reconciliação (#4579): ${brevoListEmails.length} contato(s) na lista Brevo ${listId}, nenhum órfão — store consistente.`,
    );
  }

  // #4982 — sentido OPOSTO: EDITOR_SEED_EMAILS esperados na lista Brevo mas
  // ausentes (a sonda de deliverability caiu sem detecção, já aconteceu com
  // 2 dos 5). Alerta apenas — nunca reingere sozinho (decisão do editor, ver
  // docstring do módulo).
  const missingSeedEmails = findMissingSeedEmails(brevoListEmails);
  if (missingSeedEmails.length > 0) {
    log(
      `ALERTA reconciliação (#4982): ${missingSeedEmails.length} EDITOR_SEED_EMAILS ausente(s) da lista Brevo ` +
        `${listId} — sonda de deliverability cross-provedor comprometida: ${missingSeedEmails.join(", ")}. ` +
        "Readicionar manualmente na lista Brevo (os seeds ficam fora do store/CSV import por desenho, #4982) " +
        "— este guard só alerta, nunca reingere sozinho.",
    );
  } else {
    log(`reconciliação de seeds (#4982): ${EDITOR_SEED_EMAILS.length} EDITOR_SEED_EMAILS presentes na lista Brevo ${listId}.`);
  }

  return { brevoListCount: brevoListEmails.length, orphanEmails, missingSeedEmails };
}

// ── orquestração testável (#4398 review — pr-test-analyzer: main() precisa
// de uma função extraída pra ser testável sem mockar env/platform.config.json
// inteiros) ─────────────────────────────────────────────────────────────

export interface RunEvaluationParams {
  contacts: BrevoDiariaContact[];
  store: BrevoDiariaStore;
  push: boolean;
  publicationId: string;
  beehiivApiKey: string;
  /** Só obrigatória quando `push=true` (mesmo contrato do main() original). */
  brevoApiKey?: string;
  listId: number;
  log: (msg: string) => void;
  /**
   * Backend real de ENVIO da diária (#6339, ver `promoteKitSubscription`) —
   * decide se a promoção por SCORE escreve na Beehiiv ou no Kit. **Não**
   * decide a auto-confirmação (Passo 1, `applySelfConfirmed`) — esse
   * caminho é roteado pela ORIGEM do contato (#6340 item 4,
   * `parseKitSubscriberId`), não por este parâmetro: contato de origem Kit
   * (`beehiiv_subscription_id` prefixado `kit:...`) SEMPRE confirma no Kit,
   * contato de origem Beehiiv continua escrevendo só na Beehiiv — ver o
   * comentário `#6339, ESCOPO NÃO COBERTO` logo acima dele, que descreve um
   * gap DIFERENTE (Beehiiv→Kit, ainda não fechado) e não muda com este
   * parâmetro nem com o #6340 item 4. Default `"beehiiv"` preserva o
   * comportamento de todo chamador que não passa este campo (inclusive a
   * suíte de testes pré-#6339) — `main()` sempre passa o valor lido de
   * `platform.config.json` → `publishing.newsletter.backend`, que em
   * produção é `"kit"` desde o switchover do #6114.
   */
  newsletterBackend?: "beehiiv" | "kit";
  /**
   * Obrigatória quando `newsletterBackend === "kit"` E `push === true`
   * (promoção por score, #6339). Desde #6340 item 4, também consultada
   * (sempre, independente de `push`/`newsletterBackend`) pelo Passo 0
   * (descadastro nativo de contato de origem Kit — fix B) e pela
   * auto-confirmação de contatos de origem Kit (Passo 1) — mas
   * `runEvaluation` em si NUNCA lança na ausência: degrada pra "ainda não
   * decidido nesta rodada" com log de warn e incrementa `kitAutoConfirmSkipped`
   * (ver `RunEvaluationResult`), porque um contato de origem Kit pode existir
   * no store mesmo quando `newsletterBackend === "beehiiv"` (rollback) ou em
   * dry-run local sem `KIT_API_KEY` configurada — nenhum desses cenários
   * pode abortar a rodada inteira DENTRO de `runEvaluation`.
   *
   * **Correção (fix A, review pós-merge do #6340 item 4) — a analogia com
   * `brevoApiKey` do Passo 0 que este comentário fazia antes era enganosa e
   * levou a uma lacuna real.** `brevoApiKey` ausente em `push` SEMPRE aborta
   * em `main()` ANTES de avaliar qualquer contato (precondição dura, ver o
   * `process.exit(2)` logo no início de `main()`) — não existe caminho onde
   * `runEvaluation` roda sem ela em `push`. `kitApiKey`, antes deste fix, só
   * era exigida por `main()` quando `newsletterBackend === "kit"` — mas o
   * roteamento por ORIGEM do Passo 0/1 é INDEPENDENTE de
   * `newsletterBackend`: com `newsletterBackend === "beehiiv"` (rollback) e
   * `push: true`, o script rodava sem `KIT_API_KEY`, e todo contato `kit:`
   * caía no ramo `!kitApiKey` — que incrementava zero contadores e reportava
   * `exitCode` 0, deixando o contato preso `in_brevo` indefinidamente sem
   * sinal em cron algum (o próprio envio duplicado Kit+Brevo que o item 4
   * existe pra impedir). `main()` agora exige `KIT_API_KEY` sempre que há
   * ≥1 contato de origem Kit no conjunto avaliado, não só quando
   * `newsletterBackend === "kit"` — a condição correta é "existe trabalho
   * que depende da key", não "o backend atual é kit".
   */
  kitApiKey?: string;
  /**
   * #6705 — instrumentação (medição, NUNCA correção) da janela de
   * duplicidade Kit×Brevo: chamada toda vez que este `runEvaluation`
   * detecta, em `push`, um contato já `active` no Kit — a saída REAL da
   * fila (não a confirmação em si, que este processo não observa
   * diretamente). Opcional e OMITIDA por padrão: sem isto, nenhuma linha é
   * gravada (nenhum efeito colateral em disco além dos já existentes) —
   * mantém a suíte de testes livre de I/O de arquivo. `main()` injeta a
   * implementação de produção (`appendBrevoKitDuplicateWindowLog`,
   * `lib/brevo-kit-duplicate-window.ts`).
   */
  appendDuplicateWindowLog?: (entry: BrevoKitDuplicateWindowEntry) => void;
}

/**
 * Contadores desta rodada — NÃO são uma partição exaustiva/mutuamente
 * exclusiva do total de contatos processados, apesar do que os nomes
 * sugerem (achado opcional #4476, type-design-analyzer): um mesmo contato
 * pode incrementar `promoted`/`suppressed` E `failed` no mesmo run (ex: a
 * avaliação decide `promote_to_beehiiv`, incrementa `promoted`, mas a
 * verificação pós-escrita falha — incrementa `failed` TAMBÉM e reverte pra
 * `keep` no store; ver o teste "push: suppress cuja releitura NÃO confirma"
 * em `test/evaluate-brevo-diaria-4266.test.ts`, que confirma
 * `suppressed===1` E `failed===1` no MESMO resultado). Somar todos os campos
 * não bate com `contacts.length`.
 */
export interface RunEvaluationResult {
  store: BrevoDiariaStore;
  /** #4476 item 7 — descadastro nativo detectado (saída terminal distinta de `suppressed`). */
  unsubscribedNative: number;
  /**
   * #4633, subconjunto de `unsubscribedNative` (silent-failure-hunter, review
   * do #4650) — quantos desses descadastros nativos foram resolvidos via 404
   * PERMANENTE da Beehiiv (`resolution_reason: "native_unsubscribe_beehiiv_404"`)
   * em vez da confirmação normal (`verifyUnsubscribedInBeehiiv` mostrando
   * `"inactive"`). Sem este campo separado, os dois caminhos incrementam o
   * mesmo `unsubscribedNative` e a distinção só sobrevive per-contato em
   * `resolution_reason` — fácil de perder entre muitos contatos, minando o
   * próprio objetivo de auditabilidade que o #4633 promete.
   */
  unsubscribedNativeBeehiivNotFound: number;
  /** #5351 Parte B — `emailBlacklisted` sem `userUnsubscription` (bounce ou
   * ação admin-side), 4ª saída terminal puramente local (nunca escreve na
   * Beehiiv). */
  bouncedNative: number;
  selfConfirmed: number;
  promoted: number;
  suppressed: number;
  kept: number;
  /**
   * Conta QUALQUER anomalia por contato: falha transitória de API (checagem
   * de estado Brevo, checagem de status Beehiiv, checagem de status Kit —
   * #6340 item 4 — id malformado incluso, promoção, supressão) OU
   * verificação pós-escrita que não confirma (mantido em `in_brevo` por
   * fail-safe). Nunca um não-evento silencioso (#738) — o caller (main())
   * usa isto pra decidir o exit code. **Exceção deliberada**: `kitApiKey`
   * ausente pra um contato de origem Kit NUNCA conta aqui — ver
   * `kitAutoConfirmSkipped` abaixo, que é o contador dedicado desse caso
   * (fix A, review pós-merge do #6340 item 4).
   */
  failed: number;
  /**
   * #6340 item 4 fix A (review pós-merge) — quantos contatos de origem Kit
   * NÃO puderam ter a auto-confirmação decidida nesta rodada por
   * `kitApiKey` ausente (Passo 0 e Passo 1). Contador SEPARADO de `failed`
   * de propósito: isto não é uma falha transitória de API nem um dado
   * corrompido — é uma precondição de ambiente ausente (mesmo espírito da
   * exceção documentada em `failed` acima), mas ainda assim PRECISA ser
   * visível pro caller: antes deste fix, `kitApiKey` ausente em `push:true`
   * com `newsletterBackend==="beehiiv"` (rollback) fazia TODO contato `kit:`
   * cair neste ramo silenciosamente — `exitCode` 0, nenhum contador
   * incrementado, contato preso `in_brevo` indefinidamente sem que nenhum
   * monitor de cron percebesse (exatamente o envio duplicado Kit+Brevo que o
   * item 4 existe pra impedir). `main()` agora (a) exige `KIT_API_KEY`
   * sempre que há ≥1 contato de origem Kit no conjunto avaliado, e (b) trata
   * `kitAutoConfirmSkipped > 0` como saída não-zero (mesmo caminho de
   * `failed > 0`) pro caso em que a rodada roda mesmo assim (dry-run, ou uma
   * 2ª rodada concorrente sem a env var) — "algo não pôde ser confirmado"
   * precisa aparecer em cron, não só "algo falhou".
   */
  kitAutoConfirmSkipped: number;
  /**
   * #7382 — quantos contatos seriam promovidos pra Beehiiv (threshold de
   * score) mas já estavam `active` no Kit no momento da checagem: a
   * promoção pra Beehiiv foi PULADA (nunca duplicada) e o contato saiu da
   * fila Brevo marcado `converted_to_kit` (mesmo status/semântica do guard
   * pré-dispatch #6485 — "o Kit já assumiu o envio pra esse e-mail").
   */
  skippedActiveOnKit: number;
}

/**
 * Roda a avaliação sobre a lista de contatos `in_brevo` já dada (sem I/O de
 * env/config/disco — isso é responsabilidade do `main()`). Falha por contato
 * NUNCA aborta a função inteira: cada contato roda no próprio try/catch,
 * contado em `failed` e logado, seguindo pro próximo — mesmo padrão de
 * `sync-pending-to-brevo.ts`. O `store` retornado acumula todo progresso dos
 * contatos processados com sucesso, mesmo quando outro contato no meio falha.
 */
export async function runEvaluation(params: RunEvaluationParams): Promise<RunEvaluationResult> {
  const {
    contacts,
    push,
    publicationId,
    beehiivApiKey,
    brevoApiKey,
    listId,
    log,
    newsletterBackend = "beehiiv",
    kitApiKey,
    appendDuplicateWindowLog,
  } = params;
  let store = params.store;

  let unsubscribedNative = 0;
  let unsubscribedNativeBeehiivNotFound = 0;
  let bouncedNative = 0;
  let selfConfirmed = 0;
  let promoted = 0;
  let suppressed = 0;
  let kept = 0;
  let failed = 0;
  let kitAutoConfirmSkipped = 0;
  let skippedActiveOnKit = 0; // #7382

  for (const contact of contacts) {
    try {
      // #6340 item 4 fix B/C — origem do contato, determinada UMA vez no
      // topo da iteração (não só no Passo 1 como antes do fix), e reusada
      // pelos Passos 0 E 1 — decide se a checagem "já confirmado?" embutida
      // em cada passo consulta a Beehiiv ou o Kit. `kitParseResult.kind !==
      // "not-kit"` substitui o `.startsWith(KIT_ORIGIN_ID_PREFIX)` redundante
      // que existia antes deste fix (fix C — união discriminada elimina a
      // dupla checagem do mesmo prefixo por 2 caminhos diferentes).
      const kitParseResult = parseKitSubscriberId(contact.beehiiv_subscription_id);
      const isKitOrigin = kitParseResult.kind !== "not-kit";
      // Cache do status Kit — mesmo papel de `beehiivStatus` abaixo, pro
      // lado Kit: `undefined` = ainda não checado nesta iteração; setado
      // pelo Passo 0 (quando `emailBlacklisted`) e reusado pelo Passo 1 —
      // nunca 2 GETs ao Kit no mesmo run pro mesmo contato.
      let kitConfirmed: boolean | undefined;
      // #6705 — `created_at` do subscriber Kit, capturado sempre que um GET
      // ao Kit roda nesta iteração (Passo 0 ou Passo 1 abaixo), reusado pela
      // instrumentação da janela de duplicidade quando `kitConfirmed` vira
      // `true`. Melhor proxy disponível pro momento de entrada no funil Kit
      // — NÃO é o instante da confirmação do double opt-in (ver docstring de
      // `lib/brevo-kit-duplicate-window.ts`).
      let kitSubscriberCreatedAt: string | null = null;

      // 0) descadastro NATIVO (#4476 item 7) — checado ANTES de qualquer
      // outra avaliação. Requer brevoApiKey (ausente em dry-run sem o env
      // configurado) — best-effort: sem a key, este passo é pulado (dry-run
      // ainda funciona pra preview do resto via contadores já no store).
      let nativeState: BrevoContactState | undefined;
      // #4630 — status Beehiiv, checado ANTES de decidir se um
      // `emailBlacklisted` na Brevo é descadastro genuíno; reusado no passo
      // 1 (auto-confirmação) quando a decisão do passo 0 cai pra baixo —
      // nunca um 2º GET pro mesmo contato no mesmo run. `undefined` = ainda
      // não buscado nesta iteração. Só se aplica a contato de origem
      // Beehiiv — ver `isKitOrigin` acima (#6340 item 4 fix B).
      let beehiivStatus: string | null | undefined;
      let statusCheckFailed = false;
      if (brevoApiKey) {
        try {
          nativeState = await fetchBrevoContactState(brevoApiKey, contact.email);
        } catch (e) {
          log(`warn: falha ao checar estado Brevo de ${contact.email}: ${(e as Error).message}`);
          failed++;
          // Sem estado confiável — não decide com dado incompleto, tenta de
          // novo na próxima rodada. Não passa pra auto-confirmação/score.
          continue;
        }
        if (nativeState.emailBlacklisted && isKitOrigin) {
          // #6340 item 4 fix B — contato de origem Kit NUNCA consulta nem
          // escreve na Beehiiv, nem aqui nem em nenhum outro ramo deste
          // bloco: a checagem "já confirmado?" que decide se um
          // `emailBlacklisted` é descadastro genuíno consulta o KIT em vez
          // da Beehiiv (mesmo racional do #4630 — nunca reverter um contato
          // já confirmado — só que pro backend certo desta origem).
          // `kitConfirmed` fica cacheado e é reusado pelo Passo 1 abaixo —
          // nunca 2 GETs ao Kit no mesmo run pro mesmo contato. `switch`
          // exaustivo sobre `"kit-malformed" | "kit-valid"` — o TS já prova
          // `"not-kit"` inalcançável aqui via narrowing de `isKitOrigin`
          // (`kitParseResult.kind !== "not-kit"`), então nem compila um
          // `case "not-kit"` (fix C).
          switch (kitParseResult.kind) {
            case "kit-malformed":
              log(
                `warn: ${contact.email} tem beehiiv_subscription_id de origem Kit malformado ` +
                  `("${contact.beehiiv_subscription_id}") — não é possível decidir o Passo 0 (#6340 item 4 fix B).`,
              );
              failed++;
              continue;
            case "kit-valid":
              if (!kitApiKey) {
                log(
                  `${contact.email}: emailBlacklisted na Brevo, origem Kit, mas kitApiKey ausente — não dá pra ` +
                    "decidir se é descadastro genuíno ou ruído admin/bounce nesta rodada (#6340 item 4 fix B).",
                );
                kitAutoConfirmSkipped++;
                continue;
              }
              try {
                const kitSubscriber = await getSubscriberById(kitParseResult.id, { apiKey: kitApiKey });
                kitConfirmed = kitSubscriber.state === "active";
                kitSubscriberCreatedAt = kitSubscriber.created_at ?? null; // #6705
              } catch (e) {
                log(`warn: falha ao checar status Kit de ${contact.email} no Passo 0 (#6340 item 4 fix B): ${(e as Error).message}`);
                failed++;
                continue;
              }
              break;
          }

          if (kitConfirmed !== true) {
            if (nativeState.userUnsubscribed) {
              log(
                `${contact.email}: já descadastrado (emailBlacklisted + userUnsubscription confirmado) na Brevo, ` +
                  "origem Kit → saída nativa LOCAL, libera slot imediatamente (#6340 item 4 fix B — nunca propagado " +
                  "pra Beehiiv: não existe registro lá pra este e-mail; nunca propagado pro Kit: o contato já veio " +
                  "do cohort inactive de lá, sem assinatura ativa pra desativar).",
              );
              unsubscribedNative++;
              if (push) {
                await unlinkFromBrevoList(brevoApiKey, listId, contact.email);
                store = applyNativeUnsubscribe(store, contact.email, new Date().toISOString(), "native_unsubscribe_kit_origin");
              }
              continue;
            }
            // emailBlacklisted true mas nem já-ativo no Kit nem
            // userUnsubscription genuíno — ruído de adminUnsubscription/
            // bounce isolado, mesmo racional do caminho Beehiiv abaixo (mas
            // este ramo JÁ é 100% local — nunca chamou Beehiiv nem Kit pra
            // escrever, só leu o Kit pra decidir).
            const bounceReason = nativeState.hardBounced ? "native_bounce" : "native_admin_block";
            log(
              `${contact.email}: emailBlacklisted na Brevo sem userUnsubscription (${bounceReason}), origem Kit → ` +
                "marcado bounced localmente (zero chamada Beehiiv/Kit), libera slot.",
            );
            bouncedNative++;
            if (push) {
              await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
              store = applyBrevoDiariaBounced(store, contact.email, bounceReason);
            }
            continue;
          }
          // kitConfirmed === true cai direto pro bloco compartilhado de
          // auto-confirmação (Passo 1) abaixo — nunca reverte um contato já
          // ativo no Kit.
        } else if (nativeState.emailBlacklisted) {
          // #4630: `emailBlacklisted` sozinho mistura clique real de opt-out
          // (`userUnsubscription`) com qualquer ação admin-side/bounce
          // (`adminUnsubscription`) — e o bug original era nunca checar se a
          // pessoa já era assinante CONFIRMADO na Beehiiv antes de reverter.
          // Corrigido: busca o status Beehiiv primeiro; se já `active`, cai
          // no bloco compartilhado de auto-confirmação abaixo (nunca reverte
          // um assinante real) — só senão é que se decide entre descadastro
          // genuíno (`userUnsubscribed`) e ruído admin/bounce. Só se aplica a
          // contato de origem Beehiiv (`!isKitOrigin` — ver o `if` gêmeo
          // acima, #6340 item 4 fix B).
          beehiivStatus = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email).catch((e) => {
            log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
            statusCheckFailed = true;
            return undefined;
          });
          if (statusCheckFailed) {
            failed++;
            // Sem status Beehiiv confiável — não decide com dado incompleto
            // (mesmo racional do catch acima), tenta de novo na próxima rodada.
            continue;
          }

          if (beehiivStatus !== "active") {
            if (nativeState.userUnsubscribed) {
              log(
                `${contact.email}: já descadastrado (emailBlacklisted + userUnsubscription confirmado) na Brevo → ` +
                  "saída nativa, libera slot imediatamente.",
              );
              unsubscribedNative++;
              if (push) {
                // #4538: propaga o descadastro pra Beehiiv ANTES de tocar no
                // store/lista Brevo — write+reread, mesma disciplina de
                // `applyApoioTagEntry`. Fail-safe (exceto #4633, ver abaixo):
                // se a Beehiiv não confirmar `inactive`, o contato PERMANECE
                // `in_brevo` (nunca marcado `unsubscribed` sem confirmação) —
                // o descadastro NATIVO já feito na Brevo nunca é revertido
                // (não tocamos `emailBlacklisted` aqui, só lemos), então a
                // PRÓXIMA rodada detecta o mesmo `emailBlacklisted:true` de
                // novo e retenta sozinha, sem precisar de estado extra
                // persistido.
                let beehiivConfirmed = false;
                let permanentNotFound = false;
                try {
                  await unsubscribeInBeehiiv(publicationId, beehiivApiKey, contact.email);
                  beehiivConfirmed = await verifyUnsubscribedInBeehiiv(publicationId, beehiivApiKey, contact.email);
                } catch (e) {
                  if (e instanceof BeehiivHttpError && e.status === 404) {
                    // #4633: 404 é PERMANENTE — não existe (e nunca vai
                    // existir) registro Beehiiv pra este e-mail, então não há
                    // o que confirmar; retentar toda rodada só repetiria a
                    // mesma falha pra sempre. Marca `unsubscribed` direto,
                    // registrando a divergência em `resolution_reason` pra
                    // auditoria.
                    permanentNotFound = true;
                    log(
                      `${contact.email}: propagação do descadastro pra Beehiiv retornou 404 (sem registro Beehiiv ` +
                        "pra este e-mail) — falha PERMANENTE (#4633), marcando unsubscribed sem confirmação (nada a confirmar).",
                    );
                  } else {
                    log(`warn: falha ao propagar descadastro nativo de ${contact.email} pra Beehiiv: ${(e as Error).message}`);
                  }
                }
                if (permanentNotFound) {
                  await unlinkFromBrevoList(brevoApiKey, listId, contact.email);
                  store = applyNativeUnsubscribe(store, contact.email, new Date().toISOString(), "native_unsubscribe_beehiiv_404");
                  unsubscribedNativeBeehiivNotFound++;
                  continue;
                }
                if (!beehiivConfirmed) {
                  failed++;
                  log(
                    `warn: ${contact.email} — propagação do descadastro pra Beehiiv NÃO confirmada (releitura não ` +
                      `mostrou "inactive") — mantendo in_brevo no store (fail-safe: o descadastro já feito na Brevo ` +
                      "nunca é revertido; retentado na próxima rodada).",
                  );
                  continue;
                }
                await unlinkFromBrevoList(brevoApiKey, listId, contact.email);
                store = applyNativeUnsubscribe(store, contact.email);
              }
              continue;
            }
            // emailBlacklisted true mas nem já-ativo na Beehiiv nem
            // userUnsubscription genuíno (#4630) — ruído de
            // adminUnsubscription/bounce isolado. Não propaga pra Beehiiv
            // (decisão do editor, #5351 Parte B) — sem clique do usuário
            // este contato nunca recebe outra campanha, então a avaliação
            // normal (que depende de `sends_count` crescer) nunca concluiria
            // nada pra ele. Saída terminal LOCAL dedicada em vez de "segue
            // avaliação normal" (comportamento antigo, #4630) — o contato
            // ficava preso `in_brevo` pra sempre.
            const bounceReason = nativeState.hardBounced ? "native_bounce" : "native_admin_block";
            log(
              `${contact.email}: emailBlacklisted na Brevo sem userUnsubscription (${bounceReason}) → NÃO ` +
                "propagado pra Beehiiv (#5351, decisão do editor), marcado bounced localmente, libera slot.",
            );
            bouncedNative++;
            if (push) {
              await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
              store = applyBrevoDiariaBounced(store, contact.email, bounceReason);
            }
            continue;
          }
          // beehiivStatus === "active" cai direto pro bloco compartilhado de
          // auto-confirmação (passo 1) abaixo — nunca reverte um assinante já
          // confirmado, independente do emailBlacklisted (#4630).
        }
      }

      // 1) auto-confirmação — sempre checada, independente da taxa de
      // abertura. Roteada pela ORIGEM do contato (#6340 item 4): contato de
      // origem Kit (`beehiiv_subscription_id` prefixado `kit:...`, ver
      // `sync-kit-inactive-to-brevo.ts` #6340 item 3) confirma no KIT, não
      // na Beehiiv — o gap original (checar Beehiiv pra um contato que só
      // existe no Kit nunca resolve "active", deixando-o preso na fila do
      // Brevo mesmo depois de confirmar o double opt-in) é exatamente o
      // que este roteamento fecha. Os dois caminhos são MUTUAMENTE
      // EXCLUSIVOS por contato — nunca os dois GETs (Kit E Beehiiv) no
      // mesmo run pro mesmo contato. `isKitOrigin`/`kitParseResult` já
      // computados no topo da iteração (#6340 item 4 fix B) — reusados aqui,
      // não recalculados.
      if (isKitOrigin) {
        // Reusa `kitConfirmed` se o Passo 0 já buscou (contato
        // `emailBlacklisted`, origem Kit) — nunca um 2º GET ao Kit no mesmo
        // run pro mesmo contato.
        if (kitConfirmed === undefined) {
          // `switch` exaustivo sobre `"kit-malformed" | "kit-valid"` — o TS
          // prova `"not-kit"` inalcançável aqui via narrowing de
          // `isKitOrigin` (mesmo racional do Passo 0, fix C).
          switch (kitParseResult.kind) {
            case "kit-malformed":
              // Dado corrompido, não "não é Kit": conta como anomalia (mesmo
              // espírito de `statusCheckFailed` no caminho Beehiiv), nunca
              // lança, e o contato segue pra avaliação normal (Passo 2) como
              // qualquer outro não confirmado nesta rodada.
              log(
                `warn: ${contact.email} tem beehiiv_subscription_id de origem Kit malformado ` +
                  `("${contact.beehiiv_subscription_id}") — não é possível extrair o subscriber id; pulando checagem ` +
                  "de auto-confirmação Kit nesta rodada (#6340 item 4).",
              );
              failed++;
              break;
            case "kit-valid":
              if (!kitApiKey) {
                // Ausência de KIT_API_KEY nunca aborta `runEvaluation` em si
                // (dry-run local sem a env configurada, ou
                // `newsletterBackend === "beehiiv"` — rollback — com contato
                // Kit ainda no store) — degrada pra "ainda não confirmado
                // nesta rodada". NÃO conta como `failed` (não é falha
                // transitória de API nem dado corrompido) — conta em
                // `kitAutoConfirmSkipped` (fix A, review pós-merge): `main()`
                // agora exige `KIT_API_KEY` sempre que há ≥1 contato de
                // origem Kit no conjunto avaliado, então este ramo só é
                // alcançado em dry-run/chamada direta sem a env — mas quando
                // é alcançado em `push` (chamador que ignora `main()`), o
                // contador dedicado garante que a lacuna fique visível, ver
                // docstring de `kitAutoConfirmSkipped`.
                log(
                  `${contact.email}: origem Kit mas kitApiKey ausente — pulando checagem de auto-confirmação Kit nesta ` +
                    "rodada (#6340 item 4); avaliado normalmente pela taxa de abertura enquanto isso.",
                );
                kitAutoConfirmSkipped++;
              } else {
                try {
                  const kitSubscriber = await getSubscriberById(kitParseResult.id, { apiKey: kitApiKey });
                  kitConfirmed = kitSubscriber.state === "active";
                  kitSubscriberCreatedAt = kitSubscriber.created_at ?? null; // #6705
                } catch (e) {
                  log(`warn: falha ao checar status Kit de ${contact.email} (subscriber id ${kitParseResult.id}): ${(e as Error).message}`);
                  failed++;
                }
              }
              break;
          }
        }

        if (kitConfirmed === true) {
          log(`${contact.email}: já ativo no Kit (auto-confirmação #6340 item 4) → promovido, sem depender da taxa de abertura.`);
          selfConfirmed++;
          if (push) {
            // #6705 — instrumentação (medição, nunca correção) da janela de
            // duplicidade: esta detecção só acontece NESTA rodada, não no
            // instante real da confirmação do double opt-in no Kit.
            // Opcional/omitida em teste (ver docstring do parâmetro) — nunca
            // lança, nunca bloqueia a promoção em si (self-review: try/catch
            // dedicado — uma falha de disco na MEDIÇÃO não pode impedir a
            // promoção real que ela só está observando).
            try {
              appendDuplicateWindowLog?.(
                buildDuplicateWindowEntry({
                  email: contact.email,
                  kitSubscriberCreatedAt,
                  lastBrevoSendAt: nativeState?.last_messagesSent_at ?? null,
                  brevoSendsCount: nativeState?.sends_count ?? contact.sends_count,
                }),
              );
            } catch (logErr) {
              log(`${contact.email}: falha ao registrar instrumentação #6705 (não bloqueia a promoção) — ${(logErr as Error).message}`);
            }
            await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
            store = applySelfConfirmed(store, contact.email);
          }
          continue;
        }
        // Ainda `inactive` no Kit (ou id malformado/key ausente/falha de
        // rede, tratados acima) — segue pra avaliação normal (Passo 2)
        // abaixo, igual a qualquer outro contato não confirmado. NUNCA cai
        // no bloco Beehiiv a seguir (`else`) — a origem já decidiu o
        // backend de checagem.
      } else {
        // Reusa `beehiivStatus` se o passo 0 já buscou (contato
        // `emailBlacklisted`) — nunca um 2º GET pro mesmo contato no mesmo
        // run.
        if (beehiivStatus === undefined) {
          beehiivStatus = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email).catch((e) => {
            log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
            statusCheckFailed = true;
            return undefined;
          });
          if (statusCheckFailed) failed++;
        }

        // #6339, ESCOPO NÃO COBERTO: diferente da promoção por score logo
        // abaixo (que já escreve direto no backend real via
        // `newsletterBackend`), esta auto-confirmação continua dependendo da
        // ponte `sync-beehiiv-subscribers-kit.ts` (Beehiiv → Kit, até 24h de
        // atraso) pra o contato de fato receber a diária quando
        // `newsletterBackend === "kit"` — `applySelfConfirmed` só desvincula
        // da fila Brevo, nunca escreve no Kit. Risco aceito nesta unidade
        // (ver PR body do #6339): o volume por este caminho é residual (só
        // quem confirma o double opt-in Beehiiv de um pool que já não cresce,
        // ver nota "Pool Pending é FINITO" em `sync-pending-to-brevo.ts`), e
        // `test/sync-beehiiv-subscribers-kit-load-bearing-6339.test.ts` trava
        // a ponte como load-bearing enquanto este caminho não for corrigido.
        // **Este gap é DIFERENTE do #6340 item 4 acima**: aquele cobria a
        // ausência de roteamento por origem (contato Kit sendo checado na
        // Beehiiv — corrigido nesta unidade, `if` acima); este cobre um
        // contato de origem BEEHIIV (`else`, aqui) cuja confirmação, mesmo
        // check corretamente na Beehiiv, ainda depende da ponte de sync
        // pra chegar ao Kit — os dois nunca se sobrepõem por contato.
        if (beehiivStatus === "active") {
          log(`${contact.email}: já ativo na Beehiiv (auto-confirmação) → promovido, sem depender da taxa de abertura.`);
          selfConfirmed++;
          if (push) {
            await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
            store = applySelfConfirmed(store, contact.email);
          }
          continue;
        }
      }

      // 2) taxa de abertura + piso de amostra (#4476 item 1), em 2 variantes
      // (instantânea pra promoção, madura >=48h pra supressão — #4476
      // "Janela de maturação"). Reusa `nativeState` (passo 0) quando
      // disponível — nunca um 2º GET pro mesmo contato no mesmo run.
      //
      // Fallback SEM `nativeState` (só ocorre com `brevoApiKey` ausente —
      // dry-run sem a key configurada; `--push` sempre exige a key, ver
      // main()): usa os contadores já persistidos no store pros dois papéis
      // (instant=mature) — limitação DOCUMENTADA e aceita, não um bug: sem
      // uma leitura fresca da Brevo não há timestamp por evento pra calcular
      // maturidade de verdade, e este caminho nunca aplica supressão de
      // qualquer forma (push sempre tem brevoApiKey). Só afeta o PREVIEW de
      // dry-run sem key configurada.
      const counts: EvaluateContactCounts = nativeState
        ? {
            instant: { opens_count: nativeState.opens_count, sends_count: nativeState.sends_count },
            mature: { opens_count: nativeState.mature_opens_count, sends_count: nativeState.mature_sends_count },
          }
        : {
            instant: { opens_count: contact.opens_count, sends_count: contact.sends_count },
            mature: { opens_count: contact.opens_count, sends_count: contact.sends_count },
          };
      const evalResult = evaluateContact(counts);
      log(
        `${contact.email}: openRate=${(evalResult.open_rate * 100).toFixed(1)}% ` +
          `(${counts.instant.opens_count} aberto(s)/${counts.instant.sends_count} enviado(s), ` +
          `${counts.mature.opens_count}/${counts.mature.sends_count} maduro(s) p/ supressão) → ${evalResult.action}`,
      );

      if (evalResult.action === "promote_to_beehiiv") promoted++;
      else if (evalResult.action === "suppress") suppressed++;
      else kept++;

      if (!push) continue;

      if (evalResult.action === "promote_to_beehiiv") {
        // #6339: qual backend recebe a promoção depende de `newsletterBackend`
        // (default "beehiiv", preservando o caminho pré-#6339 — main() sempre
        // passa o valor real de platform.config.json). Ver docstring de
        // `promoteKitSubscription` acima pro racional completo.
        let confirmed: boolean;
        if (newsletterBackend === "kit") {
          if (!kitApiKey) {
            throw new Error(`newsletterBackend === "kit" mas kitApiKey ausente — necessário pra promover ${contact.email} (#6339).`);
          }
          const { id } = await promoteKitSubscription(contact.email, kitApiKey);
          confirmed = await verifyPromotedToKit(id, kitApiKey);
        } else {
          // #7382 — antes de escrever na Beehiiv, checar se a pessoa já está
          // `active` no Kit: promover sem essa checagem é exatamente o que
          // produziu envio duplicado ao vivo (4 casos confirmados,
          // 03/09/2026). Mesma disciplina de duas metades de
          // `decideBeehiivDeactivateAction` (kit-ramp-cohort.ts) — ver
          // docstring de `decidePromoteToBeehiivAction` acima.
          let kitActive = false;
          let kitCheckAvailable = true;
          if (!kitApiKey) {
            kitCheckAvailable = false;
          } else {
            try {
              const kitSubscriber = await getKitSubscriberByEmail(contact.email, { apiKey: kitApiKey });
              kitActive = kitSubscriber?.state === "active";
            } catch (e) {
              log(`warn: falha ao checar status Kit de ${contact.email} antes de promover pra Beehiiv (#7382): ${(e as Error).message}`);
              kitCheckAvailable = false;
            }
          }
          const crossPlatformDecision = decidePromoteToBeehiivAction({ kitCheckAvailable, kitActive });
          if (crossPlatformDecision === "skip_active_on_kit") {
            log(`${contact.email}: já ativo no Kit — pulando promoção pra Beehiiv (evita envio duplicado, #7382); desvinculando da fila Brevo.`);
            skippedActiveOnKit++;
            await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
            store = applyConvertedToKit(store, contact.email);
            continue;
          }
          if (crossPlatformDecision === "skip_kit_check_unavailable") {
            log(
              `warn: ${contact.email} — checagem Kit indisponível antes de promover pra Beehiiv (#7382${
                kitApiKey ? "" : ", KIT_API_KEY ausente"
              }) — mantendo in_brevo (fail-safe, nunca promove sem saber se já está ativo no Kit).`,
            );
            failed++;
            store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
            continue;
          }
          await promoteBeehiivSubscription(publicationId, beehiivApiKey, contact.email);
          confirmed = await verifyPromotedToBeehiiv(publicationId, beehiivApiKey, contact.email);
        }
        if (!confirmed) {
          const backendLabel = newsletterBackend === "kit" ? "ativo no Kit" : "\"pending\" na Beehiiv";
          log(`warn: ${contact.email} continua não confirmado como ${backendLabel} após promoção — mantendo in_brevo (fail-safe).`);
          failed++;
          store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
          continue;
        }
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        store = applyEvaluation(store, contact.email, {
          ...counts.instant,
          open_rate: evalResult.open_rate,
          action: "promote_to_beehiiv",
          resolutionReason: newsletterBackend === "kit" ? "score_threshold_kit" : "score_threshold",
        });
      } else if (evalResult.action === "suppress") {
        await suppressInBrevo(brevoApiKey!, contact.email);
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        const suppressConfirmed = await verifySuppressedInBrevo(brevoApiKey!, listId, contact.email);
        if (!suppressConfirmed) {
          log(`warn: ${contact.email} supressão/desvinculação não confirmada na Brevo — mantendo in_brevo (fail-safe).`);
          failed++;
          store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
          continue;
        }
        store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "suppress" });
      } else {
        store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
      }
    } catch (e) {
      // #4398 review (fix 1): falha transitória de API num contato NUNCA
      // aborta o run inteiro — segue pro próximo, progresso já acumulado em
      // `store` (contatos processados com sucesso antes deste) persiste no
      // `writeStore()` final, mesmo padrão de `sync-pending-to-brevo.ts`.
      failed++;
      log(`FALHA em ${contact.email}: ${(e as Error).message}`);
    }
  }

  return {
    store,
    unsubscribedNative,
    unsubscribedNativeBeehiivNotFound,
    bouncedNative,
    selfConfirmed,
    promoted,
    suppressed,
    kept,
    failed,
    kitAutoConfirmSkipped,
    skippedActiveOnKit,
  };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[evaluate-brevo-diaria] ${msg}\n`);

  // #4651: os process.exit() abaixo até o 1º `await` de rede
  // (reconcileStoreWithBrevoList, mais adiante) ficam como estão de
  // propósito — nenhum fetch rodou ainda neste processo nestes pontos
  // (leitura de platform.config.json/env é I/O local síncrono), então não
  // há socket keep-alive aberto que dispare o crash libuv
  // (UV_HANDLE_CLOSING) do #4638/#1401.
  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria || brevoDiaria.list_id == null) {
    log("ERRO: brevo_diaria não configurado (ou list_id ausente) em platform.config.json.");
    process.exit(2);
  }
  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[evaluate-brevo-diaria]");
  const brevoApiKey = process.env[brevoDiaria.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  // #6339: qual backend recebe a promoção por score — lido de
  // `publishing.newsletter.backend`, não hardcoded, pra este script
  // acompanhar automaticamente um eventual rollback do switchover do
  // #6114 (ver docstring de `promoteKitSubscription`). Default "beehiiv"
  // só protege contra `platform.config.json` sem a chave `publishing`
  // (nunca deveria acontecer em produção, mas evita `undefined` virar
  // `"kit"` por engano numa comparação futura).
  const newsletterBackend = platformConfig.publishing?.newsletter?.backend === "kit" ? "kit" : "beehiiv";
  const kitApiKey = process.env.KIT_API_KEY;

  // readStore/filter são I/O local síncrono (mesma classe do
  // platformConfig acima) — seguro fazer ANTES do guard de KIT_API_KEY
  // abaixo, que ainda precisa rodar antes do 1º await de rede (#4651, ver
  // comentário no topo de main()).
  const store = readStore(DEFAULT_STORE_PATH);
  const inBrevo: BrevoDiariaContact[] = store.contacts.filter((c) => c.status === "in_brevo");

  // #6340 item 4 fix A (review pós-merge) — o guard original só exigia
  // KIT_API_KEY quando `newsletterBackend === "kit"`, mas o roteamento por
  // ORIGEM do Passo 0/1 de `runEvaluation` é INDEPENDENTE de
  // `newsletterBackend`: com `newsletterBackend === "beehiiv"` (rollback) e
  // `push: true`, o script rodava sem a key, e TODO contato de origem Kit
  // caía no ramo `!kitApiKey` sem incrementar nenhum contador visível —
  // `exitCode` 0, contato preso `in_brevo` indefinidamente, invisível pra
  // qualquer monitor de cron (exatamente o envio duplicado Kit+Brevo que o
  // item 4 existe pra impedir). A condição correta é "existe trabalho que
  // depende da key" — ≥1 contato de origem Kit no conjunto que será
  // avaliado nesta rodada (`inBrevo`) — não "o backend atual é kit". O
  // guard `newsletterBackend === "kit"` original é mantido explicitamente
  // (a promoção por score em si SEMPRE precisa da key nesse backend, mesmo
  // sem nenhum contato Kit ainda no store).
  //
  // #7382: este guard NÃO foi estendido pra exigir `KIT_API_KEY` sempre que
  // há CANDIDATO a promoção pra Beehiiv (impossível saber antecipadamente
  // aqui — a decisão de score só acontece dentro de `runEvaluation`, por
  // contato). Em vez disso, `decidePromoteToBeehiivAction` degrada
  // fail-safe por contato quando `kitApiKey` está ausente no momento da
  // promoção (`skip_kit_check_unavailable` → conta em `failed`, mantém
  // `in_brevo`, nunca promove sem checar o Kit primeiro) — ver docstring da
  // função. `KIT_API_KEY` é uma env var sempre presente em produção (ver
  // `.env.example`/Doppler), então este caminho fail-safe é o caso raro
  // (dev local sem a env), não o esperado.
  const hasKitOriginContacts = inBrevo.some((c) => c.beehiiv_subscription_id.startsWith(KIT_ORIGIN_ID_PREFIX));
  if (push && (newsletterBackend === "kit" || hasKitOriginContacts) && !kitApiKey) {
    const why = newsletterBackend === "kit" ? "newsletterBackend=kit" : `${inBrevo.filter((c) => c.beehiiv_subscription_id.startsWith(KIT_ORIGIN_ID_PREFIX)).length} contato(s) de origem Kit no store`;
    log(`ERRO: KIT_API_KEY não definido no ambiente (necessário pra --push — ${why}, #6340 item 4 fix A).`);
    process.exit(2);
  }

  // #4579: reconciliação de órfãos — roda SEMPRE (mesmo em dry-run, é
  // read-only) quando a chave Brevo está disponível; NUNCA aborta o run
  // principal se falhar (best-effort, mesmo espírito do try/catch por
  // contato do loop abaixo). Um contato vinculado à lista Brevo mas ausente
  // do store nunca é avaliado por `runEvaluation` (que só itera
  // `status === "in_brevo"`) — sem este guard, ele continua recebendo
  // envios indefinidamente sem que ninguém saiba que existe (achado
  // original da issue, ver docstring do módulo).
  if (brevoApiKey) {
    try {
      await reconcileStoreWithBrevoList({ brevoApiKey, listId: brevoDiaria.list_id as number, store, log });
    } catch (e) {
      log(`warn: reconciliação de órfãos (#4579) falhou: ${(e as Error).message} — avaliação prossegue normalmente.`);
    }
  } else {
    log(`reconciliação de órfãos (#4579) pulada — ${brevoDiaria.api_key_env} ausente no ambiente.`);
  }

  log(`${inBrevo.length} contato(s) in_brevo a avaliar.`);

  const result = await runEvaluation({
    contacts: inBrevo,
    store,
    push,
    publicationId,
    beehiivApiKey,
    brevoApiKey,
    listId: brevoDiaria.list_id as number,
    log,
    newsletterBackend,
    kitApiKey,
    appendDuplicateWindowLog: appendBrevoKitDuplicateWindowLog, // #6705
  });

  log(
    `resumo: ${result.unsubscribedNative} descadastrado(s) nativamente ` +
      `(${result.unsubscribedNativeBeehiivNotFound} via 404 permanente Beehiiv, ver resolution_reason), ` +
      `${result.bouncedNative} bounced (bounce/ação admin, #5351 — NUNCA propagado pra Beehiiv), ` +
      `${result.selfConfirmed} auto-confirmado(s), ` +
      `${result.promoted} promovido(s) por taxa de abertura, ${result.suppressed} suprimido(s), ` +
      `${result.kept} mantido(s), ${result.failed} falha(s), ` +
      `${result.kitAutoConfirmSkipped} pulado(s) por KIT_API_KEY ausente (#6340 item 4 fix A), ` +
      `${result.skippedActiveOnKit} promoção(ões) pra Beehiiv pulada(s) por já ativo no Kit (#7382).`,
  );

  // Windows fix (#4651, mesma classe do #4638/#1401): tanto o branch
  // dry-run quanto o --push chegam aqui só depois de `await runEvaluation`
  // que, no caminho normal com `brevoApiKey` presente e contato(s) in_brevo
  // pra avaliar, já fez await fetch (reconcileStoreWithBrevoList — condicional
  // a `brevoApiKey` — e o loop por contato dentro de runEvaluation) — mas
  // process.exitCode + return é seguro de qualquer forma, com ou sem fetch
  // prévio, evitando o crash libuv (UV_HANDLE_CLOSING) com sockets
  // keep-alive ainda abertos.
  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    // #6340 item 4 fix A — `kitAutoConfirmSkipped > 0` sinaliza saída
    // não-zero no MESMO caminho de `failed > 0`: não é falha transitória de
    // contato, é "algo não pôde ser confirmado por falta de credencial", e
    // precisa aparecer em cron (ver docstring de `kitAutoConfirmSkipped`).
    if (result.failed > 0 || result.kitAutoConfirmSkipped > 0) process.exitCode = 1;
    return;
  }
  writeStore(result.store, DEFAULT_STORE_PATH);
  log("push concluído — store atualizado.");
  if (result.failed > 0 || result.kitAutoConfirmSkipped > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[evaluate-brevo-diaria] erro fatal: ${(e as Error).message}\n`);
    // Windows fix (#4651): main() pode lançar depois de já ter feito await
    // fetch — mesma razão do bloco acima.
    process.exitCode = 1;
  });
}
