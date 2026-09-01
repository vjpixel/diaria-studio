import type { Env } from "./index";
import { type Brand, editionToMonthSlug, AAMMDD_RE, CYCLE_EDITION_RE, BRAND_INFO } from "./lib"; // #3297: AAMMDD_RE substitui regex inline; #4435: CYCLE_EDITION_RE p/ guard de formato×marca
// #3522: streak (dias/meses consecutivos acertando) — continuidade de
// período de votação + sufixo de exibição pós-voto. Ver rationale completo
// no header da seção "Streak" em lib.ts.
import { isConsecutiveVotingPeriod, renderStreakSuffix } from "./lib";
// #3523: "X% acertaram este par" — mesmo padrão de sufixo pós-voto do streak
// acima (ver header da seção "Stats pós-voto" em lib.ts).
import { renderStatsSuffix } from "./lib";
import {
  formatEditionDateForBrand,
  parseValidEditions,
  isValidEdition,
  isUnsubstitutedMergeTag,
  classify403Reason,
  todayAammddBrt, // #3113 item 9: fecha a mesma brecha de edição futura no /vote direto
  isValidVoteEmailFormat, // #3118 item 3
  isValidVoteEditionFormat, // #3118 item 3
  legacyMonthlyEditionForCycle, // #3261: /stats por ciclo também consulta a chave AAMMDD legada
  cycleForLegacyMonthlyEdition, // #3350: /editions normaliza chave AAMMDD legada pro slug de ciclo
  safeParseKv, // #3298: parse seguro de JSON vindo do KV
  isValidWebToken, // #3976: brand "web" exige local-part UUID v4 sob o domínio reservado
  isAnonymousWebIdentity, // #4011: domínio reservado do brand "web" nunca pode ser aceito fora dele
  resolveVoteIdentityBoxKind, // #4418 §2/§3: decide Caixa A/B/nenhuma a partir de score:{email}
  type SubscribeBoxState, // #4418 §2b
  seqStateKvKey, // #4443: chave do agregado seq:{month}:{email} (jogar/seq-state)
} from "./lib";
import { hmacSign, hmacVerify, json, voteHtmlResponse, votePageHtml } from "./index";
// #4487: resolução do token opaco de voto → e-mail real, via lookup KV.
// #4581: hoje só o canal BREVO (`brevo_diaria`) manda token — o e-mail diário
// da Beehiiv voltou ao `{{email}}` cru e cai em `not-token-domain`, que é o
// caminho DOMINANTE deste handler. Ver header de poll-token.ts pro design.
// #4518: classifyPollTokenEmail substitui extractPollToken/isPollTokenIdentity
// neste call site (discriminated union — ver rationale no ponto de uso).
import { classifyPollTokenEmail, pollTokenKvKey } from "./poll-token";
import { upsertOwnEntryInSnapshot, listAllKeys } from "./leaderboard-routes";
import { type StatsCounterData, mergeStatsWithKvFallback } from "./stats-counter";
// #4169: DO que serializa o read-modify-write de score:{email} (global) e
// score-by-month:{month}:{email} (mensal) — ver rationale completo no header
// de score-counter.ts.
import {
  type ScoreData,
  type MonthScoreData,
  type UpdateScorePayload,
  type UpdateMonthPayload,
  type AdjustScoreCorrectPayload,
  type AdjustMonthCorrectPayload,
  type SeqMonthMap, // #4443: agregado seq:{month} mantido pelo DO junto do month:{monthSlug}
  isValidScoreData,
  isValidMonthScoreData,
  isValidSeqMonthMap, // #4443
} from "./score-counter";
// #3517 / #4065: share card pós-jogo — todos os brands (ver rationale no
// header de share.ts sobre por que o payload é {edition, correct}, sem
// leitura KV extra).
import { encodeShareToken, type SharePayload } from "./share";
// #4054: identidade pós-gate do caminho de fora — cookie de sessão PARALELO
// ao token anônimo (ver bloco "identidade pós-gate" abaixo).
// #4121: `readWebSession` (não só o e-mail) — o override abaixo precisa saber
// se a sessão é `pending` (cadastro sem confirmação da Beehiiv ainda) pra NÃO
// aplicar a sobreposição de identidade nesse caso.
import { readWebSession } from "./web-gate";
// #6902: a lista de contas de teste do editor já existia hardcoded aqui (2
// endereços) enquanto a canônica do projeto — `EDITOR_SEED_EMAILS` em
// scripts/lib/editor-copy.ts — já tinha crescido pra 5. Resultado: o editor
// testava o voto com `vjpixel@yahoo.com`/`vjpixel@hotmail.com`/`apixel@gmail.com`
// e recebia 410 "edição não aceita mais votos" mesmo com a conta ativa e merge
// tag corretamente resolvida na Beehiiv. Derivar da fonte única elimina a
// categoria inteira de "esqueceram de atualizar os dois lugares".
// `email` já chega normalizado (lowercase + trim) no momento da comparação
// (handleVote, linha ~271) — os endereços de seed já estão em lowercase, mas
// o `.map(lowercase)` é defensivo e barato.
import { EDITOR_SEED_EMAILS } from "../../../scripts/lib/editor-copy.ts";

/**
 * #3384: contas do próprio editor usadas pra testar o fluxo de voto no e-mail
 * de teste do Stage 5 (rodado na véspera — a edição ainda é "de amanhã" no
 * momento do teste). Isentas do gate de edição-futura abaixo; todas as outras
 * regras (assinatura/gabarito/KV) continuam valendo normalmente pra elas.
 * `email` já chega normalizado (lowercase + trim) no momento da comparação.
 */
const TEST_ACCOUNT_EMAILS = new Set(EDITOR_SEED_EMAILS.map((e) => e.toLowerCase()));

/**
 * #3118 (item 10): monta a resposta "já votou" — extraído dos dois caminhos
 * de dedup em `handleVote` (DO e fallback KV), que tinham ~20 linhas quase
 * idênticas. A duplicação já havia divergido uma vez no passado (#2189
 * corrigiu só um dos dois ramos — o outro ficou com `nicknameForm` hardcoded
 * `null` por um tempo, deixando o nickname inacessível pra quem retentava o
 * link). Consolidar num único helper elimina essa classe de regressão.
 *
 * #3118 (item 4): `JSON.parse(existingFromKv)` agora tem guard — um registro
 * `vote:{edition}:{email}` corrompido no KV lançava uma exceção não-capturada
 * aqui, derrubando o voto do LEITOR ATUAL com 500 só por causa de um registro
 * antigo malformado. Corrompido → cai no mesmo fallback `{ choice: "?" }` já
 * usado quando o KV eventual ainda não propagou o voto do 1º request.
 *
 * #3278: `JSON.parse(prevScoreRaw)` (mesma classe de dado — blob JSON gravado
 * em `score:{email}`) ficou desguardado no mesmo refactor do #3118 item 4,
 * reintroduzindo a mesma classe de bug 2 linhas abaixo do parse irmão que
 * ELE MESMO endureceu. Corrompido → trata como "sem score" (nickname form
 * reoferecido, mesmo fallback de quando score:{email} nunca foi gravado).
 */
