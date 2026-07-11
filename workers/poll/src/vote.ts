import type { Env } from "./index";
import { type Brand, editionToMonthSlug, AAMMDD_RE } from "./lib"; // #3297: AAMMDD_RE substitui regex inline
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
  safeParseKv, // #3298: parse seguro de JSON vindo do KV
} from "./lib";
import { hmacSign, hmacVerify, json, voteHtmlResponse, votePageHtml } from "./index";
import { upsertOwnEntryInSnapshot, listAllKeys } from "./leaderboard-routes";
import { type StatsCounterData, mergeStatsWithKvFallback } from "./stats-counter";

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
  // #2189: branch "já votou" NÃO hardcoda nicknameForm=null. Lê o score pra
  // determinar se o votante ainda precisa do form de nickname — sem isso, um
  // retry após 500 mostrava "já votou" mas sem o form, deixando o nickname
  // inacessível para sempre.
  let prevNicknameForm: { email: string; sig: string } | null = null;
  const prevScoreRaw = await env.POLL.get(`score:${email}`);
  // #3278: mesma classe de dado que existingFromKv acima (blob JSON gravado em
  // KV) — precisa do mesmo guard. Sem try/catch, um `score:{email}` corrompido
  // derrubava com 500 o leitor que só está reabrindo o link de "já votou"
  // (nem sequer é um voto novo sendo lançado).
  let prevScoreObj: { nickname?: string | null } | null = null;
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
  if (!prevScoreObj?.nickname) {
    const prevSig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    prevNicknameForm = { email, sig: prevSig };
  }
  return voteHtmlResponse(votePageHtml(jaVotouMsg, false, prevNicknameForm, null, editionToMonthSlug(edition), brand), 200);
}