export async function buildAlreadyVotedResponse(
  env: Env,
  brand: Brand,
  edition: string,
  email: string,
  existingFromKv: string | null,
  /** #4065 follow-up (achado 260727): a tela de "já votou" nunca recebeu o
   * card de compartilhamento nem o CTA/cadastro inline que #4065 trouxe pro
   * resultado normal — quem revisita um link já votado (o caso mais comum:
   * clicou 2x no mesmo link da newsletter) caía num beco sem saída idêntico
   * ao que #4065 fechou pro voto fresco. `correctRaw` é opcional (chamadores
   * legados/teste continuam funcionando sem share card, mesmo comportamento
   * de antes) — quando fornecido, monta o MESMO payload {edition, correct}
   * usado por handleVote/handleVoteFastPath (share.ts).
   *
   * IMPORTANTE (achado no self-review desta PR): `correct` é computado AQUI
   * DENTRO contra `prev.choice` (o voto REALMENTE persistido, lido de
   * `existingFromKv` logo abaixo) — nunca contra o `choice` da query string
   * da requisição atual. Um link antigo/copiado pode chegar com um `choice`
   * diferente do que a pessoa de fato votou (a requisição é descartada,
   * "já votou" não sobrescreve nada) — se `correct` fosse derivado desse
   * `choice` descartado, o card de compartilhamento mostraria acerto/erro
   * pra uma resposta que o leitor nunca deu, incoerente com a própria
   * mensagem "já votou" logo acima (que sempre cita `prev.choice`).
   */
  correctRaw: string | null = null,
  /** #4161: env CRU (não branded) — lê `eiameta:{edition}` compartilhado,
   * mesmo racional de `correctRaw` acima (#3600/#4065). Default `= env`
   * preserva chamadores legados/teste que não passam este argumento
   * (equivalente a brand="diaria", onde `bEnv === env` de qualquer forma). */
  rawEnv: Env = env,
): Promise<Response> {
  // choice: "?" é um edge aceitável: ocorre quando o 2º votante concorrente
  // chegou tão rapidamente que o KV eventual ainda não propagou o put do 1º
  // request. O DO rejeita o 2º corretamente (sem double-vote), mas o KV não
  // tem o choice ainda para exibir. O "?" é mostrado ao leitor e desaparece
  // em milissegundos quando o KV propaga — não afeta a integridade do voto.
  let prev: { choice?: string } = { choice: "?" };
  if (existingFromKv) {
    try {
      prev = JSON.parse(existingFromKv);
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_already_voted_parse_error", edition, error: String(e) }));
      // prev permanece { choice: "?" } — mesmo fallback do KV-ainda-não-propagou.
    }
  }
  // #3113 item 13: sempre citar a edição (formatEditionDateForBrand já
  // resolve "DD de mês de AAAA" vs "mês de AAAA" por brand, #3112) — antes
  // o brand "year" (clarice) dizia só "nesta edição", ambíguo quando o
  // voto vem do arquivo retroativo multi-edição (#2867): o leitor que já
  // votou em MAIS de uma edição arquivada não sabia qual delas.
  // #3278 (code-review desta PR): `prev.choice` sem optional chaining lançava
  // TypeError não-capturado quando `existingFromKv` é JSON VÁLIDO mas não-objeto
  // (ex: a string literal "null" — JSON.parse("null") retorna null sem lançar,
  // então o catch acima nunca dispara). `?.` fecha essa brecha na mesma família
  // de bug que este PR corrige — reproduzido via buildAlreadyVotedResponse(...,
  // "null") lançando "Cannot read properties of null (reading 'choice')".
  const jaVotouMsg = `Você já votou na edição de ${formatEditionDateForBrand(edition, brand)} (escolha: ${prev?.choice ?? "?"}).`;
  // #4065 follow-up: `correct` derivado do voto REALMENTE persistido
  // (prev.choice), nunca do `choice` da requisição atual — ver rationale
  // completo no header do parâmetro `correctRaw` acima.
  const correct = correctRaw && prev?.choice && prev.choice !== "?" ? prev.choice === correctRaw : null;
  // #2189: branch "já votou" NÃO hardcoda nicknameForm=null. Lê o score pra
  // determinar se o votante ainda precisa do form de nickname — sem isso, um
  // retry após 500 mostrava "já votou" mas sem o form, deixando o nickname
  // inacessível para sempre.
  // #4418: agora decide entre Caixa A (nickname), Caixa B (subscribe, brand
  // clarice sem opt-in) ou nenhuma — ver resolveVoteIdentityBoxKind (lib.ts),
  // compartilhado com handleVote/handleVoteFastPath abaixo.
  let prevNicknameForm: { email: string; sig: string } | null = null;
  let prevSubscribeBox: SubscribeBoxState | null = null;
  const prevScoreRaw = await env.POLL.get(`score:${email}`);
  // #3278: mesma classe de dado que existingFromKv acima (blob JSON gravado em
  // KV) — precisa do mesmo guard. Sem try/catch, um `score:{email}` corrompido
  // derrubava com 500 o leitor que só está reabrindo o link de "já votou"
  // (nem sequer é um voto novo sendo lançado).
  let prevScoreObj: { nickname?: string | null; optin?: boolean } | null = null;
  if (prevScoreRaw) {
    try {
      prevScoreObj = JSON.parse(prevScoreRaw);
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_already_voted_score_parse_error", edition, error: String(e) }));
      // prevScoreObj permanece null — trata como "sem score" (mesmo fallback
      // usado quando score:{email} nunca foi gravado), oferecendo o form de
      // nickname (comportamento seguro: pior caso é reoferecer o form).
    }
  }
  const prevBoxKind = resolveVoteIdentityBoxKind(prevScoreObj, brand);
  if (prevBoxKind !== "none") {
    const prevSig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    if (prevBoxKind === "nickname") {
      prevNicknameForm = { email, sig: prevSig };
    } else {
      prevSubscribeBox = { email, sig: prevSig, nickname: prevScoreObj!.nickname! };
    }
  }
  // #4065 follow-up: mesmo payload {edition, correct} do voto fresco — share
  // card (todos os brands) + CTA/cadastro inline (brand clarice, via
  // votePageHtml internamente) também aparecem em quem revisita já-votado.
  const sharePayload: SharePayload = { edition, correct };
  const shareCard: { token: string; payload: SharePayload } = {
    token: await encodeShareToken(env.POLL_SECRET, sharePayload),
    payload: sharePayload,
  };

  // #4161: mesmo padrão de resultImages do voto fresco (handleVote/
  // handleVoteFastPath) — a tela de "já votou" computava `correct` mas nunca
  // montava `resultImages`/`eiaMeta`, afirmando um resultado ("Acertei o
  // 'É IA?' de hoje!", ver shareCard acima) sem nunca mostrar as duas imagens
  // reveladas nem a descrição/crédito da foto real. `clickedSide` DEVE ser
  // `prev.choice` (o voto REALMENTE persistido, lido acima) — nunca um
  // `choice` de query string (este helper nem recebe um; mesmo racional já
  // documentado pro cômputo de `correct` no header do parâmetro `correctRaw`).
  const showImages = correct !== null;
  const aiSide: "A" | "B" | null = showImages && correctRaw ? (correctRaw as "A" | "B") : null;
  const clickedSide: "A" | "B" | null = prev?.choice === "A" || prev?.choice === "B" ? prev.choice : null;
  const resultImages = showImages && aiSide && clickedSide
    ? { edition, aiSide, clickedSide }
    : null;

  let eiaMeta: { description: string; credit: string } | null = null;
  if (correct !== null) {
    try {
      const eiaMetaRaw = await rawEnv.POLL.get(`eiameta:${edition}`);
      const parsed = safeParseKv<{ description?: string; credit?: string }>(eiaMetaRaw, "vote_already_voted_eiameta_parse_error", edition);
      if (parsed && (parsed.description || parsed.credit)) {
        eiaMeta = { description: parsed.description ?? "", credit: parsed.credit ?? "" };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_already_voted_eiameta_fetch_failed", edition, error: String(e) }));
      // eiaMeta permanece null — fallback silencioso (bloco não renderiza).
    }
  }

  return voteHtmlResponse(
    votePageHtml(jaVotouMsg, false, prevNicknameForm, resultImages, editionToMonthSlug(edition), brand, null, shareCard, eiaMeta, prevSubscribeBox, brand === "clarice"),
    200,
  );
}

/**
 * #3600: `rawEnv` — env CRU (sem prefixo de brand), usado SÓ para ler o
 * gabarito compartilhado `correct:{edition}`. O gabarito é um fato público
 * brand-independente (mesma decisão já documentada em jogar.ts, decisão 3:
 * "gabarito lido DIRETO do KV correct:{edition}, sem prefixo de brand") —
 * close-poll.ts sempre grava a chave crua, nunca `{brand}:correct:{edition}`.
 * Antes deste fix, `handleVote` lia o gabarito via `env` (que É o `bEnv`
 * branded, passado por `routeRequest` em index.ts) — para brand="web"/"clarice"
 * isso resolvia para `web:correct:{edition}`/`clarice:correct:{edition}`,
 * chaves que NUNCA são escritas. Resultado: `correctRaw` sempre null para
 * brands não-diaria → reveal quebrado (mensagem "resultado sai na próxima
 * edição" para sempre, mesmo com o gabarito já fechado).
 * Default `= env` preserva o comportamento de chamadas legadas/testes que
 * invocam `handleVote` com um único env não-branded para os 2 parâmetros
 * (equivalente a brand="diaria", onde `bEnv === env` de qualquer forma —
 * brandKvPrefix("diaria") === "").
 * Todo o resto (voto, score, dedup, stats, valid_editions) CONTINUA lido/
 * escrito via `env` (branded) — só o READ do gabarito muda.
 *
 * #3983 (reverte o Suspense #3595 + reavaliação do cômputo do voto pedida
 * pelo editor 260723): `ctx` — `ExecutionContext` real do Workers runtime
 * (`fetch(request, env, ctx)`, threadeado por index.ts). Quando presente
 * (produção real), `handleVote` responde o VEREDITO (acertou/errou) assim
 * que `correct:{edition}` é lido — dezenas de ms — e adia toda a
 * contabilidade pesada (dedup DO, guard-keys de stats/score/month, commit do
 * voteKey, vote-log) pra `ctx.waitUntil()`. Ver `handleVoteFastPath`/
 * `runVoteBookkeeping` abaixo pro código novo e o rationale completo.
 * Guard é `typeof ctx?.waitUntil === "function"`, não só truthy: TODA a
 * suíte de testes hoje chama `handleVote`/`worker.fetch` sem `ctx` ou com
 * `{} as ExecutionContext` (cast de tipo sem método real) — ambos caem no
 * caminho síncrono legado abaixo, INTOCADO, byte-a-byte igual ao
 * comportamento pré-#3983. Só o Workers runtime real (que sempre injeta um
 * ExecutionContext de verdade) exercita o fast-path — zero regressão na
 * suíte existente, ganho de latência 100% em produção.
 */
export async function handleVote(url: URL, env: Env, brand: Brand = "diaria", rawEnv: Env = env, ctx?: ExecutionContext, request?: Request): Promise<Response> {
  // #1083: Beehiiv não URL-encoda `{{ subscriber.email }}`; URLSearchParams
  // converte `+` em ` `. Restaurar antes de qualquer uso (HMAC, KV key).
  const emailRaw = url.searchParams.get("email")?.toLowerCase().trim();
  // #4054: `let`, não `const` — pode ser sobrescrito pela identidade do
  // cookie de sessão do brand `web` MAIS ABAIXO, depois que o guard
  // anti-forjamento (#3976/#4011) já validou o token original. Ver o bloco
  // "identidade pós-gate" logo após esse guard.
  let email = emailRaw ? emailRaw.replace(/ /g, "+") : emailRaw;
  const edition = url.searchParams.get("edition");
  const choice = url.searchParams.get("choice")?.toUpperCase();
  // sig ausente = merge-tag mode: Beehiiv substitui {{ subscriber.email }} no envio
  const sig = url.searchParams.get("sig");
  // #1236: ?test=1 valida tudo (gate + sig + dedup) mas NÃO escreve em KV.
  // Útil pra smoke test / debug em prod sem poluir leaderboard.
  const testMode = url.searchParams.get("test") === "1";

  if (!email || !edition || !choice) {
    return voteHtmlResponse(votePageHtml("Link inválido — parâmetros ausentes.", false, null, null, null, brand), 400);
  }

  // #2262: rejeita merge tag NÃO-substituída como email (vira voto-lixo no
  // leaderboard público). Helper testável `isUnsubstitutedMergeTag` em ./lib.
  if (isUnsubstitutedMergeTag(email)) {
    // #4520: guard existia desde #2262 sem log nenhum — o único sinal era o
    // IN-BAND HTTP check de `scripts/lint-test-email-link-tracking.ts`
    // (stage: "delivered", HEAD real em /vote), fora de banda e só rodado
    // manualmente/no CI de teste de e-mail. `console.log` (não
    // `console.error`): merge tag não-substituída é tipicamente sintoma de
    // config/outage do lado da plataforma de envio (test send, preview,
    // atributo ausente no contato — ver `isUnsubstitutedMergeTag`/lib.ts),
    // não um bug deste Worker — mesmo nível de `poll_vote_403` logo abaixo,
    // que já segue essa convenção pro caso irmão "sig ausente/inválido".
    // `email` aqui NUNCA é um endereço real (é o literal `{{...}}` cru) —
    // logar o valor (truncado, defensivo) é seguro e mais útil que
    // `email_domain` pra identificar QUAL merge tag ficou sem substituir.
    console.log(JSON.stringify({ event: "poll_vote_unsubstituted_merge_tag", edition, raw: email.slice(0, 100) }));
    // #4578: até aqui o guard terminava sempre em 400 ("abra o voto pelo
    // botão no email") — dead end pra quem clicou no botão de voto na
    // versão WEB do post (a merge tag só é resolvida no ENVIO do e-mail,
    // nunca na página web do post, #4487/#4581). Existe um caminho que
    // funciona perfeitamente pra esse visitante: o jogo anônimo em /jogar
    // (#3516), que não depende de e-mail resolvido nenhum. Redireciona pra
    // lá em vez do dead end — `from=post-web` sinaliza pro `/jogar`
    // (handleJogarPage/renderJogarPageHtml, jogar.ts) revelar a caixa
    // unificada do gate no pós-voto (web-gate.ts::renderJogarGateBoxBlock)
    // no lugar dos 2 blocos default (CTA-link + form de identidade) — ver
    // rationale completo lá.
    //
    // `edition` precisa ser REVALIDADO aqui, nunca reusar o valor cru da
    // query string: `isValidVoteEditionFormat` só roda mais abaixo, DEPOIS
    // deste guard — compor a URL do redirect com um `edition` ainda
    // não-validado propagaria lixo arbitrário pro Location (e, rio abaixo,
    // pra dentro de `/jogar`). Se a validação falhar aqui, cai no mesmo 400
    // de sempre — mesmo comportamento pré-#4578 pra esse caso combinado
    // (merge tag quebrada E edition malformada ao mesmo tempo).
    //
    // Brand não entra na decisão: o redirect é sempre pro jogo `web`
    // (JOGAR_BRAND, jogar.ts), venha o /vote original de brand=diaria
    // (e-mail diário) ou brand=clarice (Brevo mensal, mesma classe de bug
    // — ver corpo da issue). `edition` no formato de ciclo (Clarice,
    // YYMM-MM) passa a validação de FORMATO mas não bate `AAMMDD_RE` — o
    // próprio `/jogar` já degrada com graça pra esse caso (cai na sequência
    // genérica em vez da edição específica, mesmo comportamento de hoje pra
    // qualquer link `/jogar?edition=` com esse formato), nunca quebra.
    if (isValidVoteEditionFormat(edition)) {
      const target = new URL("/jogar", url);
      target.searchParams.set("edition", edition);
      target.searchParams.set("from", "post-web");
      return new Response(null, {
        status: 302,
        headers: { Location: target.toString(), "Cache-Control": "no-store" },
      });
    }
    return voteHtmlResponse(votePageHtml("Link inválido — abra o voto pelo botão no email.", false, null, null, null, brand), 400);
  }

  // #3118 (item 3): email/edition viram componente de chave KV
  // (`vote:{edition}:{email}`, `score:{email}`, `counted:{edition}:{email}:*`).
  // Sem uma checagem mínima de forma/tamanho aqui, um email malformado (sem
  // "@"/domínio, ou >254 chars) ou um edition absurdamente longo produz uma
  // key KV que pode passar de 512 bytes — o Workers KV lança exceção nesse
  // caso, possivelmente APÓS incrementos parciais já terem rodado (500 a
  // meio caminho). Pra brand=clarice, `valid_editions` nunca é populado
  // (#2018, fail-open permanente) — sem este gate, edition-lixo passava
  // direto pro schema de chave sem checagem nenhuma. Validação pura e
  // testável em lib.ts (isValidVoteEmailFormat/isValidVoteEditionFormat).
  if (!isValidVoteEmailFormat(email) || !isValidVoteEditionFormat(edition)) {
    return voteHtmlResponse(votePageHtml("Link inválido — parâmetros ausentes.", false, null, null, null, brand), 400);
  }

  // #4487: resolve token opaco → e-mail real ANTES de qualquer lógica de
  // identidade abaixo (guard do domínio anônimo web, sig, dedup, score,
  // nickname).
  //
  // #4581 (260804) — QUEM AINDA MANDA TOKEN: só o canal Brevo
  // (`brevo_diaria`, esp="brevo"). O e-mail diário da Beehiiv carregava
  // `{{poll_token}}@vote.eia.diaria.local` entre o #4487 e o #4581, e voltou
  // ao `{{email}}` cru (`newsletter-render-html.ts::buildVoteUrl` — o É IA?
  // não distribui prêmio). Na prática isso inverteu as proporções deste
  // handler: `not-token-domain` (e-mail cru, passa direto) é hoje o caminho
  // COMUM, e o ramo `valid` abaixo atende a minoria vinda do Brevo. Se você
  // está debugando "voto rejeitado" num envio da Beehiiv, o problema NÃO
  // está na resolução de token — ela nem é alcançada.
  //
  // O que o token protegia (e ainda protege, no Brevo): quem recebe a edição
  // ENCAMINHADA não herda o e-mail do assinante original na URL. O
  // token é gravado no KV como `polltoken:{token} -> email` pelo script de
  // injeção (`scripts/inject-poll-token-brevo.ts`, popula o atributo de
  // contato Brevo `POLL_TOKEN` por assinante). Token sem entrada no KV (subscriber novo
  // ainda não sincronizado) falha como link inválido — fail-closed, nunca
  // fail-open pra e-mail arbitrário. #4512 (correção de comentário, achado
  // comment-analyzer): rotação de POLL_SECRET SOZINHA nunca invalida uma
  // entrada KV existente — a resolução é um lookup direto
  // (`polltoken:{token} -> email`), não uma reverificação de assinatura
  // contra o secret atual. Ver `docs/runbooks/poll-secret-rotation.md`
  // (nota #4487) — a única causa real de "sem entrada no KV" é assinante
  // novo ainda não sincronizado.
  // Resto da função (sig, valid_editions, web guard, score/vote/nickname)
  // continua operando sobre `email` REAL a partir daqui — zero mudança de
  // comportamento pra quem já vota há meses (streak/nickname preservados).
  //
  // #4518: `classifyPollTokenEmail` substitui o par
  // `extractPollToken`/`isPollTokenIdentity` usado até aqui — aquele par
  // exigia o caller lembrar de checar "domínio certo mas token malformado"
  // manualmente (`isPollTokenIdentity(email) && !pollToken`, ver histórico
  // do #4512 abaixo); a union `{kind: "not-token-domain"|"malformed"|"valid"}`
  // torna esse branch OBRIGATÓRIO de nomear — `switch`/`if` sobre `.kind` não
  // compila mais se o caso do meio for ignorado. `extractPollToken`/
  // `isPollTokenIdentity` continuam exportados (poll-token.ts) por
  // compatibilidade, só não são mais usados aqui.
  const classification = classifyPollTokenEmail(email);
  if (classification.kind === "malformed") {
    // #4512 (fleet review round 2, achado silent-failure-hunter): console.error,
    // não console.log — mesmo nível do evento irmão `poll_vote_token_unresolved`
    // logo abaixo (mesma classe "algo está quebrado sob o domínio reservado do
    // token de voto", não ruído esperado tipo `poll_vote_403`). MESMO padrão de
    // bug já corrigido pro domínio irmão `web.eia.diaria.local` (#3976/#4011,
    // guard `isAnonymousWebIdentity` mais abaixo) — só o domínio
    // `vote.eia.diaria.local` (esp="beehiiv") é coberto aqui.
    console.error(JSON.stringify({ event: "poll_vote_token_malformed", edition, email_domain: email.split("@")[1] ?? "unknown" }));
    return voteHtmlResponse(votePageHtml("Link inválido ou expirado.", false, null, null, null, brand), 400);
  }
  if (classification.kind === "valid") {
    const resolvedEmail = await env.POLL.get(pollTokenKvKey(classification.token));
    // Guard defensivo (mesma disciplina de safeParseKv/isValidVoteEmailFormat
    // já aplicada a todo dado lido do KV neste arquivo): um valor ausente,
    // vazio, ou corrompido na entrada reversa (nunca deveria acontecer — só o
    // script de injeção escreve nela — mas KV é dado externo, não confiar
    // cegamente) falha como link inválido, nunca propaga um `email` inválido
    // pro resto da função (que montaria chaves KV malformadas a partir dele).
    if (!resolvedEmail || !isValidVoteEmailFormat(resolvedEmail.toLowerCase().trim())) {
      // #4512 (achado silent-failure-hunter): console.error, não console.log —
      // mesmo nível de "algo está quebrado" dos outros eventos deste arquivo
      // (ex: vote_dedup_do_error), não o nível de ruído-esperado de
      // poll_vote_403. Este branch só é alcançado quando `email` JÁ bate a
      // forma de token válida (`classification.kind === "valid"`) mas a
      // entrada reversa não existe/está corrompida no KV — na prática, o
      // caso real mais comum é um assinante novo ainda não coberto pelo
      // próximo sync incremental de `inject-poll-token-brevo.ts` (#4512, correção
      // de comentário: a versão anterior descrevia isto como "todo voto até
      // a 1ª execução ao vivo", impreciso — um token com custom field
      // vazio/tag não substituída é rejeitado ANTES, pelos guards de
      // formato/merge-tag acima, e nunca chega aqui).
      console.error(JSON.stringify({ event: "poll_vote_token_unresolved", edition, token: classification.token }));
      return voteHtmlResponse(votePageHtml("Link inválido ou expirado.", false, null, null, null, brand), 400);
    }
    email = resolvedEmail.toLowerCase().trim();
  }

  // #4435 (achado pr-test-analyzer do review pré-merge do #4419, espelha o
  // guard de escrita #4157 em handleAdminCorrect/index.ts, e o guard gêmeo
  // de leitura em handleArchiveVotePage/leaderboard-routes.ts):
  // `isValidVoteEditionFormat` acima só valida FORMATO (AAMMDD|ciclo), nunca
  // FORMATO×MARCA. Sem este guard, `GET /vote?...&edition=2605-06&choice=A`
  // (formato de ciclo, #4419) é aceito por QUALQUER brand — inclusive os com
  // `leaderboardPeriod !== "year"` (hoje: diaria/web), que não têm noção de
  // ciclo mensal — gravando `vote:2605-06:{email}`/`score-by-month:2605-06:...`
  // sob um namespace que não deveria existir pra essa marca. O caminho
  // inverso (AAMMDD pra brand anual — marcador legado, ver
  // `legacyMonthlyEditionForCycle`) continua aceito de propósito, só o de
  // ciclo-pra-brand-mensal é bloqueado aqui.
  if (CYCLE_EDITION_RE.test(edition) && BRAND_INFO[brand].leaderboardPeriod !== "year") {
    return voteHtmlResponse(votePageHtml("Link inválido — parâmetros ausentes.", false, null, null, null, brand), 400);
  }

  // #3976: brand "web" usa identidade anônima client-side — token opaco gerado
  // via crypto.randomUUID() (jogar.ts) virando o pseudo-email
  // `{uuid}@web.eia.diaria.local` (anonEmailForToken). O check acima
  // (isValidVoteEmailFormat) só valida a FORMA genérica `local@domínio.tld` —
  // não distingue esse token legítimo de um local-part arbitrário apontando
  // pro mesmo domínio reservado, venha ele de onde vier. Achado #3976:
  // entrada fantasma "verify1840428@web.eia.diaria.local" no leaderboard
  // público — que era um e-mail de TESTE da própria sessão de verificação, e
  // não um bot/scanner externo como o corpo daquela issue registrou
  // (atribuição corrigida pelo editor em 260726; ver comentário no #3976).
  // O guard vale pela SUPERFÍCIE, não pelo incidente: sem ele, qualquer
  // client pode votar com qualquer token e poluir o ranking público.
  //
  // #4011: o #3976 original só aplicava este guard quando `brand === "web"` —
  // um e-mail forjado sob o domínio reservado `@web.eia.diaria.local` era
  // REJEITADO no brand web, mas ACEITO em qualquer outro brand (ex: "diaria",
  // default sem `sig` — modo merge-tag, #1236), gravando score/vote/counted
  // reais lá. Reproduzido ao vivo pelo editor 260724 e purgado manualmente.
  // O domínio `.eia.diaria.local` é RESERVADO pra identidade anônima do jogo
  // web — não tem razão de existir sob nenhum outro brand. Condição agora
  // cobre os dois lados: (a) brand==="web" precisa SEMPRE de um token válido
  // (comportamento pré-existente do #3976, preservado), E (b) qualquer e-mail
  // sob o domínio reservado (`isAnonymousWebIdentity`, #3975 — checagem SÓ de
  // domínio, mais ampla que `isValidWebToken`) exige brand==="web" E token
  // válido, mesmo que o caller tenha passado outro brand. O fluxo legítimo de
  // voto por e-mail arbitrário no brand diária (merge-tag, sem sig) não é
  // afetado — só o domínio reservado do web é bloqueado fora do brand web.
  if ((brand === "web" || isAnonymousWebIdentity(email)) && !isValidWebToken(email)) {
    return voteHtmlResponse(votePageHtml("Link inválido — parâmetros ausentes.", false, null, null, null, brand), 400);
  }

  // #4054: identidade pós-gate — origem PARALELA ao token anônimo, nunca uma
  // substituição do guard acima. O guard já rodou e JÁ EXIGIU um token
  // `isValidWebToken` válido no parâmetro `?email=` (comportamento
  // pré-#4054, intocado) — só DEPOIS disso, se a request carrega um cookie de
  // sessão válido (emitido por `POST /jogar/gate/verify`/`subscribe`,
  // web-gate.ts), a identidade REAL do cookie assume o lugar do token pra
  // todo o resto da função (score/vote/counted/nickname passam a ser
  // gravados sob o e-mail verdadeiro, não o pseudo-email). `?email=` cru
  // continua 100% rejeitado pelo guard acima — não há caminho onde um valor
  // arbitrário de query string vira identidade; só um cookie ASSINADO pelo
  // próprio worker pode fazer isso. `request` é opcional (retrocompat com
  // toda a suíte de teste que já chama `handleVote` sem ele, e com o brand
  // "diaria"/"clarice" onde este bloco nunca roda) — ausente ou sem cookie
  // válido, comportamento 100% igual ao pré-#4054.
  // #4121: só aplica o override quando a sessão é `confirmed` — uma sessão
  // `pending` (cadastro feito no gate, Beehiiv ainda não confirmou o double
  // opt-in) NÃO prova posse do e-mail ainda. Sem essa checagem, o cookie
  // emitido na hora do cadastro (`handleJogarGateSubscribe`, web-gate.ts)
  // bastava pra "roubar" a identidade de qualquer e-mail que o atacante
  // digitasse, sem nunca clicar no link de confirmação (achado #4121).
  if (brand === "web" && request) {
    const session = await readWebSession(rawEnv.COOKIE_HMAC_SECRET, request.headers.get("Cookie"));
    if (session && !session.pending) email = session.email;
  }

  if (!["A", "B"].includes(choice)) {
    return voteHtmlResponse(votePageHtml("Escolha inválida.", false, null, null, null, brand), 400);
  }

  // #1083 / #1086: gate de edições válidas. Se key `valid_editions` setada e
  // edition não estiver no set, rejeita. Vazia/ausente/corrupted → aceita
  // qualquer (compat + fail-open). Corrupted loga console.error.
  //
  // #2018 (nota operacional): a key `clarice:valid_editions` NUNCA foi
  // populada no KV — o brand=clarice opera em fail-open permanente (aceita
  // qualquer edition). Isso é intencional para o ciclo de lançamento: o
  // fluxo mensal não tem pipeline de add-valid-edition.ts análogo ao diário.
  // Se no futuro for necessário restringir o gate: usar scripts/add-valid-edition.ts
  // com --brand clarice, que grava `clarice:valid_editions` via brandedNamespace.
  // Enquanto a key não for populada, parseValidEditions retorna null → fail-open.
  //
  // #2867: `correct:{edition}` já lido AQUI (antes do gate) e reusado mais
  // abaixo (ver "Gravar voto") — evita um 2º get redundante da mesma key.
  // Uma edição com gabarito definido é SEMPRE votável, mesmo fora da janela
  // recente do `valid_editions` (que cobre só os últimos N dias, #1233) — o
  // gabarito só é setado por close-poll.ts (sig HMAC do ADMIN_SECRET) pós-
  // publicação real, um sinal mais forte de "edição válida" que a janela.
  // Sustenta o arquivo retroativo (`/leaderboard/{YYYY}/arquivo`, #2867):
  // sem isso, votos em edições fora da janela de 7 dias voltariam 410 mesmo
  // quando a edição foi de fato publicada e tem poll fechado.
  //
  // #3118 (item 13): `voteKey` (usado mais abaixo pro dedup DO/fallback) é
  // lido AQUI TAMBÉM, em paralelo com os outros 2 gets — os 3 dependem só de
  // email/edition (params de entrada já validados acima), nenhum depende do
  // resultado dos outros nem da verificação de sig (pura, crypto — sem KV).
  // Antes eram 2 gets sequenciais aqui + um 3º get sequencial mais adiante
  // (após o bloco de sig) — 3 RTTs em série no caminho comum. Paralelizados:
  // economiza ~2 RTT por voto no caminho feliz (sig válida, edição válida).
  // Custo aceito: nos caminhos de erro (410 de edição inválida, 403 de sig
  // inválida), `existingFromKv` acaba sendo lido mesmo sem chegar a ser usado
  // — 1 GET a mais, desprezível vs. o ganho no caminho comum (maioria dos votos).
  const voteKey = `vote:${edition}:${email}`;
  // #3600: `correct:{edition}` lido via `rawEnv` (CRU) — gabarito é
  // brand-independente, close-poll.ts nunca grava a chave prefixada por
  // brand. `valid_editions` (branded, ex: `web:valid_editions`) e `voteKey`
  // continuam via `env` (branded) — só o gabarito muda de namespace.
  const [correctRaw, validEditionsRaw, existingFromKv] = await Promise.all([
    rawEnv.POLL.get(`correct:${edition}`),
    env.POLL.get("valid_editions"),
    env.POLL.get(voteKey),
  ]);
  const validSet = parseValidEditions(validEditionsRaw);
  if (!isValidEdition(validSet, edition) && correctRaw === null) {
    // #6902 (2º problema, mesmo arquivo): este caminho é a edição EXPIRADA/
    // nunca-existente (gabarito nunca setado) — a votação de fato FECHOU.
    // "Não aceita mais votos" está correto aqui.
    return voteHtmlResponse(votePageHtml("Essa edição não aceita mais votos.", false, null, null, null, brand), 410);
  }

  // #3113 (item 9): o gate acima só rejeita quando `correctRaw` é null — mas
  // `correct:{edition}` é setado ANTES do e-mail sair (prep de imagens/revisão,
  // #2867), então uma edição AAMMDD futura com gabarito já definido passava
  // aqui direto. `extractEditionsForYear` (listagem do arquivo) e
  // `handleArchiveVotePage` (página de voto do arquivo) já fecham essa brecha
  // pra LEITURA — mas o `/vote` que de fato REGISTRA o voto continuava aberto
  // via URL direta (email+edition+choice montados manualmente, sem passar
  // pela página do arquivo). Só se aplica ao formato diário AAMMDD — o ciclo
  // mensal da Clarice (`YYMM-MM`) não tem um "dia" real pra comparar (mesma
  // exceção documentada acima pra `clarice:valid_editions`).
  //
  // #3384: contas de teste do editor (TEST_ACCOUNT_EMAILS) ignoram este gate —
  // precisam votar no e-mail de teste do Stage 5, rodado na véspera, quando a
  // edição ainda é "de amanhã".
  if (AAMMDD_RE.test(edition) && edition > todayAammddBrt(new Date()) && !TEST_ACCOUNT_EMAILS.has(email)) {
    // #6902 (2º problema, mesmo arquivo): este caminho é a edição FUTURA — ainda
    // não enviada, a votação NÃO abriu. A mensagem "não aceita MAIS votos"
    // (usada no return de cima, pra edição expirada) é o oposto do que é verdade
    // aqui: o leitor/testador lê "perdeu a janela" quando na verdade ela nem
    // começou. Mensagem distinta pra não confundir.
    return voteHtmlResponse(votePageHtml("Essa edição ainda não foi enviada — volte quando ela chegar na sua caixa de entrada.", false, null, null, null, brand), 410);
  }

  // #1083: sig agora pode ser email-only (permanente) OU email:edition (legacy).
  // Tenta novo formato primeiro; fallback pro legacy. Ausente = merge-tag mode.
  if (sig !== null) {
    const newValid = await hmacVerify(env.POLL_SECRET, email, sig);
    const legacyValid = newValid
      ? true
      : await hmacVerify(env.POLL_SECRET, `${email}:${edition}`, sig);
    if (!newValid && !legacyValid) {
      // #1468: log estruturado pra distinguir sig_empty (subscriber sem
      // poll_sig populado — cenário do #1186) de sig_invalid (HMAC mismatch).
      // Cloudflare Logs filtra por reason. email_domain só pra detectar
      // bot/spam pattern, evita vazar PII completa em log retention.
      const reason = classify403Reason(sig);
      console.log(JSON.stringify({
        event: "poll_vote_403",
        reason,
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
      }));
      return voteHtmlResponse(votePageHtml("Link inválido ou expirado.", false, null, null, null, brand), 403);
    }
  }

  // #3983: fast-path — ver doc de handleVote acima pro rationale completo do
  // guard. Todos os gates acima (formato, merge-tag, edição válida, edição
  // futura, sig) já rodaram — a partir daqui o resto é só "gravar o voto",
  // que é exatamente a parte que o fast-path adia pra background.
  if (ctx && typeof ctx.waitUntil === "function") {
    return handleVoteFastPath(env, brand, ctx, {
      email,
      edition,
      choice: choice as "A" | "B",
      correctRaw,
      existingFromKv,
      testMode,
    }, rawEnv);
  }

  // ── Caminho síncrono legado (sem ExecutionContext real) ───────────────────
  // #3983: código INTOCADO a partir daqui — preserva 100% do comportamento e
  // da suíte de testes pré-existente (nenhum teste hoje passa um `ctx` com
  // `waitUntil` de verdade). Só roda em produção se o Workers runtime, por
  // algum motivo, não injetar um ExecutionContext (não deveria acontecer).

  // #2187: Serializar o dedup via Durable Object (fortemente consistente).
  // O DO elimina a race read-modify-write que o KV eventual-consistent expunha:
  // dois requests concorrentes do mesmo email agora são processados em série
  // dentro do mesmo DO — o 2º vê o estado do 1º e é rejeitado como duplicado.
  //
  // Compat/migration: o KV `vote:{edition}:{email}` (`voteKey`/`existingFromKv`,
  // já lidos acima em paralelo com os outros gates — #3118 item 13) é
  // verificado ANTES da chamada ao DO, pra detectar votos legados (gravados
  // antes do deploy do DO). Se o KV tem o voto, passamos o header
  // X-KV-Vote-Exists: "1" para o DO inicializar seu estado interno como
  // "voted=true" (sincroniza o estado DO com o legado KV).
  //
  // Fallback gracioso: se VOTE_DEDUP não estiver configurado (ex: testes sem
  // binding DO), cai no comportamento anterior (leitura direta do KV).

  // P2-13: içar doStub para escopo compartilhado (usado em authorize + /confirm).
  // Evita dois idFromName/get duplicados (um aqui e outro na fase /confirm abaixo).
  let doStub: DurableObjectStub | null = null;

  if (env.VOTE_DEDUP) {
    // Caminho serializado via DO (#2187)
    // Brand prefixado no nome do DO para isolar por brand: dois votos do mesmo
    // edition:email em brands distintos (diaria vs clarice) não colidiriam no
    // mesmo DO (que resultaria em silêncio do 2º brand quando o 1º já votou).
    // Formato: `{brand}:{edition}:{email}` — brand sempre presente (default "diaria").
    const doId = env.VOTE_DEDUP.idFromName(`${brand}:${edition}:${email}`);
    doStub = env.VOTE_DEDUP.get(doId);
    const doHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (existingFromKv !== null) {
      // Sinaliza ao DO que o KV legacy ja tem este voto.
      doHeaders["X-KV-Vote-Exists"] = "1";
      // #2229 item 3: voteKey existe = ou legado ou todas escritas KV desta sessao
      // sucederam (incluindo voteKey) mas /confirm falhou. O DO reconcilia
      // pending->voted dentro do bloco pending-fresco (sem re-auth/re-incremento).
      doHeaders["X-KV-VoteKey-Committed"] = "1";
    }
    // #1236 fix: ?test=1 NÃO deve queimar o slot do DO. Short-circuit ANTES
    // de chamar o DO — request de teste não persiste estado de "voted".
    if (testMode) {
      // Pular DO inteiramente em test mode; seguirá para o testMode check abaixo.
    } else {
    // #2220: single retry antes do fail-open — reduz a janela de double-vote
    // sob erro transiente do DO (5xx/timeout) sem introduzir latência significativa
    // em produção (apenas 1 retry, sem backoff). Trade-off documentado:
    //   - fail-open (continua como firstVote=true em erro do DO) prioriza
    //     disponibilidade sobre integridade exata — melhor duplicar raramente
    //     do que bloquear votante legítimo permanentemente.
    //   - Dois requests concorrentes que AMBOS pegam erro do DO (após retry)
    //     caem como firstVote=true e ambos incrementam. Esta janela é estreita
    //     (requer falha simultânea do DO em dois requests do mesmo email) e é
    //     preferível ao bloqueio permanente de votante legítimo.
    //   - Em caso de erro persistente do DO, o monitoramento deve ser acionado
    //     via logs `vote_dedup_do_error` (event abaixo).
    //
    // #2231 (decisão do editor, briefing 260613c): MANTER fail-open.
    // Sob erro do DO, o voto PASSA (não bloqueia votante legítimo). Raro double-count
    // sob falha simultânea do DO (ambos os requests pegam 5xx após retry) é o trade-off
    // aceito: prioriza não perder voto legítimo. Sem mudança de comportamento — apenas
    // documentado aqui para rastreabilidade da decisão de design.
    //
    // P1-3: envolver em try/catch — doStub.fetch() pode LANÇAR (timeout de rede,
    // DO não disponível), não só retornar !ok. Exceção aciona o mesmo fail-open.
    //
    // P2-10: retry APENAS em status >= 500 (erro transitório). 4xx (ex: 405 Method
    // Not Allowed) são erros permanentes — retry não ajuda e mascara o problema.
    let doResp: Response | null = null;
    let doError: unknown = null;
    try {
      doResp = await doStub.fetch("https://internal/vote-dedup", {
        method: "POST",
        headers: doHeaders,
        // body: payload interno — reservado para validação futura pelo DO;
        // atualmente o DO não lê o body (decisão baseada só no estado stored + header).
      });
      if (doResp.status >= 500) {
        // Retry único antes de fail-open (apenas erros transitórios 5xx)
        try {
          doResp = await doStub.fetch("https://internal/vote-dedup", {
            method: "POST",
            headers: doHeaders,
          });
        } catch (retryErr) {
          doError = retryErr;
          doResp = null;
        }
      }
    } catch (e) {
      doError = e;
      doResp = null;
    }

    if (doResp === null || doResp.status >= 500) {
      console.error(JSON.stringify({
        event: "vote_dedup_do_error",
        status: doResp?.status ?? "exception",
        error: doError !== null ? String(doError) : undefined,
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
      }));
      // fail-open (#2231): continua como firstVote=true após retry.
      // Decisão de design documentada no bloco #2220/#2231 acima — voto não é
      // bloqueado mesmo com DO indisponível. Raro double-count sob falha simultânea
      // do DO é o trade-off aceito (ver issue #2231 para rastreabilidade).
      // P2-6: neste caminho (DO errou), NÃO chamar /confirm — o voto NÃO foi
      // autorizado pelo DO, então não há pending a confirmar.
      doStub = null; // sinaliza "não chamar /confirm" abaixo
    } else {
    // Fix #1: doResp.json() envolto em try/catch — resposta malformada do DO
    // (ex: truncada por timeout) não crasha handleVote. Falha de parse é tratada
    // como erro do DO (fail-open documentado, igual ao caminho 5xx acima).
    let firstVote: boolean;
    try {
      const parsed = await doResp.json() as { firstVote: boolean };
      firstVote = parsed.firstVote;
    } catch (parseErr) {
      console.error(JSON.stringify({
        event: "vote_dedup_do_parse_error",
        error: String(parseErr),
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
      }));
      // fail-open: resposta malformada do DO é tratada como erro transitório.
      // NÃO chama /confirm (doStub nulificado) — não há pending a confirmar.
      doStub = null; // sinaliza "não chamar /confirm" abaixo
      firstVote = true; // autoriza o voto (fail-open)
    }

    if (!firstVote) {
      // Duplicado detectado pelo DO — servir página "já votou" (#3118 item 10:
      // extraído pra buildAlreadyVotedResponse, compartilhado com o fallback KV).
      return buildAlreadyVotedResponse(env, brand, edition, email, existingFromKv, correctRaw, rawEnv);
    }
    // firstVote === true → DO autorizou o voto; prosseguir com gravação normal abaixo.
    } // fim if (doResp === null || doResp.status >= 500) ... else
    } // fim if (testMode) ... else
  } else {
    // Fallback: sem VOTE_DEDUP binding (ex: testes legados) — comportamento anterior via KV.
    // ATENÇÃO: este caminho mantém a race condition original (#2187). Só usado em ambientes
    // sem o binding DO (testes Node sem miniflare). Em produção, VOTE_DEDUP sempre presente.
    if (existingFromKv) {
      // #3118 item 10: mesmo helper do caminho DO acima — antes eram ~20 linhas
      // quase idênticas que já haviam divergido uma vez no passado (#2189
      // corrigiu só um dos dois ramos, deixando o outro com nicknameForm
      // hardcoded null por um tempo).
      return buildAlreadyVotedResponse(env, brand, edition, email, existingFromKv, correctRaw, rawEnv);
    }
  }

  // Gravar voto
  // #2867: correctRaw já lido no gate de valid_editions acima — reusado aqui.
  const correct = correctRaw ? choice === correctRaw : null;

  // #2189 / #2190: ler score:${email} ANTES do put(voteKey).
  // Razão #2189: se a leitura posterior lançasse, o voto já gravado deixava o
  // votante no branch "já votou" com nicknameForm=null (inacessível). Lendo
  // antes, qualquer exceção acontece ANTES do commit — retry chega no caminho
  // normal do vote.
  // Razão #2190: essa leitura é reutilizada abaixo para updateScore (que faria
  // um get redundante). Ler uma vez aqui evita re-leitura no updateScore.
  const scoreRaw = await env.POLL.get(`score:${email}`);
  // #3298 (mais severo do lote — achado de code-review consolidado overnight
  // 260711): JSON.parse desguardado aqui derrubava o VOTO NOVO inteiro com 500
  // ANTES de qualquer escrita KV (guard-keys, voteKey, /confirm) — um
  // score:{email} corrompido deixava o leitor em retry permanente até
  // intervenção manual (nenhum caminho de sucesso possível: o crash acontece
  // sempre, em todo retry, porque score:{email} nunca é reescrito até o voto
  // completar). Mesma classe de bug já corrigida em buildAlreadyVotedResponse
  // (#3118 item 4 / #3278); scoreObj só é lido pra checar `nickname` mais
  // abaixo — corrompido é tratado como "sem nickname" (mesmo fallback de
  // score:{email} nunca ter sido gravado).
  const scoreObj = safeParseKv<{ nickname?: string | null; optin?: boolean }>(scoreRaw, "vote_score_parse_error", edition);

  // #1236: test mode — short-circuit antes de qualquer KV write. Mantém
  // validação completa (gate, sig, dedup) acima pra que o test reflita
  // request real. Resposta indica claramente que não foi gravado.
  if (testMode) {
    const testMsg = correct === true
      ? "✅ [TEST] Acertou! Era a imagem gerada por IA. (não gravado em KV)"
      : correct === false
      ? "❌ [TEST] Não foi dessa vez, era a foto real. (não gravado em KV)"
      : "[TEST] Voto recebido. (não gravado em KV — gabarito ainda não definido)";
    return voteHtmlResponse(votePageHtml(testMsg, true, null, null, null, brand), 200);
  }

  // #1657: timestamp único reusado no voteKey + no vote-log (mesma fonte).
  const voteTs = new Date().toISOString();

  // #2229: Incrementos IDEMPOTENTES por (edition,email).
  //
  // INVARIANTE CENTRAL: cada um dos 3 incrementos (stats, score, score-by-month)
  // roda AT MOST 1x por (edition,email), mesmo em retries apos falha parcial.
  //
  // Mecanismo: guard-keys KV `counted:{edition}:{email}:stats|score|month`.
  // Antes de cada incremento, checa o guard. Se presente = ja executado (skip).
  // Apos incremento bem-sucedido, escreve o guard imediatamente.
  // Em retry apos pending expirar: DO re-autoriza (firstVote:true), worker ve
  // guards presentes e pula os ja executados — zero double-count.
  //
  // Por que nao usar so o voteKey como guard?
  // O voteKey e gravado por ULTIMO (commit definitivo). Se um incremento falha
  // antes do voteKey ser escrito, o retry nao ve o voteKey e re-executaria TUDO.
  // Os guard-keys por incremento permitem completar apenas os incrementos faltantes.
  //
  // #2220 commit em 2 fases:
  //   Fase 1: DO autoriza (pending). Fase 2: Worker escreve KV, chama /confirm.
  //   Se escrita KV falha, /confirm nao e chamado. Pending expira em 5min, retry re-autoriza.
  //   Com guard-keys: retry completa so os incrementos faltantes. Sem double-count.
  //
  // #8: score e score-by-month sao chaves KV independentes — paralelizaveis sem
  // read-after-write entre eles (mantido nesta implementacao via Promise.all).

  const statsGuardKey = `counted:${edition}:${email}:stats`;
  const scoreGuardKey = `counted:${edition}:${email}:score`;
  const monthGuardKey = `counted:${edition}:${email}:month`;

  // Stats — idempotente via guard-key
  //
  // JANELA RESIDUAL ESTREITA (#2229): há uma janela entre o incremento e a
  // escrita do guard-key — um crash ENTRE os dois deixaria o guard não-gravado,
  // e um retry posterior re-incrementaria. Esta janela é MUITO menor do que o
  // bug original (que re-incrementava em TODO retry sem qualquer guard). KV não
  // é transacional; mover o guard para ANTES não funcionaria (bloquearia um
  // incremento que ainda não aconteceu). A ordem correta é incremento→guard;
  // o risco é crash no exato μs entre os dois, que é raríssimo em produção.
  // Documentado como residual conhecido e aceitável.
  //
  // FAIL-OPEN DOUBLE-COUNT STATS (#2245, estende #2231):
  // Este guard-key é verificado via KV.get FORA da serialização do DO (VoteDedup).
  // No caminho normal, o VoteDedup garante que apenas um request por email passa
  // por aqui (firstVote:true). Porém, no fail-open (DO com erro 5xx após retry),
  // doStub é nulificado e AMBOS os requests concorrentes caem como firstVote:true.
  // Se ambos chegarem aqui com guard-key ausente (janela antes do primeiro put),
  // ambos passarão pelo null-check e ambos chamarão updateStatsCounter → double-count.
  // Esta é consequência DIRETA do fail-open aceito em #2231 (decisão do editor):
  // prioriza não perder voto legítimo sob falha do DO, aceitando raro double-count.
  // Mover este check para dentro da serialização do DO resolveria a janela, mas
  // mudaria a semântica do fail-open — alteração deliberadamente rejeitada em #2231.
  // Documentado aqui como extensão do residual aceito. Monitorar via event
  // `vote_dedup_do_error` nos logs para detectar frequência de fail-open em produção.
  if (!(await env.POLL.get(statsGuardKey))) {
    await updateStatsCounter(env, edition, choice as "A" | "B", correct, brand);
    await env.POLL.put(statsGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
  }

  // Score e score-by-month — idempotentes via guard-keys individuais.
  // #1080: sempre atualizar score, mesmo sem gabarito ainda.
  // #2190: passa scoreRaw ja lido acima (evita re-leitura redundante).
  // #1345: score-by-month indexado pela publication date da edicao.
  // #8 / Efficiency: score + month + stats (já guarded acima) são independentes
  // entre si — score e month não têm read-after-write um sobre o outro, e ambos
  // usam scoreRaw já lido. Promise.all paralleliza as 2 IIFE sem risco de
  // dependência. (Stats já foi processado acima, antes deste bloco, por precisar
  // de sua própria janela de documentação residual — separação deliberada.)
  await Promise.all([
    (async () => {
      if (!(await env.POLL.get(scoreGuardKey))) {
        await updateScore(env, email, edition, correct, scoreRaw, brand); // #3522: brand p/ cadência do streak
        await env.POLL.put(scoreGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
      }
    })(),
    (async () => {
      if (!(await env.POLL.get(monthGuardKey))) {
        // #4169: brand p/ id do DO ScoreCounter (`{brand}:{email}`).
        await updateScoreByMonth(env, email, edition, correct, scoreRaw, brand);
        await env.POLL.put(monthGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
      }
    })(),
  ]);

  // Commit definitivo do voto no KV — marca o voto como totalmente processado.
  // Gravado por ULTIMO para que retries intermediarios (pendente expirado) possam
  // completar os incrementos faltantes via guard-keys.
  // Quando voteKey ja existe (retry apos /confirm falho), o worker passa
  // X-KV-VoteKey-Committed:1 ao DO, que reconcilia pending->voted (#2229 item 3).
  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: voteTs, correct }));

  // #2220 fase 2: confirmar para o DO que as escritas KV completaram.
  // Transiciona o estado DO de pending→voted definitivamente.
  //
  // P2-6: só chamar /confirm quando o DO autorizou o voto (doStub !== null).
  //   doStub é nulificado no path fail-open — não há pending a confirmar.
  //
  // P2-7: retry único no /confirm (paridade com authorize). Falha transiente
  //   não deve deixar pending órfão com KV correto.
  //
  // Secundário: try/catch para nunca quebrar o fluxo de resposta ao votante;
  // em caso de falha persistente, o DO ficará em `pending=true` — estado stale
  // expirado em PENDING_TTL_MS (5 min) permitindo retry pelo votante.
  if (doStub !== null) {
    try {
      let confirmResp = await doStub.fetch("https://internal/confirm", { method: "POST" });
      if (confirmResp.status >= 500) {
        // Retry único em erro transitório
        try {
          confirmResp = await doStub.fetch("https://internal/confirm", { method: "POST" });
        } catch (retryErr) {
          console.error(JSON.stringify({ event: "vote_dedup_confirm_retry_failed", edition, error: String(retryErr) }));
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_dedup_confirm_failed", edition, error: String(e) }));
    }
  }

  // #1657: log de voto pra analytics. SECUNDÁRIO — try/catch pra nunca quebrar
  // o voto do leitor se a escrita do log falhar. Só roda em voto novo (dup
  // retorna acima; test mode short-circuita antes do put).
  try {
    await recordVoteLog(env, email, edition, choice as "A" | "B", correct, voteTs);
  } catch (e) {
    console.error(JSON.stringify({ event: "vote_log_failed", edition, error: String(e) }));
  }

  // #3522: streak pra exibição na mensagem pós-voto ("🔥 N dias seguidos
  // acertando!"). Lido do KV DEPOIS dos incrementos acima — cobre tanto o
  // caminho de voto novo (guard-key acabou de gravar) quanto um retry onde o
  // guard já existia (updateScore sequer foi chamado nesta invocação) sem
  // duplicar a lógica de cálculo de streak aqui (mesma disciplina de reuso
  // que scoreObj/prevScoreObj já seguem no resto deste arquivo). Só lido
  // quando correct===true — é a única transição em que `updateScore` pode
  // ter incrementado o streak (correct null/false não o alteram além do
  // reset-pra-0, que não precisa de leitura extra pra decidir "sem sufixo").
  let streakForDisplay: number | null = null;
  if (correct === true) {
    const freshScoreRaw = await env.POLL.get(`score:${email}`);
    const freshScore = safeParseKv<{ streak?: number }>(freshScoreRaw, "vote_streak_display_parse_error", edition);
    streakForDisplay = freshScore?.streak ?? null;
  }

  // #3523: "X% acertaram este par" — sufixo agregado (social proof), exibido
  // SÓ pós-voto (anti-spoiler). O gate `correct !== null` é o MESMO usado por
  // `showImages`/`resultImages` mais abaixo — o gabarito só existe quando a
  // edição já foi fechada (`correct:{edition}` setado pelo close-poll), então
  // pré-voto (correct === null) nunca chega aqui e a % nunca vaza antes do
  // reveal. `getSummedEditionStats` já inclui o voto ATUAL (o incremento via
  // `updateStatsCounter`/guard-key `stats` já rodou acima, antes deste ponto).
  // Fail-soft (try/catch): uma falha aqui (DO indisponível além do retry
  // interno de `fetchEditionStatsAndCorrect`, KV lançando, etc.) NUNCA deve
  // derrubar o voto já commitado — pior caso é a mensagem sem o sufixo de %,
  // igual ao comportamento de amostra abaixo do mínimo (`renderStatsSuffix`
  // já retorna "" nesse caso).
  let statsSuffix = "";
  if (correct !== null) {
    try {
      const { stats } = await getSummedEditionStats(env, brand, edition);
      statsSuffix = renderStatsSuffix(stats);
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_stats_suffix_fetch_failed", edition, error: String(e) }));
      // statsSuffix permanece "" — mesmo fallback de amostra pequena.
    }
  }

  // #3984: descrição + crédito da foto real, lidos de `eiameta:{edition}`
  // (KV COMPARTILHADO via `rawEnv`, brand-independente — mesmo racional de
  // `correctRaw` acima, #3600). Anti-spoiler: só lido quando `correct !== null`
  // (gabarito já fechado) — mesmo gate de `showImages`/`statsSuffix` logo
  // abaixo/acima. Fail-soft: qualquer falha vira `eiaMeta = null` (o bloco
  // simplesmente não renderiza, ver renderEiaMetaHtml em index.ts).
  let eiaMeta: { description: string; credit: string } | null = null;
  if (correct !== null) {
    try {
      const eiaMetaRaw = await rawEnv.POLL.get(`eiameta:${edition}`);
      const parsed = safeParseKv<{ description?: string; credit?: string }>(eiaMetaRaw, "vote_eiameta_parse_error", edition);
      if (parsed && (parsed.description || parsed.credit)) {
        eiaMeta = { description: parsed.description ?? "", credit: parsed.credit ?? "" };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_eiameta_fetch_failed", edition, error: String(e) }));
      // eiaMeta permanece null — fallback silencioso (bloco não renderiza).
    }
  }

  const msg = correct === true
    ? `✅ Acertou! Era a imagem gerada por IA.${renderStreakSuffix(streakForDisplay, brand)}${statsSuffix}`
    : correct === false
    ? `❌ Não foi dessa vez, era a foto real.${statsSuffix}`
    : "Voto registrado! O resultado sai na próxima edição.";

  // #1078 — primeiro voto: oferecer nickname pra leaderboard. scoreObj já foi
  // lido antes do put (ver #2189/#2190 acima) — reusar sem nova leitura.
  // #4418: Caixa A (nickname) / Caixa B (subscribe, clarice sem opt-in) /
  // nenhuma — ver resolveVoteIdentityBoxKind (lib.ts).
  let nicknameForm: { email: string; sig: string } | null = null;
  let subscribeBox: SubscribeBoxState | null = null;
  const boxKind = resolveVoteIdentityBoxKind(scoreObj, brand);
  if (boxKind !== "none") {
    const sig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    if (boxKind === "nickname") {
      nicknameForm = { email, sig };
    } else {
      subscribeBox = { email, sig, nickname: scoreObj!.nickname! };
    }
  }

  // #1351: mostrar as duas imagens (A e B) na página de resultado.
  // Highlight da que o leitor clicou + label "🤖 IA" e "📷 Real" pra que é
  // qual. Só aparece quando temos gabarito (correct ∈ {true, false}).
  // Sem gabarito (correct === null), pular — leitor verá só msg.
  const showImages = correct !== null;
  // correctRaw armazena qual lado é IA — usar direto.
  const aiSide: "A" | "B" | null = showImages && correctRaw
    ? (correctRaw as "A" | "B")
    : null;
  const resultImages = showImages && aiSide
    ? {
        edition,
        aiSide,
        clickedSide: choice as "A" | "B",
      }
    : null;

  // #3517 / #4065: card de compartilhamento — TODOS os brands (antes só
  // brand="web"). A premissa original ("diaria/clarice são e-mail
  // assinantes, 'compartilhar meu resultado' não se aplica") estava errada
  // pros dois: a base clarice NÃO é assinante da diar.ia.br — é justamente o
  // público que a parceria existe pra converter (a issue #4065 documenta
  // 101.000 envios do ciclo 2606-07 gerando 13 assinantes e ZERO resgates de
  // cupom, com o jogo terminando em beco sem saída); e diaria, mesmo já
  // assinante, pode indicar (loop de indicação). O link compartilhado
  // (`/share/{token}`) já é brand-agnóstico — sempre renderiza `brand="web"`
  // e aponta pro `/jogar` público (#3701, share.ts), então nenhuma mudança é
  // necessária ali: quem recebe o link cai direto no jogo público, onde o
  // cadastro inline vive. Token é puro HMAC sobre {edition, correct} — ZERO
  // leitura KV extra, nenhuma mudança no resto do fluxo de voto acima (dedup,
  // guard-keys, DO).
  const sharePayload: SharePayload = { edition, correct };
  const shareCard: { token: string; payload: SharePayload } = {
    token: await encodeShareToken(env.POLL_SECRET, sharePayload),
    payload: sharePayload,
  };

  // #2113(a): passa voteTs como cache-buster pra quebrar cache do navegador no link
  // "Ver leaderboard" — leitor que viu a página de leaderboard antes de votar não
  // fica com a versão vazia em cache. SÓ neste link (tráfego orgânico inalterado).
  return voteHtmlResponse(votePageHtml(msg, true, nicknameForm, resultImages, editionToMonthSlug(edition), brand, voteTs, shareCard, eiaMeta, subscribeBox, brand === "clarice"), 200);
}

// ── #3983: fast-path (reverte o Suspense #3595 + reavaliação do cômputo do
// voto pedida pelo editor 260723) ───────────────────────────────────────────
//
// Contexto completo: até aqui (#3595), a sequência web escondia a latência
// do /vote avançando pro próximo par IMEDIATAMENTE e votando em BACKGROUND —
// o resultado por rodada nunca era revelado, só o placar final. O editor
// (260723) pediu o oposto: revelar acerto/erro NA HORA do clique. Isso torna
// a latência do /vote user-facing de novo — então esta seção move a
// CONTABILIDADE (dedup DO, guard-keys de stats/score/month, commit do
// voteKey, log) pra `ctx.waitUntil()`, respondendo o veredito assim que
// `correct:{edition}` é conhecido (já lido antes de chegar aqui).
//
// Sub-issue #3983 é anti-cheat-first: o gabarito NUNCA é embutido no
// HTML/JS antes do clique (isso continua vindo só da resposta do /vote,
// como sempre) — só a CONTABILIDADE do voto que muda de timing, não o que é
// exposto ao cliente nem quando.

/**
 * #3983: resposta RÁPIDA do `/vote` — usada quando `ctx` (ExecutionContext
 * real) está disponível. Responde o veredito (acertou/errou/"sem gabarito
 * ainda") sem esperar nenhuma escrita KV/DO: `correct` já é derivável de
 * `correctRaw` (lido antes desta chamada, no `Promise.all` de `handleVote`).
 *
 * Trade-off deliberado (documentado pro PR/coordenador): o sufixo de streak
 * (#3522, "🔥 N dias seguidos") e o sufixo de stats (#3523, "X% acertaram")
 * NÃO aparecem nesta resposta — ambos só fazem sentido calculados DEPOIS do
 * incremento desta rodada, que só acontece em `runVoteBookkeeping` (background).
 * Computá-los de forma otimista aqui exigiria ou (a) pagar de volta um
 * round-trip de rede antes de responder — anulando o ganho de latência que
 * esta issue existe pra entregar — ou (b) duplicar a lógica de streak de
 * `updateScore` numa 2ª implementação "preview", só pra um sufixo cosmético
 * secundário. Nenhuma das duas se paga: o dado ESSENCIAL da issue #3983
 * (acertou/errou, correto e imediato) sai perfeito; os sufixos voltam a
 * aparecer no PRÓXIMO voto do jogador (quando o score já estiver persistido).
 *
 * nicknameForm/resultImages/shareCard SEGUEM presentes (não dependem de
 * nenhuma escrita desta rodada, só de estado JÁ existente/dos parâmetros do
 * próprio request) — nenhuma perda de funcionalidade ali.
 */
async function handleVoteFastPath(
  env: Env,
  brand: Brand,
  ctx: ExecutionContext,
  params: {
    email: string;
    edition: string;
    choice: "A" | "B";
    correctRaw: string | null;
    existingFromKv: string | null;
    testMode: boolean;
  },
  /** #3984: env CRU (não branded) — lê `eiameta:{edition}` compartilhado,
   * mesmo racional de `correctRaw` (já lido via rawEnv em handleVote antes
   * do fast-path ser despachado, #3600). Default `= env` preserva chamadas
   * de teste/legadas que não passam este argumento (equivalente a
   * brand="diaria", onde `bEnv === env` de qualquer forma). */
  rawEnv: Env = env,
): Promise<Response> {
  const { email, edition, choice, correctRaw, existingFromKv, testMode } = params;

  // #3983 cuidado (a) — resposta otimista vs. dedup: um voto que o KV JÁ
  // conhece (re-clique no mesmo link/re-tentativa) segue mostrando "já
  // votou" de forma síncrona — isso é uma leitura KV já feita (barata, sem
  // round-trip de DO), não a contabilidade pesada que o fast-path adia. A
  // corrida de DOIS requests CONCORRENTES do mesmo email (nenhum viu o KV do
  // outro ainda) é o caso que realmente cai no fast-path otimista: ambos
  // respondem o veredito, e o dedup real (DO) em background descarta
  // silenciosamente o 2º (`runVoteBookkeeping`, ver `!firstVote` abaixo) —
  // o veredito já mostrado ao 2º jogador continua correto (ele realmente
  // acertou/errou aquela rodada), só não soma no score. Comportamento
  // intencional, pedido explicitamente pelo editor na issue #3983.
  if (existingFromKv) {
    return buildAlreadyVotedResponse(env, brand, edition, email, existingFromKv, correctRaw, rawEnv);
  }

  const correct = correctRaw ? choice === correctRaw : null;

  // #1236: test mode — short-circuit antes de qualquer KV write/schedule,
  // mesmo comportamento/mensagem do caminho legado.
  if (testMode) {
    const testMsg = correct === true
      ? "✅ [TEST] Acertou! Era a imagem gerada por IA. (não gravado em KV)"
      : correct === false
      ? "❌ [TEST] Não foi dessa vez, era a foto real. (não gravado em KV)"
      : "[TEST] Voto recebido. (não gravado em KV — gabarito ainda não definido)";
    return voteHtmlResponse(votePageHtml(testMsg, true, null, null, null, brand), 200);
  }

  const voteTs = new Date().toISOString();
  const scoreRaw = await env.POLL.get(`score:${email}`);
  const scoreObj = safeParseKv<{ nickname?: string | null; optin?: boolean }>(scoreRaw, "vote_fastpath_score_parse_error", edition);

  // #1078: mesmo critério do caminho legado — oferecer nickname enquanto o
  // jogador não tiver um. Não depende de nenhuma escrita desta rodada.
  // #4418: Caixa A / Caixa B / nenhuma — mesmo critério do caminho legado
  // (resolveVoteIdentityBoxKind, lib.ts).
  let nicknameForm: { email: string; sig: string } | null = null;
  let subscribeBox: SubscribeBoxState | null = null;
  const boxKind = resolveVoteIdentityBoxKind(scoreObj, brand);
  if (boxKind !== "none") {
    const sig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    if (boxKind === "nickname") {
      nicknameForm = { email, sig };
    } else {
      subscribeBox = { email, sig, nickname: scoreObj!.nickname! };
    }
  }

  // #1351: mesmo critério do caminho legado — mostrar as 2 imagens com
  // highlight só quando o gabarito existe.
  const showImages = correct !== null;
  const aiSide: "A" | "B" | null = showImages && correctRaw ? (correctRaw as "A" | "B") : null;
  const resultImages = showImages && aiSide
    ? { edition, aiSide, clickedSide: choice }
    : null;

  // #3517 / #4065: card de compartilhamento — TODOS os brands, mesmo
  // critério do caminho legado (ver rationale completo acima em handleVote:
  // payload é puro HMAC sobre {edition, correct}, zero KV extra).
  const sharePayloadFast: SharePayload = { edition, correct };
  const shareCard: { token: string; payload: SharePayload } = {
    token: await encodeShareToken(env.POLL_SECRET, sharePayloadFast),
    payload: sharePayloadFast,
  };

  // #3984: mesmo fetch condicional do caminho legado (rawEnv, CRU) — o
  // gabarito já é conhecido síncrona/imediatamente aqui (`correctRaw` veio do
  // Promise.all original em handleVote), então o custo é só 1 GET extra no
  // fast-path, sem esperar a contabilidade em background.
  let eiaMeta: { description: string; credit: string } | null = null;
  if (correct !== null) {
    try {
      const eiaMetaRaw = await rawEnv.POLL.get(`eiameta:${edition}`);
      const parsed = safeParseKv<{ description?: string; credit?: string }>(eiaMetaRaw, "vote_fastpath_eiameta_parse_error", edition);
      if (parsed && (parsed.description || parsed.credit)) {
        eiaMeta = { description: parsed.description ?? "", credit: parsed.credit ?? "" };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_fastpath_eiameta_fetch_failed", edition, error: String(e) }));
    }
  }

  const msg = correct === true
    ? "✅ Acertou! Era a imagem gerada por IA."
    : correct === false
    ? "❌ Não foi dessa vez, era a foto real."
    : "Voto registrado! O resultado sai na próxima edição.";

  const response = voteHtmlResponse(
    votePageHtml(msg, true, nicknameForm, resultImages, editionToMonthSlug(edition), brand, voteTs, shareCard, eiaMeta, subscribeBox, brand === "clarice"),
    200,
  );

  // #3983 cuidado (b): falha do waitUntil = voto perdido silenciosamente (do
  // ponto de vista da contabilidade — o veredito já mostrado ao jogador
  // continua correto). Isso NÃO é uma regressão: uma falha síncrona no
  // caminho legado também perdia o voto (500 pro jogador, retry manual). A
  // diferença aqui é só que a falha acontece depois da resposta já ter sido
  // enviada — por isso o log é essencial (única forma de visibilidade).
  ctx.waitUntil(
    runVoteBookkeeping(env, brand, edition, email, choice, correct, scoreRaw, voteTs).catch((e) => {
      console.error(JSON.stringify({
        event: "vote_bookkeeping_failed",
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
        error: String(e),
      }));
    }),
  );

  return response;
}

/**
 * #3983: contabilidade completa do voto — dedup via DO (autoriza + confirma),
 * guard-keys de stats/score/score-by-month, commit definitivo do `voteKey`,
 * vote-log. Roda em `ctx.waitUntil()` (nunca bloqueia a resposta ao jogador,
 * ver `handleVoteFastPath` acima).
 *
 * Espelha ponto-a-ponto a lógica que o caminho síncrono legado (abaixo, em
 * `handleVote`) já fazia — a ÚNICA diferença é que aqui não há resposta HTML
 * a montar: o resultado de `firstVote` só decide se a contabilidade
 * prossegue ou é descartada (nunca "monta uma página diferente", porque a
 * página já foi enviada).
 *
 * `existingFromKv` já foi checado (e curto-circuitado) por
 * `handleVoteFastPath` ANTES de agendar esta função — por isso não há aqui
 * os headers de migração legada `X-KV-Vote-Exists`/`X-KV-VoteKey-Committed`
 * (só fazem sentido quando o caller ainda não sabe se o KV já tem o voto;
 * aqui já sabemos que não tinha, no momento do request).
 */
async function runVoteBookkeeping(
  env: Env,
  brand: Brand,
  edition: string,
  email: string,
  choice: "A" | "B",
  correct: boolean | null,
  scoreRaw: string | null,
  voteTs: string,
): Promise<void> {
  const voteKey = `vote:${edition}:${email}`;
  let doStub: DurableObjectStub | null = null;

  if (env.VOTE_DEDUP) {
    const doId = env.VOTE_DEDUP.idFromName(`${brand}:${edition}:${email}`);
    doStub = env.VOTE_DEDUP.get(doId);

    // Mesma disciplina de retry único + fail-open do caminho legado (#2220/
    // #2231): erro do DO NÃO bloqueia a contabilidade (ela já não bloqueia o
    // jogador de qualquer forma, mas ainda queremos os incrementos).
    let doResp: Response | null = null;
    let doError: unknown = null;
    try {
      doResp = await doStub.fetch("https://internal/vote-dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (doResp.status >= 500) {
        try {
          doResp = await doStub.fetch("https://internal/vote-dedup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
        } catch (retryErr) {
          doError = retryErr;
          doResp = null;
        }
      }
    } catch (e) {
      doError = e;
      doResp = null;
    }

    if (doResp === null || doResp.status >= 500) {
      console.error(JSON.stringify({
        event: "vote_dedup_do_error",
        status: doResp?.status ?? "exception",
        error: doError !== null ? String(doError) : undefined,
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
      }));
      doStub = null; // fail-open (#2231): segue gravando mesmo com o DO indisponível.
    } else {
      let firstVote: boolean;
      try {
        const parsed = await doResp.json() as { firstVote: boolean };
        firstVote = parsed.firstVote;
      } catch (parseErr) {
        console.error(JSON.stringify({
          event: "vote_dedup_do_parse_error",
          error: String(parseErr),
          edition,
          email_domain: email.split("@")[1] ?? "unknown",
        }));
        doStub = null;
        firstVote = true; // fail-open
      }

      if (!firstVote) {
        // #3983 cuidado (a): dedup rejeitou — a resposta otimista já foi
        // mostrada ao jogador (correta, ele realmente acertou/errou aquela
        // rodada); aqui só descartamos silenciosamente pra não dobrar a
        // contagem no score/stats/leaderboard. Log em nível info (não é uma
        // falha) — útil pra medir a frequência real da corrida otimista.
        console.log(JSON.stringify({
          event: "vote_bg_duplicate_discarded",
          edition,
          email_domain: email.split("@")[1] ?? "unknown",
        }));
        return;
      }
    }
  }

  const statsGuardKey = `counted:${edition}:${email}:stats`;
  const scoreGuardKey = `counted:${edition}:${email}:score`;
  const monthGuardKey = `counted:${edition}:${email}:month`;

  if (!(await env.POLL.get(statsGuardKey))) {
    await updateStatsCounter(env, edition, choice, correct, brand);
    await env.POLL.put(statsGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
  }

  await Promise.all([
    (async () => {
      if (!(await env.POLL.get(scoreGuardKey))) {
        // #4125 (item 1): relê score:{email} FRESCO aqui — NÃO usa o `scoreRaw`
        // recebido como parâmetro (congelado em handleVoteFastPath, ANTES do
        // round-trip da dedup DO + HMAC + render + resposta HTTP ao jogador;
        // o fast-path responde ANTES de qualquer escrita por desenho, ver
        // rationale completo no header desta função). Sem isso, dois votos
        // do MESMO leitor em edições DIFERENTES com bookkeepings sobrepostos
        // (o modo sequência foi desenhado pra permitir votar em pares
        // sucessivos rápido) faziam o updateScore que termina por ÚLTIMO
        // sobrescrever score:{email} inteiro com base num snapshot já
        // obsoleto, perdendo o incremento do voto que terminou primeiro.
        //
        // MITIGAÇÃO, não eliminação: na época deste comentário (#4125 item 1)
        // ainda restava uma janela pequena entre esta leitura e o `put`
        // dentro de updateScore (KV não tem compare-and-swap). ATUALIZAÇÃO
        // (#4169): essa janela foi FECHADA — `updateScore` agora serializa o
        // read-modify-write via Durable Object `ScoreCounter` (mesmo padrão
        // de VOTE_DEDUP/STATS_COUNTER) quando `env.SCORE_COUNTER` está
        // presente (ver docblock de `updateScore` e rationale completo em
        // score-counter.ts). O `freshScoreRaw` lido aqui continua útil como
        // `kvBaseline` — semente pro DO só quando ele nunca foi
        // inicializado — mas a race get→put descrita acima não existe mais
        // com o binding presente (produção). Sem o binding (fallback KV, só
        // testes/dev), a race documentada abaixo permanece.
        const freshScoreRaw = await env.POLL.get(`score:${email}`);
        await updateScore(env, email, edition, correct, freshScoreRaw, brand);
        await env.POLL.put(scoreGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
      }
    })(),
    (async () => {
      if (!(await env.POLL.get(monthGuardKey))) {
        // #4169: brand p/ id do DO ScoreCounter (`{brand}:{email}`).
        await updateScoreByMonth(env, email, edition, correct, scoreRaw, brand);
        await env.POLL.put(monthGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
      }
    })(),
  ]);

  // Commit definitivo — gravado por ÚLTIMO (mesma disciplina do caminho
  // legado): retries intermediários completam via guard-keys.
  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: voteTs, correct }));

  if (doStub !== null) {
    try {
      let confirmResp = await doStub.fetch("https://internal/confirm", { method: "POST" });
      if (confirmResp.status >= 500) {
        try {
          confirmResp = await doStub.fetch("https://internal/confirm", { method: "POST" });
        } catch (retryErr) {
          console.error(JSON.stringify({ event: "vote_dedup_confirm_retry_failed", edition, error: String(retryErr) }));
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "vote_dedup_confirm_failed", edition, error: String(e) }));
    }
  }

  try {
    await recordVoteLog(env, email, edition, choice, correct, voteTs);
  } catch (e) {
    console.error(JSON.stringify({ event: "vote_log_failed", edition, error: String(e) }));
  }
}

/**
 * Mantém counter agregado stats:{edition} — evita N+1 reads no /stats.
 *
 * #2223: usa StatsCounter DO (se disponível) para serializar o increment edition-wide.
 * Antes: read-modify-write não-serializado em KV eventual — sob burst, vários requests
 * concorrentes liam o mesmo valor stale e escreviam +1, perdendo incrementos.
 * Com o DO: `blockConcurrencyWhile` serializa os increments — zero perda sob burst.
 *
 * Routing:
 *   Se STATS_COUNTER binding presente → roteia pelo DO (serializado, sem perda).
 *   Fallback (sem binding) → comportamento anterior (KV RMW, aceito em testes/dev).
 *
 * Após o incremento via DO, espelha o valor no KV `stats:{edition}` para compat
 * com scripts externos que leem diretamente o KV (ex: rebuild-stats.ts).
 * Falha do espelho KV é logada mas não propaga — o DO tem o valor autoritativo.
 *
 * `brand` é necessário para o DO id (`{brand}:{edition}`) — isola diaria×clarice.
 */
async function updateStatsCounter(
  env: Env,
  edition: string,
  choice: "A" | "B",
  correct: boolean | null,
  brand: Brand = "diaria",
): Promise<void> {
  const statsKey = `stats:${edition}`;

  if (env.STATS_COUNTER) {
    // Caminho serializado via DO (#2223)
    const doId = env.STATS_COUNTER.idFromName(`${brand}:${edition}`);
    const doStub = env.STATS_COUNTER.get(doId);
    // #3115: lê o espelho KV para servir de seed baseline caso o DO nunca tenha
    // sido inicializado (edição com votos anteriores ao deploy do DO, #2223).
    // O DO só usa este valor quando seu próprio storage está `undefined` — nunca
    // sobrescreve um estado real já gravado nele (mesmo que zerado).
    const kvBaselineRaw = await env.POLL.get(statsKey);
    // Self-review #3115: JSON.parse envolto em try/catch — um `stats:{edition}`
    // corrompido no KV não deve derrubar o voto inteiro (throw não-capturado
    // aqui propagaria por updateStatsCounter, que não tem try/catch no call
    // site em handleVote). Malformado → trata como "sem baseline" (null),
    // igual ao caminho normal de DO-nunca-inicializado sem histórico.
    let kvBaseline: StatsCounterData | null = null;
    if (kvBaselineRaw) {
      try {
        kvBaseline = JSON.parse(kvBaselineRaw) as StatsCounterData;
      } catch (e) {
        console.error(JSON.stringify({ event: "stats_kv_baseline_parse_error", edition, error: String(e) }));
      }
    }
    const doResp = await doStub.fetch("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice, correct, kvBaseline }),
    });
    if (doResp.ok) {
      const { stats } = await doResp.json() as { ok: true; stats: StatsCounterData };
      // Espelha no KV para compat com leitores externos (não-autoritativo).
      // Falha do espelho não propaga — o DO é a fonte de verdade.
      try {
        await env.POLL.put(statsKey, JSON.stringify(stats));
      } catch (e) {
        console.error(JSON.stringify({ event: "stats_kv_mirror_failed", edition, error: String(e) }));
      }
      return;
    }

    // DO retornou erro de cliente (4xx) — sinal de erro de programação.
    // (#2245): um DO 400 (choice inválido) é inalcançável em produção porque
    // handleVote já valida `choice as "A"|"B"`. Mas se um bug futuro passar choice
    // malformado, o comportamento correto é:
    //   - NÃO lançar: throw propaga não-capturado por handleVote → 500 pro votante
    //     + voteKey nunca gravado + /confirm nunca chamado (pior que o bug original).
    //   - NÃO cair no KV RMW: re-introduziria a race que o #2223 corrigiu.
    //   - Logar warning (sinal de bug de programação) e PULAR o incremento de stats,
    //     deixando o restante do fluxo de voto completar normalmente (200 + voteKey + /confirm).
    // (#2293 self-review HIGH): substituído throw por warn+return (skip stats, vote completes).
    if (doResp.status >= 400 && doResp.status < 500) {
      const body = await doResp.text().catch(() => "(unreadable)");
      console.warn(JSON.stringify({ event: "stats_counter_do_client_error", status: doResp.status, body, edition, action: "skip_stats_increment" }));
      return; // pula incremento de stats — vote path continua (voteKey + /confirm intactos)
    }

    // DO retornou erro de servidor (5xx) — fallback para KV RMW (aceita perda residual, loga).
    console.error(JSON.stringify({ event: "stats_counter_do_error", status: doResp.status, edition }));
  }

  // Fallback: KV read-modify-write (sem binding DO, ou em erro do DO).
  // ATENÇÃO: mantém a race original (#2223) — usado apenas em testes/dev ou em
  // caso de falha do DO. Em produção, STATS_COUNTER binding deve estar presente.
  const raw = await env.POLL.get(statsKey);
  // #3298: stats:{edition} corrompido caía num JSON.parse desguardado — trata
  // como "sem stats ainda" (mesmo fallback de chave ausente), igual ao guard
  // já aplicado ao espelho KV em fetchEditionStatsAndCorrect (#3115).
  const stats = safeParseKv<StatsCounterData>(raw, "stats_kv_fallback_parse_error", edition)
    ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
  // #3355: `?? 0` guarda contra shape incompleto vindo de safeParseKv — o
  // guard de parse só protege contra JSON.parse que LANÇA (sintaxe
  // inválida); um valor JSON VÁLIDO mas com shape errado (ex: `{}`, sem os
  // campos numéricos) passa incólume pelo `?? {...}` acima (que só entra em
  // ação quando safeParseKv retorna `null`). Sem o `?? 0` aqui,
  // `stats.total += 1` produziria NaN, serializado como `null` no próximo
  // JSON.stringify — perda silenciosa do contador acumulado (o registro
  // "autocura" aritmeticamente no PRÓXIMO voto, já que `null + 1` coage pra
  // `1` em JS, mascarando a perda). PLAUSIBLE não CONFIRMED (não alcançável
  // hoje via nenhum write-path atual do /vote) — defesa em profundidade.
  stats.total = (stats.total ?? 0) + 1;
  if (choice === "A") stats.voted_a = (stats.voted_a ?? 0) + 1;
  if (choice === "B") stats.voted_b = (stats.voted_b ?? 0) + 1;
  if (correct === true) stats.correct_count = (stats.correct_count ?? 0) + 1;
  await env.POLL.put(statsKey, JSON.stringify(stats));
}

/**
 * #2206: espelha a bidirecionalidade do adjustScoreCorrectOnly no lado MENSAL.
 *
 * Ajusta APENAS o campo `correct` de `score-by-month:{mês}:{email}` em ±1
 * conforme a direção da mudança:
 *   - false/null → true: incrementa correct (+1)
 *   - true → false:      decrementa correct (−1, clampado em 0)
 *
 * Invariantes (idênticos ao adjustScoreCorrectOnly):
 *   - NUNCA toca total/streak/nickname — apenas correct.
 *   - Idempotente: quando prevCorrect === newCorrect, não escreve nada.
 *   - Clamp: correct nunca negativo (Math.max(0, ...)).
 *   - Mês derivado de editionToMonthSlug (mesma derivação do resto do código
 *     — NÃO usa relógio vivo).
 *   - Sem entry existente (vote pré-#1345): skip silencioso.
 *
 * Chamado de handleAdminCorrect — substitui o adjustScoreByMonthCorrect
 * increment-only anterior (removido em #2206).
 *
 * #4169: `brand` (default "diaria") — sincroniza best-effort o DO
 * ScoreCounter (`/adjust-month-correct`), se o binding estiver presente, pra
 * evitar que o `correct` cacheado no DO fique stale após esta correção (ver
 * rationale completo no header de score-counter.ts). Falha do DO aqui é
 * logada mas NUNCA bloqueia o backfill — o KV (atualizado abaixo) já está
 * correto de qualquer forma.
 */
export async function adjustScoreByMonthCorrectOnly(
  env: Env,
  email: string,
  edition: string,
  prevCorrect: boolean | null,
  newCorrect: boolean,
  brand: Brand = "diaria",
): Promise<void> {
  // Idempotente: sem mudança, sem escrita.
  if (prevCorrect === newCorrect) return;

  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return;
  const key = `score-by-month:${monthSlug}:${email}`;
  const raw = await env.POLL.get(key);
  // Sem entry mensal = vote pré-#1345; nada a ajustar no snapshot.
  if (!raw) return;

  // #3298: entry corrompida tratada igual a "sem entry mensal" (skip) — antes
  // um JSON.parse desguardado aqui derrubava handleAdminCorrect no meio do
  // backfill por causa de 1 registro malformado.
  const entry = safeParseKv<{ correct?: number }>(raw, "admin_correct_score_by_month_parse_error", edition);
  if (!entry) return;

  if (prevCorrect !== true && newCorrect === true) {
    // false/null → true: incrementa
    entry.correct = (entry.correct ?? 0) + 1;
  } else if (prevCorrect === true && newCorrect === false) {
    // true → false: decrementa, clampado em 0
    entry.correct = Math.max(0, (entry.correct ?? 0) - 1);
  } else {
    // null→false ou outro par sem mudança real em correct: skip write+invalidation.
    return;
  }
  // total, streak, nickname NÃO são tocados (invariante do backfill)

  await env.POLL.put(key, JSON.stringify(entry));
  // Invalidação feita pelo caller (handleAdminCorrect) uma vez após o loop — não aqui.

  // #4443 (correção pós-review do coordenador, achado #1 do self-review):
  // correção KV-DIRETA do agregado seq:{monthSlug}:{email} — espelha
  // EXATAMENTE o padrão acima pro score-by-month (write incondicional,
  // independente do resultado do sync via DO logo abaixo). Sem este bloco, a
  // correção do agregado dependia 100% do DO já ter a edição rastreada
  // (`storedSeq !== undefined && Object.hasOwn(...)`, ver
  // `handleAdjustMonthCorrect`, score-counter.ts) — uma entry SELF-HEALED
  // (criada por `handleJogarSeqState` sem NUNCA passar pelo DO pra este mês,
  // ex: edição votada antes do deploy do #4443, self-heal populou o KV
  // direto) ficava stale PRA SEMPRE: a presença do agregado no caminho
  // rápido de `/jogar/seq-state` suprime pra sempre o fallback que
  // re-derivaria o valor fresco de `vote:{edition}:{email}` (que ESTE
  // handler já corrigiu, linha 625 de index.ts). O DO segue sendo
  // sincronizado logo abaixo — quando ele tem o dado, os dois caminhos
  // convergem pro mesmo `newCorrect`; quando não tem, este é o único que
  // corrige.
  const seqKey = seqStateKvKey(monthSlug, email);
  const seqRaw = await env.POLL.get(seqKey);
  if (seqRaw) {
    const seqParsed = safeParseKv<unknown>(seqRaw, "admin_correct_seq_state_parse_error", edition);
    if (seqParsed && isValidSeqMonthMap(seqParsed) && Object.hasOwn(seqParsed, edition)) {
      const correctedSeq: SeqMonthMap = { ...seqParsed, [edition]: newCorrect };
      try {
        await env.POLL.put(seqKey, JSON.stringify(correctedSeq));
      } catch (e) {
        console.error(JSON.stringify({ event: "seq_state_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
      }
    }
  }

  // #4169: mantém o DO ScoreCounter (mensal) em sincronia — best-effort.
  // #4443: `edition` no payload — corrige `seq[edition]` no MESMO round-trip,
  // se o agregado já conhecer esta edição (ver rationale em
  // `handleAdjustMonthCorrect`, score-counter.ts). `seq` retornado é
  // espelhado no KV (`seq:{monthSlug}:{email}`) pra manter o agregado lido
  // por `/jogar/seq-state` consistente com o gabarito retificado — REDUNDANTE
  // com a correção KV-direta acima quando o DO tem o dado (mesmo valor
  // reescrito 2x, inofensivo), mas continua sendo a fonte de correção quando
  // o DO tem estado que o KV ainda não refletia por outro motivo.
  if (env.SCORE_COUNTER) {
    try {
      const doId = env.SCORE_COUNTER.idFromName(`${brand}:${email}`);
      const doStub = env.SCORE_COUNTER.get(doId);
      const doResp = await doStub.fetch("https://internal/adjust-month-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthSlug, prevCorrect, newCorrect, edition } satisfies AdjustMonthCorrectPayload),
      });
      if (!doResp.ok) {
        // #4169 (achado silent-failure-hunter): captura o corpo (diagnóstico
        // do DO, ex: "invalid correct_count") — mesma disciplina já aplicada
        // ao 4xx de updateScore/updateScoreByMonth. email_domain (não email
        // cru) — mesma convenção de vote_dedup_do_error.
        const body = await doResp.text().catch(() => "(unreadable)");
        console.error(JSON.stringify({ event: "score_counter_adjust_month_correct_error", status: doResp.status, body, edition, email_domain: email.split("@")[1] ?? "unknown" }));
      } else {
        const { seq } = await doResp.json().catch(() => ({ seq: undefined })) as { seq?: SeqMonthMap };
        if (seq) {
          try {
            await env.POLL.put(seqStateKvKey(monthSlug, email), JSON.stringify(seq));
          } catch (e) {
            console.error(JSON.stringify({ event: "seq_state_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
          }
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "score_counter_adjust_month_correct_error", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    }
  }
}

/**
 * Ajuste correto-only para backfill do admin (#2202):
 * corrige APENAS o campo `correct` sem re-incrementar `total` ou `streak`.
 * Chamado de handleAdminCorrect em vez de updateScore.
 *
 * Invariante: handleVote incrementa `total` uma vez (voto original).
 *             handleAdminCorrect usa este helper — NUNCA mexe em total/streak
 *             (streak é mantido como estava: não tem como recalcular streak
 *             de sequência multi-edição de forma correta aqui; mantemos o
 *             invariante de não regredir — só ajusta o campo `correct`).
 *
 * @param prevCorrect  valor anterior de `vote.correct` (antes do backfill)
 * @param newCorrect   novo valor calculado contra o gabarito correto
 *
 * #4169: `brand` (default "diaria") — sincroniza best-effort o DO
 * ScoreCounter (`/adjust-correct`), se o binding estiver presente, pra evitar
 * que o `correct` cacheado no DO fique stale após esta correção (ver
 * rationale completo no header de score-counter.ts). Falha do DO aqui é
 * logada mas NUNCA bloqueia o backfill — o KV (atualizado abaixo) já está
 * correto de qualquer forma.
 */
export async function adjustScoreCorrectOnly(
  env: Env,
  email: string,
  prevCorrect: boolean | null,
  newCorrect: boolean,
  brand: Brand = "diaria",
): Promise<void> {
  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  if (!raw) return; // sem score — handleVote não rodou ainda; skip

  // #3298: score:{email} corrompido tratado igual a "sem score" (skip) — sem
  // `edition` disponível nesta assinatura, usa `email` como contexto do log.
  const score = safeParseKv<{ correct?: number }>(raw, "admin_correct_score_parse_error", email);
  if (!score) return;

  // Idempotente: sem mudança, sem escrita/sync do DO.
  if (prevCorrect === newCorrect) return;

  // Ajusta apenas o campo `correct`:
  //  - false/null → true: incrementa correct
  //  - true → false: decrementa correct (gabarito mudou; este voto era antes correto)
  if (prevCorrect !== true && newCorrect === true) {
    score.correct = (score.correct ?? 0) + 1;
  } else if (prevCorrect === true && newCorrect === false) {
    score.correct = Math.max(0, (score.correct ?? 0) - 1);
  }
  // total e streak NÃO são tocados (invariante do backfill)

  await env.POLL.put(scoreKey, JSON.stringify(score));

  // #4169: mantém o DO ScoreCounter (global) em sincronia — best-effort.
  if (env.SCORE_COUNTER) {
    try {
      const doId = env.SCORE_COUNTER.idFromName(`${brand}:${email}`);
      const doStub = env.SCORE_COUNTER.get(doId);
      const doResp = await doStub.fetch("https://internal/adjust-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prevCorrect, newCorrect } satisfies AdjustScoreCorrectPayload),
      });
      if (!doResp.ok) {
        // #4169 (achado silent-failure-hunter): corpo do erro + email_domain
        // (não email cru) — mesma disciplina de updateScore/updateScoreByMonth
        // e da convenção pré-existente de vote_dedup_do_error.
        const body = await doResp.text().catch(() => "(unreadable)");
        console.error(JSON.stringify({ event: "score_counter_adjust_correct_error", status: doResp.status, body, email_domain: email.split("@")[1] ?? "unknown" }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "score_counter_adjust_correct_error", email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    }
  }
}

/**
 * #1345: incrementa `score-by-month:{YYYY-MM}:{email}` onde YYYY-MM vem da
 * publication date da edição. Esse é o índice canônico do leaderboard
 * mensal — `/leaderboard/{YYYY-MM}` lê só este prefix.
 *
 * Nickname é copiado de `score:{email}` (source-of-truth global). Pode ficar
 * stale se nickname mudar pós-vote — handleSetName propaga (#1345).
 *
 * #2190: `preloadedScoreRaw` — valor já lido de `score:{email}` no handleVote
 * (pré-commit). Quando fornecido, evita a re-leitura da mesma chave para
 * copiar o nickname. Quando omitido, faz o get normalmente (outras calls).
 *
 * #4169: quando `env.SCORE_COUNTER` está disponível, o incremento
 * total/correct/last_edition/last_vote_ts é SERIALIZADO via DO ScoreCounter
 * (`/update-month`) — fecha a race read-modify-write que existia aqui (dois
 * `runVoteBookkeeping` concorrentes do MESMO email, edições diferentes,
 * podiam intercalar entre este `get` e o `put` abaixo, perdendo um
 * incremento). `nickname` continua sendo resolvido/mesclado AQUI a partir do
 * KV (o DO não gerencia nickname — ver rationale no header de
 * score-counter.ts) antes de gravar o mirror. Sem o binding (ou em erro do
 * DO), cai no fallback KV — mesma race residual de antes deste fix.
 * `brand` (default "diaria") é necessário pro id do DO (`{brand}:{email}`).
 *
 * #4443: também mantém o agregado `seq:{monthSlug}:{email}` (consumido por
 * `GET /jogar/seq-state`, jogar.ts) — mesmo padrão de mirror KV pós-DO que
 * `score-by-month` já usa acima: o DO é a fonte serializada (fecha, pro
 * agregado, a mesma classe de race do #4169), o KV é só o espelho lido pelo
 * endpoint público. Falha do mirror é logada mas nunca propaga — a próxima
 * leitura de `/jogar/seq-state` cai no fallback por edição (sempre correto,
 * só mais caro) até o próximo voto bem-sucedido re-espelhar.
 */
async function updateScoreByMonth(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
  preloadedScoreRaw?: string | null,
  brand: Brand = "diaria",
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return; // edition malformado — não corrompe schema

  const key = `score-by-month:${monthSlug}:${email}`;
  const raw = await env.POLL.get(key);
  // #3298: entry corrompida cai no mesmo default de "sem entry ainda" — este
  // path roda em TODO voto (não só backfill do admin), então um registro
  // malformado aqui derrubaria o voto do leitor atual, não só a manutenção.
  const existing = safeParseKv<{
    total: number;
    correct: number;
    last_edition: string | null;
    nickname: string | null;
    last_vote_ts?: string;
  }>(raw, "update_score_by_month_parse_error", edition);

  // #4443: baseline do agregado seq:{monthSlug}:{email} — lido ANTES do
  // branch DO/fallback (usado nos dois): semeia o storage do DO na 1ª vez
  // que ele processa este mês (self-heal/backfill anteriores a este DO), e
  // é a base do read-modify-write no fallback sem binding. Validado via
  // `isValidSeqMonthMap` (não confia no shape só porque o parse teve
  // sucesso — mesma disciplina de `kvBaseline`/`isValidMonthScoreData`
  // acima).
  const seqKey = seqStateKvKey(monthSlug, email);
  const seqRaw = await env.POLL.get(seqKey);
  const seqParsed = seqRaw ? safeParseKv<unknown>(seqRaw, "update_seq_state_parse_error", edition) : null;
  const seqBaseline: SeqMonthMap | null = seqParsed && isValidSeqMonthMap(seqParsed) ? seqParsed : null;

  // Nickname: resolvido AQUI (fora do DO) — copiado de score:{email} SOMENTE
  // se a entry ainda não tem um. #2190: usa preloadedScoreRaw se disponível
  // (já lido antes do commit do voto), evitando re-leitura redundante.
  let nickname: string | null = existing?.nickname ?? null;
  if (nickname === null) {
    const scoreRaw = preloadedScoreRaw !== undefined
      ? preloadedScoreRaw
      : await env.POLL.get(`score:${email}`);
    // #3298: score:{email} corrompido aqui só afeta o nickname copiado (não
    // bloqueia o resto do voto) — trata como "sem score ainda" (nickname
    // permanece null, igual ao caminho scoreRaw ausente).
    const scoreObj = safeParseKv<{ nickname?: string | null }>(scoreRaw, "update_score_by_month_nickname_parse_error", edition);
    if (scoreObj) {
      nickname = scoreObj.nickname ?? null;
    }
  }

  if (env.SCORE_COUNTER) {
    const doId = env.SCORE_COUNTER.idFromName(`${brand}:${email}`);
    const doStub = env.SCORE_COUNTER.get(doId);
    const kvBaseline: MonthScoreData | null = existing && isValidMonthScoreData(existing)
      ? { total: existing.total, correct: existing.correct, last_edition: existing.last_edition, last_vote_ts: existing.last_vote_ts }
      : null;
    try {
      const doResp = await doStub.fetch("https://internal/update-month", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edition, monthSlug, correct, kvBaseline, seqKvBaseline: seqBaseline } satisfies UpdateMonthPayload),
      });
      if (doResp.ok) {
        // #4169 (achado silent-failure-hunter): parse isolado do corpo — o DO
        // já commitou o incremento no PRÓPRIO storage (blockConcurrencyWhile)
        // antes de responder; se só a RESPOSTA vier corrompida/truncada, um
        // catch genérico cairia no fallback KV RMW abaixo e re-incrementaria —
        // double-count exatamente da classe que este DO existe pra eliminar.
        // Falha de parse aqui NUNCA cai no fallback: o DO já está correto
        // internamente, só o espelho desta rodada fica stale (auto-corrige no
        // PRÓXIMO voto bem-sucedido deste jogador, que relê o KV como
        // kvBaseline — irrelevante pois o DO já tem estado real).
        let month: MonthScoreData;
        let seq: SeqMonthMap | undefined;
        try {
          ({ month, seq } = await doResp.json() as { ok: true; month: MonthScoreData; seq?: SeqMonthMap });
        } catch (e) {
          console.error(JSON.stringify({ event: "score_counter_do_month_parse_error", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
          return;
        }
        const merged = { ...month, nickname };
        let mirrorWritten = false;
        try {
          await env.POLL.put(key, JSON.stringify(merged));
          mirrorWritten = true;
        } catch (e) {
          console.error(JSON.stringify({ event: "score_by_month_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
        }
        // #4443: espelha o agregado seq:{monthSlug}:{email} pro KV — leitura
        // pública de `/jogar/seq-state` (jogar.ts). Best-effort/fail-soft:
        // falha aqui NUNCA propaga (o DO já persistiu o estado real; só o
        // cache lido pelo endpoint fica temporariamente stale/ausente, caindo
        // no fallback por edição até o próximo voto bem-sucedido re-espelhar).
        if (seq) {
          try {
            await env.POLL.put(seqKey, JSON.stringify(seq));
          } catch (e) {
            console.error(JSON.stringify({ event: "seq_state_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
          }
        }
        // #4169 (achado silent-failure-hunter): só faz upsert no snapshot se o
        // mirror KV foi de fato escrito — senão o snapshot (cache) fica à
        // frente do registro per-player (única fonte que `computeSnapshotEntries`
        // relê numa recomputação futura), e essa recomputação REGRIDE a
        // entry de volta pro valor stale, apagando silenciosamente o voto que
        // o DO já registrou corretamente.
        if (mirrorWritten) {
          await upsertOwnEntryInSnapshot(env, monthSlug, {
            email,
            nickname: merged.nickname ?? null,
            correct: merged.correct,
            total: merged.total,
            last_vote_ts: merged.last_vote_ts,
          });
        }
        return;
      }
      // DO retornou erro de cliente (4xx) — mesmo racional do #2293/updateStatsCounter:
      // não lança (500 pro votante), não cai no KV RMW (reintroduziria a race) — loga
      // warning e pula este incremento, deixando o resto do voto completar normalmente.
      if (doResp.status >= 400 && doResp.status < 500) {
        const body = await doResp.text().catch(() => "(unreadable)");
        console.warn(JSON.stringify({ event: "score_counter_do_month_client_error", status: doResp.status, body, edition, email_domain: email.split("@")[1] ?? "unknown", action: "skip_month_update" }));
        return;
      }
      // DO retornou erro de servidor (5xx) — fallback para KV RMW abaixo.
      console.error(JSON.stringify({ event: "score_counter_do_month_error", status: doResp.status, edition, email_domain: email.split("@")[1] ?? "unknown" }));
    } catch (e) {
      console.error(JSON.stringify({ event: "score_counter_do_month_error", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    }
  }

  // Fallback: KV read-modify-write (sem binding DO, ou em erro do DO).
  // ATENÇÃO: mantém a race original (#4169) — usado apenas em testes/dev ou
  // em caso de falha do DO. Em produção, SCORE_COUNTER binding deve estar presente.
  const entry = existing ?? { total: 0, correct: 0, last_edition: null, nickname: null };
  // #3355: mesmo guard `?? 0` de updateStatsCounter (ver nota lá) — shape
  // incompleto vindo de safeParseKv (JSON válido, campo numérico ausente)
  // não deve produzir NaN/perda silenciosa do total acumulado.
  entry.total = (entry.total ?? 0) + 1;
  if (correct === true) entry.correct = (entry.correct ?? 0) + 1;
  entry.last_edition = edition;
  // #1383: timestamp do voto pra tiebreaker no leaderboard. Voto mais recente
  // vence empate de (correct, total). Sobrescreve a cada vote (não acumula).
  entry.last_vote_ts = new Date().toISOString();
  entry.nickname = nickname;

  await env.POLL.put(key, JSON.stringify(entry));

  // #4443: mesmo fallback KV RMW (sem binding DO, ou em erro do DO) pro
  // agregado seq:{monthSlug}:{email} — ATENÇÃO: mantém a MESMA race
  // documentada acima pro resto desta função (aceitável só em testes/dev ou
  // erro do DO; em produção o SCORE_COUNTER binding fecha essa janela).
  const seqEntry: SeqMonthMap = { ...(seqBaseline ?? {}) };
  seqEntry[edition] = correct;
  try {
    await env.POLL.put(seqKey, JSON.stringify(seqEntry));
  } catch (e) {
    console.error(JSON.stringify({ event: "seq_state_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
  }

  // #2113(b): upsert da própria entry no snapshot pré-computado do mês.
  // KV eventual consistency: `list()` em computeSnapshotEntries pode demorar
  // até ~60s pra enxergar a key recém-gravada → leitor vê "Ainda sem votos"
  // no próprio ranking. `get()` por key é muito mais confiável (read-your-own-write).
  // Race entre votos concorrentes: OK — snapshot é cache, recompute corrige.
  // Em vez de só invalidar, ler + upsert + regravar garante que o próximo
  // GET /leaderboard já veja o voto sem precisar recomputar.
  // #2123: passa last_vote_ts pra que o tiebreaker de dense-rank funcione
  // também via snapshot (sem o campo, `rankEntries` caía em displayKey).
  await upsertOwnEntryInSnapshot(env, monthSlug, {
    email,
    nickname: entry.nickname ?? null,
    correct: entry.correct,
    total: entry.total,
    last_vote_ts: entry.last_vote_ts,
  });
}

/**
 * #1657: entrada do log de votos pra analytics de comportamento (latência
 * envio→voto, hora-do-dia, recorrência, acerto×latência). `email_hash` é um
 * HMAC domain-separado (`votelog:{email}`) — id estável de coorte SEM PII crua.
 * Review: NÃO reusar o poll_sig (HMAC do email cru) — ele viaja no `?sig=` das
 * URLs de voto; se uma URL vazar, o dump do log permitiria re-identificar o
 * histórico. O prefixo `votelog:` desacopla o id de coorte do sig de auth.
 */
export interface VoteLogEntry {
  ts: string;
  edition: string;
  month_slug: string;
  email_hash: string;
  choice: "A" | "B";
  correct: boolean | null;
}

/** Pure (#1657): monta a entrada do vote-log. Exportada pra teste. */
export function buildVoteLogEntry(args: {
  ts: string;
  edition: string;
  monthSlug: string;
  emailHash: string;
  choice: "A" | "B";
  correct: boolean | null;
}): VoteLogEntry {
  return {
    ts: args.ts,
    edition: args.edition,
    month_slug: args.monthSlug,
    email_hash: args.emailHash,
    choice: args.choice,
    correct: args.correct,
  };
}

/**
 * #1657: grava 1 entrada por voto em key PRÓPRIA — race-free, sem
 * read-modify-write (votos concorrentes logo após o envio não se sobrescrevem,
 * que é justamente a janela que a análise de latência quer medir).
 * Key: `vote-log:{month}:{edition}:{email_hash}` — listável por mês.
 * `monthSlug` null (edition malformado) → skip silencioso.
 */
export async function recordVoteLog(
  env: Env,
  email: string,
  edition: string,
  choice: "A" | "B",
  correct: boolean | null,
  ts: string,
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return;
  // Review #1736: domain-separado (`votelog:`) — NÃO é o poll_sig (HMAC do email
  // cru, que vaza no ?sig= das URLs). Mantém estabilidade por coorte sem permitir
  // re-identificação cruzando log + sig vazado.
  const emailHash = await hmacSign(env.POLL_SECRET, `votelog:${email}`);
  const entry = buildVoteLogEntry({ ts, edition, monthSlug, emailHash, choice, correct });
  await env.POLL.put(
    `vote-log:${monthSlug}:${edition}:${emailHash}`,
    JSON.stringify(entry),
  );
}

/**
 * #2190: `preloadedScoreRaw` — valor já lido de `score:{email}` no caller
 * (handleVote lê antes do commit do voto para evitar re-leitura redundante,
 * ver #2189). Quando omitido (ex: chamadas do admin backfill) faz o get normalmente.
 *
 * #4169: quando `env.SCORE_COUNTER` está disponível, o incremento de
 * total/correct/streak/last_edition é SERIALIZADO via DO ScoreCounter
 * (`/update-score`) — fecha a race read-modify-write que existia aqui (dois
 * `runVoteBookkeeping` concorrentes do MESMO email, edições diferentes,
 * podiam intercalar entre este `get` e o `put` no final, perdendo um
 * incremento — mesmo após o #4168 estreitar a janela relendo `score:{email}`
 * fresco). Ver rationale completo no header de score-counter.ts.
 * `nickname` continua sendo resolvido AQUI a partir do KV (o DO não gerencia
 * nickname, ver mesmo rationale) antes de gravar o mirror — preserva
 * qualquer nickname já definido por `handleSetName` (que escreve
 * `score:{email}` direto, sem passar pelo DO). Sem o binding (ou em erro do
 * DO), cai no fallback KV — mesma race residual de antes deste fix (aceita
 * em testes/dev; produção sempre tem o binding).
 */
async function updateScore(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
  preloadedScoreRaw?: string | null,
  brand: Brand = "diaria",
): Promise<void> {
  const scoreKey = `score:${email}`;
  // #2190: usa o valor pré-lido se disponível; senão faz o get (backfill do admin).
  const raw = preloadedScoreRaw !== undefined ? preloadedScoreRaw : await env.POLL.get(scoreKey);
  // #3298: este path roda em TODO voto (via updateScore(..., scoreRaw) dentro
  // do guard-key de handleVote) — um score:{email} corrompido derrubava o
  // voto do leitor atual com 500. Corrompido cai no mesmo default de "sem
  // score ainda" usado quando a chave nunca foi gravada.
  const existing = safeParseKv<{
    total: number;
    correct: number;
    streak: number;
    last_edition: string | null;
    nickname?: string | null;
  }>(raw, "update_score_parse_error", edition);
  const existingNickname = existing?.nickname ?? null;

  if (env.SCORE_COUNTER) {
    const doId = env.SCORE_COUNTER.idFromName(`${brand}:${email}`);
    const doStub = env.SCORE_COUNTER.get(doId);
    const kvBaseline: ScoreData | null = existing && isValidScoreData(existing)
      ? { total: existing.total, correct: existing.correct, streak: existing.streak, last_edition: existing.last_edition }
      : null;
    try {
      const doResp = await doStub.fetch("https://internal/update-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edition, correct, brand, kvBaseline } satisfies UpdateScorePayload),
      });
      if (doResp.ok) {
        // #4169 (achado silent-failure-hunter): parse isolado do corpo — o DO
        // já commitou o incremento no PRÓPRIO storage (blockConcurrencyWhile)
        // antes de responder; se só a RESPOSTA vier corrompida/truncada, um
        // catch genérico cairia no fallback KV RMW abaixo e re-incrementaria —
        // double-count exatamente da classe que este DO existe pra eliminar.
        // Falha de parse aqui NUNCA cai no fallback: o DO já está correto
        // internamente, só o espelho desta rodada fica stale (auto-corrige no
        // PRÓXIMO voto bem-sucedido deste jogador).
        let score: ScoreData;
        try {
          ({ score } = await doResp.json() as { ok: true; score: ScoreData });
        } catch (e) {
          console.error(JSON.stringify({ event: "score_counter_do_parse_error", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
          return;
        }
        const merged = { ...score, nickname: existingNickname };
        try {
          await env.POLL.put(scoreKey, JSON.stringify(merged));
        } catch (e) {
          console.error(JSON.stringify({ event: "score_kv_mirror_failed", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
        }
        return;
      }
      // DO retornou erro de cliente (4xx) — mesmo racional do #2293/updateStatsCounter:
      // não lança (500 pro votante), não cai no KV RMW (reintroduziria a race) — loga
      // warning e pula este incremento, deixando o resto do voto completar normalmente.
      if (doResp.status >= 400 && doResp.status < 500) {
        const body = await doResp.text().catch(() => "(unreadable)");
        console.warn(JSON.stringify({ event: "score_counter_do_client_error", status: doResp.status, body, edition, email_domain: email.split("@")[1] ?? "unknown", action: "skip_score_update" }));
        return;
      }
      // DO retornou erro de servidor (5xx) — fallback para KV RMW abaixo.
      console.error(JSON.stringify({ event: "score_counter_do_error", status: doResp.status, edition, email_domain: email.split("@")[1] ?? "unknown" }));
    } catch (e) {
      console.error(JSON.stringify({ event: "score_counter_do_error", edition, email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    }
  }

  // Fallback: KV read-modify-write (sem binding DO, ou em erro do DO).
  // ATENÇÃO: mantém a race original (#4169) — usado apenas em testes/dev ou
  // em caso de falha do DO. Em produção, SCORE_COUNTER binding deve estar presente.
  const score = existing ?? { total: 0, correct: 0, streak: 0, last_edition: null, nickname: null };

  // #3355: mesmo guard `?? 0` de updateStatsCounter (ver nota lá).
  score.total = (score.total ?? 0) + 1;
  // correct === null → gabarito ainda não definido: incrementa total mas não
  // mexe em correct/streak/last_edition (preserva estado pra reconciliação
  // futura — caso do brand "web" votando no par do dia ANTES do reveal do
  // dia seguinte via close-poll mirror, #3516). NOTA (#3522, decisão
  // conservadora documentada): a reconciliação retroativa de streak quando o
  // gabarito É definido depois passa por `handleAdminCorrect`/
  // `adjustScoreCorrectOnly` (index.ts/vote.ts) — essa função é também o
  // caminho de correção AO VIVO de gabarito já revelado pra diaria/clarice
  // (typo do editor), e um teste de regressão já trava deliberadamente
  // "streak NUNCA é tocado pelo backfill" (#2202/#2217,
  // test/poll-hardening-2188-2189-2190-2191.test.ts). Estender esse caminho
  // pra também atualizar streak no caso null→revelado (só relevante pra
  // "web") exigiria distinguir "1ª revelação" de "correção de valor já
  // conhecido" sem quebrar esse invariante travado — mudança genuína no
  // pipeline de correção ao vivo, fora do escopo conservador desta issue
  // (ver PR #3522: "documentar plano do e-mail como follow-up, não forçar
  // mudança arriscada"). Efeito prático: o voto do PRÓPRIO dia no brand
  // "web" nunca soma streak sozinho — soma quando o jogador volta e vota de
  // novo (arquivo/par seguinte, correctness já resolvida na hora do voto).
  if (correct === true) {
    // #3522: streak só continua se esta edição é o PRÓXIMO período de
    // votação esperado (dia útil seguinte, ou mês de conteúdo seguinte pra
    // brand "year"/clarice) após `score.last_edition` — sem isso, um
    // jogador que pulava dias/meses mantinha o streak intacto (só zerava em
    // resposta errada, nunca em ausência de voto). `score.last_edition` só
    // avança quando a correctness é CONHECIDA (aqui e no `else if` de
    // correct===false abaixo) — por isso funciona como "última edição com
    // streak resolvido", não "última edição votada".
    const continues = isConsecutiveVotingPeriod(score.last_edition, edition, brand);
    score.streak = continues ? (score.streak || 0) + 1 : 1;
    score.correct = (score.correct ?? 0) + 1;
    score.last_edition = edition;
  } else if (correct === false) {
    score.streak = 0;
    score.last_edition = edition;
  }
  // Preserve nickname if already set (don't overwrite)
  if (score.nickname === undefined) score.nickname = null;

  await env.POLL.put(scoreKey, JSON.stringify(score));
}

// ── /stats ────────────────────────────────────────────────────────────────────

/**
 * #2223/#3115/#3261: busca stats + gabarito de UMA chave de edição (DO +
 * espelho KV, com o merge DO×KV de #3115) + `correct:{edition}`.
 *
 * Extraído de `handleStats` (#3261) para poder ser chamado 2x — uma vez para
 * a `edition` pedida pelo caller (ciclo ou AAMMDD) e, quando aplicável, uma
 * segunda vez para o identificador AAMMDD LEGADO do mesmo ciclo (ver
 * `legacyMonthlyEditionForCycle`) — votos gravados ANTES do cutover #2115
 * (370fba43, 2026-06-11) usam essa 2ª chave, não a chave de ciclo.
 *
 * #4118: `rawEnv` — env CRU (sem prefixo de brand), usado SÓ para ler o
 * gabarito compartilhado `correct:{edition}` — mesmo racional já aplicado a
 * `handleVote` (`rawEnv`, #3600) e `handleAdminCorrect` (#4038, que fixou a
 * ESCRITA pra sempre usar o env cru). Esta função lia `correct:{edition}` via
 * `env` (branded, o `bEnv` que `handleStats`/`routeRequest` já passavam) —
 * pra brand="web"/"clarice" isso resolvia `web:correct:{edition}`/
 * `clarice:correct:{edition}`, chaves que `/admin/correct` NUNCA escreve
 * desde o #4038 (grava sempre a chave crua). Resultado: `/stats?brand=clarice`
 * (e `web`) sempre devolvia `correct_answer: null` mesmo com o gabarito já
 * fechado — quebrando o sanity check de `scripts/close-poll.ts` (aborta com
 * "FATAL" achando que a escrita falhou) e zerando `correct_choice` na aba
 * Engajamento da dashboard (`build-poll-eia-data.ts`). Com `brand="diaria"`
 * (prefixo vazio) cru===branded, então o bug ficava invisível em qualquer
 * teste que só exercitasse esse brand — é por isso que o teste de regressão
 * deste fix cobre `clarice`/`web` explicitamente, não só `diaria`.
 * `stats:{edition}` CONTINUA lido via `env` (branded) — é o espelho do DO
 * `{brand}:{edition}`, genuinamente por-brand (cada marca tem sua própria
 * contagem de votos). Default `= env` preserva compat com chamadas de teste
 * legadas que passam um único env (equivalente a brand="diaria").
 */
async function fetchEditionStatsAndCorrect(
  env: Env,
  brand: Brand,
  edition: string,
  rawEnv: Env = env,
): Promise<{ stats: StatsCounterData; correctRaw: string | null }> {
  // Fix #4 (#2223): correctRaw é independente dos stats — paralela as duas leituras.
  // #3115: o espelho KV `stats:{edition}` é SEMPRE lido em paralelo (não só no
  // branch de erro do DO) — precisamos dele mesmo quando o DO responde ok, para
  // o merge de mergeStatsWithKvFallback abaixo (DO all-zero ambíguo).
  const [doStatsResult, correctRaw, kvStatsRaw, correctCountStaleRaw] = await Promise.all([
    // #2223: tentar ler do DO (serializado, sem inconsistência de cache KV)
    (async () => {
      if (env.STATS_COUNTER) {
        try {
          const doId = env.STATS_COUNTER.idFromName(`${brand}:${edition}`);
          const doStub = env.STATS_COUNTER.get(doId);
          const doResp = await doStub.fetch("https://internal/stats", { method: "GET" });
          if (doResp.ok) {
            const { stats: doStats } = await doResp.json() as { ok: true; stats: StatsCounterData };
            return doStats;
          }
        } catch (e) {
          console.error(JSON.stringify({ event: "stats_counter_do_read_error", edition, error: String(e) }));
        }
      }
      return null;
    })(),
    // #4118: CRU (rawEnv), não branded — ver rationale no header desta função.
    rawEnv.POLL.get(`correct:${edition}`),
    env.POLL.get(`stats:${edition}`),
    // #4125 (item 2): setado por handleAdminCorrect (index.ts) quando o
    // POST /adjust-correct do DO falha — sinaliza que o correct_count do DO
    // ficou stale (o espelho KV foi atualizado de qualquer forma, ver
    // rationale completo em mergeStatsWithKvFallback/stats-counter.ts).
    env.POLL.get(`stats-do-stale:${edition}`),
  ]);

  // Self-review #3115: JSON.parse envolto em try/catch — antes só rodava no
  // branch de fallback (DO indisponível); agora roda em TODO /stats quando o
  // espelho KV existe. Um KV corrompido não deve derrubar o endpoint inteiro —
  // trata como "sem KV" (null), caindo no comportamento do doStats puro.
  let kvStatsResult: StatsCounterData | null = null;
  if (kvStatsRaw) {
    try {
      kvStatsResult = JSON.parse(kvStatsRaw) as StatsCounterData;
    } catch (e) {
      console.error(JSON.stringify({ event: "stats_kv_read_parse_error", edition, error: String(e) }));
    }
  }

  // #3115: DO nunca-inicializado responde `{total:0,...}` (ver stats-counter.ts) —
  // indistinguível de uma edição real com zero votos. mergeStatsWithKvFallback
  // compara o `total` do DO com o do KV e usa o de maior valor (nunca per-field),
  // preservando o caso "zero real" (ambos concordam em 0 → resultado 0) sem virar
  // falso-positivo. doStatsResult === null (DO indisponível/erro) cai no KV puro.
  // #4125 (item 2): `correctCountStale` (3º arg) cobre o caso onde total EMPATA
  // (uma correção de gabarito nunca muda total) mas correct_count do DO ficou
  // stale porque o /adjust-correct falhou — sem esse sinal, o empate de total
  // sempre preferia o DO, mascarando a correção pra sempre.
  const stats: StatsCounterData = mergeStatsWithKvFallback(doStatsResult, kvStatsResult, correctCountStaleRaw === "1");
  return { stats, correctRaw };
}

/**
 * #3261: soma dois `StatsCounterData` — usado quando eles vêm de DUAS CHAVES
 * DE EDIÇÃO DISTINTAS que representam o mesmo ciclo lógico (ex: ciclo novo
 * `2605-06` + AAMMDD legado `260531`, ver `legacyMonthlyEditionForCycle`).
 *
 * Diferente de `mergeStatsWithKvFallback` (que ESCOLHE uma fonte pra
 * representar a MESMA chave DO×KV — são espelhos um do outro, nunca somados),
 * aqui as duas fontes são votos REAIS e DISTINTOS gravados sob chaves
 * diferentes — soma, não escolha. `b === null` (edition sem par legado, ou
 * par legado sem dados) retorna `a` intacto.
 */
export function sumStatsCounterData(
  a: StatsCounterData,
  b: StatsCounterData | null,
): StatsCounterData {
  if (!b) return a;
  return {
    total: a.total + b.total,
    voted_a: a.voted_a + b.voted_a,
    voted_b: a.voted_b + b.voted_b,
    correct_count: a.correct_count + b.correct_count,
  };
}

/**
 * #2223: se STATS_COUNTER binding disponível, lê do DO (fonte autoritativa).
 * Fallback para KV `stats:{edition}` se o DO não estiver disponível ou retornar erro.
 * `brand` é necessário para derivar o DO id correto (`{brand}:{edition}`).
 *
 * #3261: quando `edition` é um ciclo Clarice (`YYMM-MM`), consulta TAMBÉM o
 * identificador AAMMDD LEGADO do mesmo ciclo (`legacyMonthlyEditionForCycle`)
 * e SOMA os dois resultados (`sumStatsCounterData`). Sem isso, `/stats?edition=X`
 * fazia lookup EXATO só pela string `edition` recebida — um ciclo enviado
 * ANTES do cutover #2115 (370fba43, 2026-06-11) gravou seus votos sob a
 * chave AAMMDD antiga (única que existia então), invisível pra uma consulta
 * pelo slug de ciclo novo. `correct_answer` usa o gabarito da chave primária
 * quando presente, senão o da legada (`primary.correctRaw ?? legacy?.correctRaw`)
 * — só uma das duas foi de fato gravada pelo close-poll.ts na prática.
 *
 * Generaliza para qualquer ciclo futuro com essa mesma ambiguidade de
 * formato — não hardcoded pros ciclos específicos que motivaram a issue.
 * `edition` em formato AAMMDD (diária) ou ciclo com mês de conteúdo inválido
 * → `legacyMonthlyEditionForCycle` retorna null → sem 2ª consulta, comportamento
 * idêntico ao pré-#3261.
 *
 * #3294 (item 1 — DoS não-autenticado): `/stats` é público, sem HMAC. Antes
 * desta versão, `edition` da query string ia direto pro DO id
 * (`STATS_COUNTER.idFromName`) e pras chaves KV `correct:${edition}`/
 * `stats:${edition}` SEM validação de forma nem teto de comprimento — os
 * mesmos validadores que #3118 item 3/#3279 aplicaram em `handleVote`
 * (`vote.ts:132`) nunca foram estendidos pra este 2º ponto que compõe a
 * MESMA forma de chave KV. Um `edition` arbitrariamente longo (ex: milhares
 * de chars) produz uma chave KV que estoura o limite de 512 bytes do Workers
 * KV, lançando exceção — 500 pra qualquer chamador anônimo, sem autenticação
 * nenhuma (endpoint público). Fix: mesmo gate `isValidVoteEditionFormat` já
 * usado em `handleVote`, aplicado ANTES de qualquer uso de `edition` em
 * DO id ou chave KV.
 */
/**
 * #3523: extraído de `handleStats` (era código inline ali) — soma a chave
 * primária + a legada (mesmo racional de #3261) num único helper reusável.
 * `handleStats` continua sendo o único CALLER público (`/stats`, JSON), mas
 * `handleVote` (#3523) agora reusa exatamente a mesma agregação para montar
 * o sufixo "X% acertaram este par" pós-voto — evita a classe de bug já
 * documentada alhures neste arquivo (#3118 item 10) onde dois call sites
 * quase-idênticos divergem silenciosamente ao longo do tempo. O voto do
 * PRÓPRIO votante já foi incrementado no DO/KV ANTES deste ponto no fluxo de
 * `handleVote` (`updateStatsCounter`, guard-key `stats`, mais acima) —
 * portanto o valor lido aqui já reflete o voto que está sendo processado.
 *
 * #4118: `rawEnv` (default = env) — repassado pra `fetchEditionStatsAndCorrect`
 * pra que o gabarito seja lido CRU nas duas chamadas (primary + legacy). Ver
 * rationale completo no header de `fetchEditionStatsAndCorrect`.
 */
export async function getSummedEditionStats(
  env: Env,
  brand: Brand,
  edition: string,
  rawEnv: Env = env,
): Promise<{ stats: StatsCounterData; correctRaw: string | null }> {
  // #4563: `legacyMonthlyEditionForCycle` valida só a FORMA do `edition`
  // (`YYMM-MM`), nunca o brand — sem este guard, um `edition` em formato de
  // ciclo consultado sob um brand `leaderboardPeriod !== "year"` (ex:
  // `diaria`/`web`, que não têm conceito de ciclo mensal) faz
  // `legacyMonthlyEditionForCycle` apontar pra um AAMMDD que é uma edição
  // DIÁRIA REAL (não um marcador legado) — somando stats de uma edição
  // completamente alheia. Achado ao vivo (#4563): `/stats?edition=2607-08`
  // sem `&brand=` (default "diaria") somou os stats da edição diária real
  // `260731`, produzindo `correct_count`/`total` que não correspondem a
  // NENHUM voto do ciclo `2607-08` de fato. Mesmo guard que a direção
  // INVERSA (`cycleForLegacyMonthlyEdition`) já aplica no call site
  // (`handleEditions` abaixo, `normalizeLegacy = leaderboardPeriod === "year"`).
  const legacyEdition = BRAND_INFO[brand].leaderboardPeriod === "year"
    ? legacyMonthlyEditionForCycle(edition)
    : null;

  const [primary, legacy] = await Promise.all([
    fetchEditionStatsAndCorrect(env, brand, edition, rawEnv),
    legacyEdition ? fetchEditionStatsAndCorrect(env, brand, legacyEdition, rawEnv) : Promise.resolve(null),
  ]);

  const stats = sumStatsCounterData(primary.stats, legacy?.stats ?? null);
  const correctRaw = primary.correctRaw ?? legacy?.correctRaw ?? null;
  return { stats, correctRaw };
}

// #4118: 4º parâmetro `rawEnv` (default = env, preserva compat com chamadas
// legadas/teste com env único) — env CRU usado SÓ pro read do gabarito
// `correct:{edition}` dentro de `getSummedEditionStats`/
// `fetchEditionStatsAndCorrect`. `stats:{edition}` continua via `env`
// (branded). `index.ts` passa o `env` cru como 4º arg em `routeRequest`
// (mesmo padrão de `handleVote`/#3600 e `handleAdminCorrect`/#4038).
/**
 * #4125 (item 5): assina `stats:{brand}:{edition}` com `ADMIN_SECRET` — MESMA
 * chave usada por `handleAdminCorrect` (#3118 item 8), mensagem própria pra
 * não ser reusável entre os dois endpoints. Verificado no `sig` opcional de
 * `/stats` (ver `handleStats` abaixo): presença de um sig válido é a prova de
 * que o caller é autorizado (ex: `close-poll.ts`, que precisa reler o
 * gabarito de HOJE logo após fechá-lo — ver rationale completo lá) e
 * bypassa a omissão anti-spoiler de `correct_answer` pra edição não-fechada.
 */
async function verifyStatsSig(secret: string, brand: Brand, edition: string, sig: string | null): Promise<boolean> {
  if (!sig) return false;
  return hmacVerify(secret, `stats:${brand}:${edition}`, sig);
}

export async function handleStats(url: URL, env: Env, brand: Brand = "diaria", rawEnv: Env = env): Promise<Response> {
  const edition = url.searchParams.get("edition");
  if (!edition) return json({ error: "missing edition" }, 400, env);
  if (!isValidVoteEditionFormat(edition)) return json({ error: "invalid edition format" }, 400, env);

  const { stats, correctRaw } = await getSummedEditionStats(env, brand, edition, rawEnv);
  const total = stats.total;

  // #4125 (item 5, decisão do editor 260727): omite `correct_answer`
  // publicamente enquanto `edition >= hoje` (BRT) — mesmo racional anti-spoiler
  // do 403 que `handleQuizAnswer` já aplica ao mesmo fato (jogar.ts). Só
  // aplica a edições AAMMDD (diária, ou o identificador legado da mensal,
  // #3261) — comparação lexical de string contra `todayAammddBrt` não faz
  // sentido pro formato de ciclo `YYMM-MM` (mensal atual), que não tem um
  // "hoje" comparável e fica FORA do escopo desta decisão. `sig` autenticado
  // (ver `verifyStatsSig`) bypassa a omissão — usado por `close-poll.ts`, que
  // fecha a edição no MESMO dia em que ela é publicada e precisa reler o
  // gabarito recém-gravado no sanity check pós-close (#1367).
  const isUnclosedToday = AAMMDD_RE.test(edition) && edition >= todayAammddBrt(new Date());
  const authorized = isUnclosedToday ? await verifyStatsSig(env.ADMIN_SECRET, brand, edition, url.searchParams.get("sig")) : true;
  const correctAnswer = (isUnclosedToday && !authorized) ? null : correctRaw;

  return json({
    edition,
    total,
    voted_a: stats.voted_a,
    voted_b: stats.voted_b,
    correct_answer: correctAnswer,
    correct_count: stats.correct_count,
    correct_pct: total > 0 ? Math.round((stats.correct_count / total) * 100) : null,
  }, 200, env);
}

// ── /editions (#3257) ────────────────────────────────────────────────────────

/**
 * #3257: lista as edições/ciclos que este worker tem stats registrados —
 * derivado das chaves KV `stats:{edition}` (mesmo espelho lido/escrito por
 * `handleStats`/`updateStatsCounter`, um por edição com ≥1 voto).
 *
 * Existe pra resolver o obstáculo descrito na issue #3257: o botão "Atualizar"
 * da aba Engajamento do clarice-dashboard (`build-poll-eia-data.ts`) hoje
 * decide QUAIS edições consultar via `enumerateEditionDirs`, que lê
 * `data/editions/`/`data/monthly/` — diretórios locais (junction OneDrive),
 * inacessíveis a um Worker Cloudflare. Este worker (`poll`) é a fonte de
 * verdade real de "quais edições têm voto registrado" — expor a enumeração
 * aqui evita duplicar `data/editions/` no runtime do Worker (opção 1b da
 * issue, a recomendada — menos duplicação de lógica).
 *
 * `env`/`brand` seguem o mesmo padrão de handleStats: `env` já vem embrulhado
 * no namespace do brand (branded via `brandedEnv` em index.ts) — `listAllKeys`
 * lista só as chaves DESSE brand, sem precisar filtrar aqui.
 *
 * Filtra por formato válido (AAMMDD diário OU YYMM-MM mensal — mesmo regex de
 * `renderEiaEngagementSection` no clarice-dashboard) — defesa contra uma key
 * `stats:` corrompida/parcial (edition vazio ou lixo) vazando pro consumer.
 * Ordenado desc (mais recente primeiro), mesma convenção de `discoverEditions`/
 * `buildPollEiaSummaryFromApi` no script que este endpoint substitui.
 *
 * #3350: para brands com leaderboard ANUAL (`BRAND_INFO[brand].leaderboardPeriod
 * === "year"` — hoje só `clarice`), uma chave `stats:AAMMDD` pode ser um
 * MARCADOR LEGADO de ciclo mensal (pré-#2115, ver `legacyMonthlyEditionForCycle`)
 * em vez de uma edição diária real — `clarice` não tem conceito de "edição
 * diária", então toda chave AAMMDD dela É um marcador legado por construção.
 * Sem normalizar aqui, `fetchClariceEditions` (eia-refresh.ts) filtra a lista
 * só pro formato de ciclo (`/^\d{4}-\d{2}$/`) e descarta essas entradas
 * silenciosamente — um ciclo com votos reais só sob a chave legada (ex:
 * `2605-06` sob `260531`, mesmo cenário do #3261) desaparecia da aba
 * Engajamento assim que o botão "Atualizar" (#3257) sobrescrevia o KV
 * `eia:engagement` com a lista incompleta. `cycleForLegacyMonthlyEdition`
 * reconstrói o slug de ciclo a partir do AAMMDD; `null` (não é um marcador
 * legado reconstruível — não deveria ocorrer pra `clarice` na prática, ver
 * guard de forma no helper) mantém a edition original como fallback.
 * Normalizado na FONTE (aqui) em vez de ensinar cada consumidor
 * (`fetchClariceEditions`) a lidar com os dois formatos — mais robusto,
 * mesmo racional já aplicado por `handleStats` no #3261.
 *
 * `Set` deduplica o caso onde AMBAS as chaves existem pro mesmo ciclo
 * (`stats:260531` legado + `stats:2605-06` novo, cenário "soma" do #3261) —
 * sem dedup, `/editions` listaria o mesmo ciclo 2x.
 */
export async function handleEditions(env: Env, brand: Brand = "diaria"): Promise<Response> {
  const prefix = "stats:";
  const editionSet = new Set<string>();
  const normalizeLegacy = BRAND_INFO[brand].leaderboardPeriod === "year";
  for await (const keyName of listAllKeys(env, prefix)) {
    const edition = keyName.slice(prefix.length);
    // #3297: reusa isValidVoteEditionFormat (mesmo regex combinado AAMMDD|ciclo)
    // em vez de reexpressar o par de regex inline.
    if (!isValidVoteEditionFormat(edition)) continue;
    const normalized = normalizeLegacy ? cycleForLegacyMonthlyEdition(edition) : null;
    editionSet.add(normalized ?? edition);
  }
  const editions = [...editionSet];
  editions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return json({ brand, editions }, 200, env);
}

// ── /leaderboard/top1 (#1160) ────────────────────────────────────────────────

/**
 * Pure (#1160): retorna apenas os subscribers em 1º lugar (com tie support).
 * Empates compartilham a posição 1 (dense rank). Sem entries = []. Sem score
 * com nickname = []. Privacy: só nickname, nunca email cru.
 *
 * Threshold mínimo: pelo menos 1 voto. Subscribers que ainda não votaram
 * (mesmo que tenham nickname seedado) não aparecem.
 *
 * Output shape compatível com `render-newsletter-html.ts` integration plan
 * (#1160 follow-up).
 */