export async function handleVote(url: URL, env: Env, brand: Brand = "diaria"): Promise<Response> {
  // #1083: Beehiiv não URL-encoda `{{ subscriber.email }}`; URLSearchParams
  // converte `+` em ` `. Restaurar antes de qualquer uso (HMAC, KV key).
  const emailRaw = url.searchParams.get("email")?.toLowerCase().trim();
  const email = emailRaw ? emailRaw.replace(/ /g, "+") : emailRaw;
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
  const [correctRaw, validEditionsRaw, existingFromKv] = await Promise.all([
    env.POLL.get(`correct:${edition}`),
    env.POLL.get("valid_editions"),
    env.POLL.get(voteKey),
  ]);
  const validSet = parseValidEditions(validEditionsRaw);
  if (!isValidEdition(validSet, edition) && correctRaw === null) {
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
  if (AAMMDD_RE.test(edition) && edition > todayAammddBrt(new Date())) {
    return voteHtmlResponse(votePageHtml("Essa edição não aceita mais votos.", false, null, null, null, brand), 410);
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
      return buildAlreadyVotedResponse(env, brand, edition, email, existingFromKv);
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
      return buildAlreadyVotedResponse(env, brand, edition, email, existingFromKv);
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
  const scoreObj = safeParseKv<{ nickname?: string | null }>(scoreRaw, "vote_score_parse_error", edition);

  // #1236: test mode — short-circuit antes de qualquer KV write. Mantém
  // validação completa (gate, sig, dedup) acima pra que o test reflita
  // request real. Resposta indica claramente que não foi gravado.
  if (testMode) {
    const testMsg = correct === true
      ? "✅ [TEST] Acertou! Era a imagem gerada por IA. (não gravado em KV)"
      : correct === false
      ? "❌ [TEST] Não foi dessa vez — era a foto real. (não gravado em KV)"
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
        await updateScore(env, email, edition, correct, scoreRaw);
        await env.POLL.put(scoreGuardKey, "1", { expirationTtl: 90 * 24 * 3600 });
      }
    })(),
    (async () => {
      if (!(await env.POLL.get(monthGuardKey))) {
        await updateScoreByMonth(env, email, edition, correct, scoreRaw);
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

  const msg = correct === true
    ? "✅ Acertou! Era a imagem gerada por IA."
    : correct === false
    ? "❌ Não foi dessa vez — era a foto real."
    : "Voto registrado! O resultado sai na próxima edição.";

  // #1078 — primeiro voto: oferecer nickname pra leaderboard. scoreObj já foi
  // lido antes do put (ver #2189/#2190 acima) — reusar sem nova leitura.
  const needsNickname = !scoreObj?.nickname;
  let nicknameForm: { email: string; sig: string } | null = null;
  if (needsNickname) {
    const sig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    nicknameForm = { email, sig };
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

  // #2113(a): passa voteTs como cache-buster pra quebrar cache do navegador no link
  // "Ver leaderboard" — leitor que viu a página de leaderboard antes de votar não
  // fica com a versão vazia em cache. SÓ neste link (tráfego orgânico inalterado).
  return voteHtmlResponse(votePageHtml(msg, true, nicknameForm, resultImages, editionToMonthSlug(edition), brand, voteTs), 200);
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
  stats.total += 1;
  if (choice === "A") stats.voted_a += 1;
  if (choice === "B") stats.voted_b += 1;
  if (correct === true) stats.correct_count += 1;
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
 */
export async function adjustScoreByMonthCorrectOnly(
  env: Env,
  email: string,
  edition: string,
  prevCorrect: boolean | null,
  newCorrect: boolean,
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
 */
export async function adjustScoreCorrectOnly(
  env: Env,
  email: string,
  prevCorrect: boolean | null,
  newCorrect: boolean,
): Promise<void> {
  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  if (!raw) return; // sem score — handleVote não rodou ainda; skip

  // #3298: score:{email} corrompido tratado igual a "sem score" (skip) — sem
  // `edition` disponível nesta assinatura, usa `email` como contexto do log.
  const score = safeParseKv<{ correct?: number }>(raw, "admin_correct_score_parse_error", email);
  if (!score) return;

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
 */
async function updateScoreByMonth(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
  preloadedScoreRaw?: string | null,
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return; // edition malformado — não corrompe schema

  const key = `score-by-month:${monthSlug}:${email}`;
  const raw = await env.POLL.get(key);
  // #3298: entry corrompida cai no mesmo default de "sem entry ainda" — este
  // path roda em TODO voto (não só backfill do admin), então um registro
  // malformado aqui derrubaria o voto do leitor atual, não só a manutenção.
  const entry = safeParseKv<{
    total: number;
    correct: number;
    last_edition: string | null;
    nickname: string | null;
    last_vote_ts?: string;
  }>(raw, "update_score_by_month_parse_error", edition)
    ?? { total: 0, correct: 0, last_edition: null, nickname: null };

  entry.total += 1;
  if (correct === true) entry.correct += 1;
  entry.last_edition = edition;
  // #1383: timestamp do voto pra tiebreaker no leaderboard. Voto mais recente
  // vence empate de (correct, total). Sobrescreve a cada vote (não acumula).
  entry.last_vote_ts = new Date().toISOString();

  // Pull nickname from global score key. handleSetName propaga em writes
  // subsequentes, mas o snapshot no momento do vote já é capturado aqui.
  // #2190: usa o preloadedScoreRaw se disponível (já lido antes do commit do voto).
  if (entry.nickname === null) {
    const scoreRaw = preloadedScoreRaw !== undefined
      ? preloadedScoreRaw
      : await env.POLL.get(`score:${email}`);
    // #3298: score:{email} corrompido aqui só afeta o nickname copiado (não
    // bloqueia o resto do voto) — trata como "sem score ainda" (nickname
    // permanece null, igual ao caminho scoreRaw ausente).
    const scoreObj = safeParseKv<{ nickname?: string | null }>(scoreRaw, "update_score_by_month_nickname_parse_error", edition);
    if (scoreObj) {
      entry.nickname = scoreObj.nickname ?? null;
    }
  }

  await env.POLL.put(key, JSON.stringify(entry));

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
 */
async function updateScore(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
  preloadedScoreRaw?: string | null,
): Promise<void> {
  const scoreKey = `score:${email}`;
  // #2190: usa o valor pré-lido se disponível; senão faz o get (backfill do admin).
  const raw = preloadedScoreRaw !== undefined ? preloadedScoreRaw : await env.POLL.get(scoreKey);
  // #3298: este path roda em TODO voto (via updateScore(..., scoreRaw) dentro
  // do guard-key de handleVote) — um score:{email} corrompido derrubava o
  // voto do leitor atual com 500. Corrompido cai no mesmo default de "sem
  // score ainda" usado quando a chave nunca foi gravada.
  const score = safeParseKv<{
    total: number;
    correct: number;
    streak: number;
    last_edition: string | null;
    nickname?: string | null;
  }>(raw, "update_score_parse_error", edition)
    ?? { total: 0, correct: 0, streak: 0, last_edition: null, nickname: null };

  score.total += 1;
  // correct === null → gabarito ainda não definido: incrementa total mas não
  // mexe em correct/streak (preserva estado pra reconciliação futura).
  if (correct === true) {
    score.correct += 1;
    score.streak = (score.streak || 0) + 1;
  } else if (correct === false) {
    score.streak = 0;
  }
  score.last_edition = edition;
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
 */
async function fetchEditionStatsAndCorrect(
  env: Env,
  brand: Brand,
  edition: string,
): Promise<{ stats: StatsCounterData; correctRaw: string | null }> {
  // Fix #4 (#2223): correctRaw é independente dos stats — paralela as duas leituras.
  // #3115: o espelho KV `stats:{edition}` é SEMPRE lido em paralelo (não só no
  // branch de erro do DO) — precisamos dele mesmo quando o DO responde ok, para
  // o merge de mergeStatsWithKvFallback abaixo (DO all-zero ambíguo).
  const [doStatsResult, correctRaw, kvStatsRaw] = await Promise.all([
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
    env.POLL.get(`correct:${edition}`),
    env.POLL.get(`stats:${edition}`),
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
  const stats: StatsCounterData = mergeStatsWithKvFallback(doStatsResult, kvStatsResult);
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
export async function handleStats(url: URL, env: Env, brand: Brand = "diaria"): Promise<Response> {
  const edition = url.searchParams.get("edition");
  if (!edition) return json({ error: "missing edition" }, 400, env);
  if (!isValidVoteEditionFormat(edition)) return json({ error: "invalid edition format" }, 400, env);

  const legacyEdition = legacyMonthlyEditionForCycle(edition);

  const [primary, legacy] = await Promise.all([
    fetchEditionStatsAndCorrect(env, brand, edition),
    legacyEdition ? fetchEditionStatsAndCorrect(env, brand, legacyEdition) : Promise.resolve(null),
  ]);

  const stats = sumStatsCounterData(primary.stats, legacy?.stats ?? null);
  const correctRaw = primary.correctRaw ?? legacy?.correctRaw ?? null;
  const total = stats.total;

  return json({
    edition,
    total,
    voted_a: stats.voted_a,
    voted_b: stats.voted_b,
    correct_answer: correctRaw,
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
 */
export async function handleEditions(env: Env, brand: Brand = "diaria"): Promise<Response> {
  const prefix = "stats:";
  const editions: string[] = [];
  for await (const keyName of listAllKeys(env, prefix)) {
    const edition = keyName.slice(prefix.length);
    // #3297: reusa isValidVoteEditionFormat (mesmo regex combinado AAMMDD|ciclo)
    // em vez de reexpressar o par de regex inline.
    if (isValidVoteEditionFormat(edition)) editions.push(edition);
  }
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
