# Corte e rollback: transporte do onboarding Brevo → Kit (#7922)

**Status: PENDENTE DE APROVAÇÃO DO EDITOR.** Nada neste documento autoriza
ligar `onboarding.kit_transport.enabled`, rodar `--send` de verdade, ou
executar o piloto descrito abaixo. É o procedimento acordado ANTES de
qualquer uma dessas ações acontecer — a issue #7922 é explícita: "Sua
criação não autoriza enviar e-mails, alterar a conta, armar serviços nem
executar a virada em produção nesta conversa" (e o mesmo vale para este
documento, escrito numa sessão supervisionada sob a mesma restrição).

## Por que este documento existe

A fatia 1/N (PR #8136, merged) entregou o núcleo do transporte Kit
(`scripts/lib/onboarding-kit-transport.ts` +
`scripts/onboarding-kit-transport-run.ts`) atrás de um kill switch dedicado
que **nasce `false`**. O que falta para a migração de verdade não é mais
código — é a decisão operacional de QUANDO e COMO virar a chave, e o que
fazer se algo der errado depois. A issue pede isso explicitamente como
critério de aceite: "Corte e rollback documentados e aprovados antes de
produção."

## 1. O que o corte muda (e o que não muda)

**Muda:** qual TRANSPORTE entrega os 3 e-mails do onboarding (e-mail 1
imediato, e-mail 2 D+3, e-mail 3/convite de apoio D+10) — de Brevo
(transacional + campanha rascunho) para Kit (broadcasts segmentados por
tag).

**Não muda:**
- O controle interno de estado/cadência/elegibilidade. Continua 100% em
  `scripts/lib/onboarding-state.ts` + `scripts/lib/onboarding-store.ts`
  (`data/onboarding/store.json`). O transporte Kit só ganhou um namespace
  próprio (`store.kit_transport.lots`) no MESMO arquivo — nunca uma segunda
  fonte de verdade.
- A cadência (D0 / D+3 / D+10) e a condição de elegibilidade do e-mail 3
  (pelo menos 1 abertura de edição em D+10, decisão do editor #7599).
- O e-mail 3 continua **rascunho com aprovação humana explícita** para
  agendar/enviar — no Kit isso é `--approve-email3-lot <id> --send-at <iso>`
  (`assertEmail3ScheduleAuthorized` lança sem essa aprovação, estrutural,
  não só convenção).
- Nenhum outro uso da Brevo (diária, reativação, Clarice) é tocado por este
  corte — escopo explícito da issue.

## 2. Regra do corte (nunca retroativa)

> **Novas entradas detectadas APÓS o cutover vão para o transporte Kit.
> Entradas já iniciadas (qualquer e-mail da escada já enviado por qualquer
> um dos dois transportes) TERMINAM no transporte onde começaram — Brevo.**

Mecanicamente, isto significa:

1. **Nunca resetar** `store.last_detection_cursor`, `store.entries[*]` ou
   qualquer campo de estado (`email{1,2}_sent_at`, `email3_state`, etc.)
   para "migrar" uma entrada de um transporte para o outro. O corte é sobre
   QUEM ENVIA O PRÓXIMO PASSO de uma entrada nova, nunca uma reescrita de
   histórico.
2. `onboarding-welcome-run.ts` (Brevo) e `onboarding-kit-transport-run.ts`
   (Kit) **continuam rodando os dois, sempre, indefinidamente** — não existe
   um "desligar Brevo" neste corte. Uma entrada cujo e-mail 1/2 já saiu pela
   Brevo tem `email{1,2}_brevo_id` preenchido; o executor Kit nunca escreve
   nesses campos e nunca reprocessa uma entrada que a Brevo já tratou — a
   decisão de "due" em `onboarding-state.ts` é por TEMPO (âncora + dias),
   não por transporte, então uma entrada com `email1_sent_at` preenchido
   nunca aparece de novo como candidata a e-mail 1 em nenhum dos dois
   executores. **Isso só vale porque, desde o #9014, o executor Kit também
   grava `email{1,2}_sent_at`** (+ `email{1,2}_kit_lot_id`) quando o
   broadcast do lote é confirmado (`persistLotUpdate` →
   `applyKitLotToEntries`, sob o mesmo lock do lote; lote cancelado desfaz a
   marcação). Antes disso o Kit só registrava `kit_transport.lots` e a mesma
   pessoa entrava num lote de e-mail 1 novo todo dia. Como defesa extra,
   `filterKitPlanForBrevoInFlight` recebe os lotes e pula
   (`kit_lot_existente`) qualquer entrada já presente num lote confirmado da
   mesma etapa, de qualquer dia.
3. A identidade "novas entradas" é operacionalizada por **qual dos dois
   scripts processa a detecção do dia primeiro** e cria a entrada no store
   com `email1_sent_at: null` ainda vazio — a partir desse instante, qual
   executor efetivamente ENVIA o e-mail 1 dessa entrada é quem primeiro
   rodar com seu próprio kill switch ligado. Hoje só o kill switch Brevo
   está ligado (`onboarding-welcome-run.ts` não tem kill switch dedicado —
   é o caminho em produção); o corte real é: **ligar
   `onboarding.kit_transport.enabled=true` E, no mesmo commit/mudança de
   config, impedir `onboarding-welcome-run.ts` de processar candidatos a
   e-mail 1 para os quais o Kit já criou um lote** (ver item 4).
4. **Risco identificado e MITIGADO nos DOIS lados (#8966, guard implementado).**
   Os dois executores rodam sobre o MESMO `selectCandidatesNeedingRefresh`/
   `buildRunPlan`, e se ambos tiverem seus respectivos "envio" habilitado ao
   mesmo tempo, um candidato de e-mail 1/2 due poderia, em teoria, ser
   processado por AMBOS na mesma rodada (Brevo envia via
   `POST /smtp/email`, Kit cria um broadcast) — duplicando o e-mail para
   quem confirma exatamente na janela de transição. **Decisão única:**
   `ownerTransportFor(entry, kind, kitTransportEnabled)`
   (`scripts/lib/onboarding-state.ts`) — kill switch desligado devolve
   sempre `"brevo"` (estado atual em produção); ligado, `email1` é sempre
   `"kit"` (por definição, todo candidato de e-mail 1 é uma entrada nova,
   sem histórico em nenhum transporte) e `email2` segue a proveniência do
   e-mail 1 da MESMA entrada — gravada EXPLICITAMENTE em `email1_transport`
   (#9015: `"brevo"` no envio Brevo e na semeadura, `"kit"` na confirmação
   do lote Kit). Entrada com `seeded_by` resolve pra `"brevo"` mesmo sem o
   campo (seeds continuam a escada Brevo e o Kit os exclui da seleção), e
   e-mail 1 legado sem proveniência gravada também é `"brevo"` (o Kit nunca
   gravou `email1_sent_at` antes do #9014). A versão anterior inferia o dono
   de `email1_brevo_id != null` e deixava seeds e envios Brevo com id nulo
   sem e-mail 2 em nenhum dos lados. **Os dois executores consultam a
   MESMA função, cada um filtrando o próprio plano contra ela** (não duas
   implementações que precisam concordar por acaso):
     - `filterBrevoPlanForKitCutover`, aplicado por `onboarding-welcome-run.ts`
       — remove do plano Brevo qualquer ação cujo dono não seja `"brevo"`.
     - `filterKitPlanForBrevoInFlight`, aplicado por
       `onboarding-kit-transport-run.ts` — remove do plano Kit qualquer ação
       cujo dono não seja `"kit"` (a metade que faltou na fatia original da
       PR #8976: sem isto, uma entrada iniciada na Brevo — devida no e-mail
       2 — continuava sendo planejada pelo executor Kit ao mesmo tempo).
   `email3_campaign` fica fora da decisão de DONO nos dois filtros (o e-mail
   3 já é sempre rascunho com aprovação humana explícita em ambos os
   transportes), mas os DOIS checam lote Kit de e-mail 3: entry já coberta
   por um lote Kit de e-mail 3 sai do cohort (#9059 no lado Kit, só lote
   confirmado; #9151 no lado Brevo, qualquer lote não-cancelado). Testes de
   regressão: `test/onboarding-brevo-kit-mutex-8966.test.ts`,
   `test/onboarding-brevo-store-lock-9151.test.ts`.
   **Escrita do store (#9151):** os dois executores gravam
   `data/onboarding/store.json` sob o MESMO `withFileLock(${storePath}.lock)`,
   relendo o disco dentro do lock. O Brevo aplica só o delta da própria
   rodada (`persistStoreDelta`) — antes regravava o snapshot do início sem
   lock e apagava lotes/`sent_at` que um `--send` Kit concorrente gravasse.
   Logo antes de enviar, o Brevo relê o disco sob o lock
   (`readStoreUnderLock`) e descarta do plano o que o Kit gravou durante a
   rodada (`dropActionsCoveredOnDisk`, skip `alterado_no_disco`); lock preso
   ou store corrompido falham ali, antes de qualquer envio. Se a gravação
   final falhar mesmo assim, a rodada vai pra `store.json.pending-<ts>.json`
   (reconciliar à mão antes do próximo `--send`). Janela residual: o
   intervalo entre essa releitura e o envio de cada e-mail (segundos).
5. As coortes históricas **#7665/#7675** (recuperações manuais,
   `seeded_by` presente) são **excluídas da seleção automática dos DOIS
   transportes** — já implementado (`selectEligibleKitRecipients` exclui por
   `seeded_by`; o caminho Brevo trata `seeded_by` como decisão dirigida
   separada, ver `onboarding-seed-7674` nos testes). O corte não reabre
   nem reenvia essas coortes como efeito colateral.

## 3. Procedimento de virar a chave (kill switch)

Pré-requisitos, todos verificados ANTES de qualquer flip:

- [x] Guard do item 2.4 acima (mutua-exclusão entre os dois executores
      para candidatos NOVOS) implementado, com teste de regressão (#8966)
      — ainda pendente de REVISÃO humana antes do flip real.
- [ ] Piloto supervisionado (seção 4) executado e aprovado.
- [ ] `data/snippets/onboarding-{1,2,3}.md` confirmados corretos para
      renderização no Kit (HTML, personalização, remetente, links de
      descadastro) — não reusar a validação feita para a Brevo sem
      reconferir no builder/preview do Kit.
- [ ] Alarme de continuidade (#7839) confirmado operante para o novo
      transporte, não só para o Brevo.
  - [x] Código: toda rodada `onboarding-kit-transport-run.ts --send` de
        produção grava `kit_transport.last_send_run` +
        `consecutive_failed_send_runs` no store (`stampKitSendRun`, sob o
        lock) — inclusive a que ABORTA (backend/config inválido, ou exceção
        no meio: registro `aborted: true` com o motivo; store CORROMPIDO não
        tem como ser registrado nem é coberto pelo alarme, que responde
        `cannot-verify` — só o exit != 0 da rodada sinaliza). Rodada "falha"
        (`isFailedKitSendRun`) = abortou; ou ≥1 lote falho — inclusive e-mail
        1/2 cuja RELEITURA no Kit não ecoou `send_at` (o broadcast é apagado
        e o lote cancelado, ou, se o DELETE falhar, marcado `schedule_failed`
        e deixa de contar como confirmado: as entradas nunca ficam presas);
        ou releitura de confirmação que falhou (`lots_unverified`, falha de
        transporte — o lote fica `created`, sem declarar falha de entrega);
        ou ≥1 ação devida barrada por snippet ausente/pendente/inválido; ou
        o refresh de TODOS os candidatos falhou por erro de consulta (rede,
        ou qualquer erro HTTP exceto 404/422 — "não encontrado no Kit" não
        conta). Rodada com kind barrado por `blocked_concurrent` e sem falha
        é NEUTRA (nem zera nem incrementa a streak). Com
        `onboarding.kit_transport.enabled: true`,
        `onboarding-continuity-alarm.ts` avalia esse sinal (check
        `onboarding-kit-transport`, issue própria): 2 rodadas seguidas
        falhando, OU nenhuma rodada registrada, OU a última há mais de 48h
        → issue + e-mail (com o switch ligado devia haver rodada; nunca `ok`
        sem leitura). Com o switch desligado (rollback do §6) o check não se
        aplica e a issue Kit aberta fecha sozinha após 2 execuções — fechar
        por rollback NÃO é causa resolvida. Config ilegível = transporte
        "desconhecido": o check Kit nem alarma nem fecha. O e-mail nomeia o
        transporte ativo; a streak de detecção é a mesma nos dois regimes
        (quem detecta é sempre `onboarding-welcome-run.ts`). Testes:
        `test/onboarding-continuity-kit-transport-7922.test.ts` e
        `test/onboarding-kit-transport-run-counters-7922.test.ts`.
  - [ ] Confirmação em produção: depende de 1 ciclo real depois do flip
        (rodada `--send` do executor Kit seguida do alarme). A task
        `Diaria-Onboarding-Continuity-Alarm` já está ARMADA na `300` (09:10
        BRT; `npx tsx scripts/lib/scheduled-tasks.ts --list`), mas NÃO
        existe task agendada do executor Kit — declará-la e armá-la é passo
        do flip (abaixo). Sem ela, o alarme abre a issue "executor não está
        rodando" já na 1ª manhã depois do flip.
- [ ] Painel do Studio (`/assinantes`, #7917/#8955) mostrando os lotes Kit
      corretamente para pelo menos 1 ciclo completo em dry-run.
  - [x] Código: o painel lista os lotes Kit de produção (status, broadcast,
        destinatários, último erro com e-mail mascarado) e a última rodada
        `--send`; separa lote/entrada de piloto (`onboarding-pilot-*`,
        `pilot:*`) do funil de produção; mostra por qual transporte saiu
        cada e-mail 1/2 (`provider: "kit"` do passo 5 abaixo). Teste com o
        executor real em subprocesso (dry-run não grava nada; `--send`
        registra a rodada): `test/studio-onboarding-kit-lots-7922.test.ts`.
  - [ ] Conferência visual no Studio com o store real, num ciclo dry-run de
        produção.

Sequência de flip:

1. Declarar a task agendada do executor Kit (`onboarding-kit-transport-run.ts
   --send`, diária, ANTES das 09:10 BRT do alarme de continuidade e depois
   das 09:05 da detecção) em `scripts/lib/scheduled-tasks.ts` e armá-la na
   `300` via `scripts/setup-systemd-timers.ts` — no mesmo dia do flip. Sem
   ela, nada envia pelo Kit e o alarme abre "executor não está rodando".
2. `platform.config.json` → `onboarding.kit_transport.enabled: true`.
   Commitado, revisado, nunca editado direto em produção sem PR (mesma
   disciplina de "pipeline reproducible" do `CLAUDE.md`).
3. Rodar `onboarding-kit-transport-run.ts` (sem `--send`) uma vez para
   conferir o PLANO antes de qualquer escrita — o dry-run já reflete o
   estado real (kill switch só bloqueia escrita, nunca leitura).
4. Primeira rodada com `--send` real: acompanhar o `summary` impresso
   (lotes criados, `excluded`, `skips`) e confirmar no painel Kit
   (broadcasts criados como rascunho/agendado, nunca `public`).
5. Confirmar no Studio (#7917) que as entradas processadas aparecem com
   `provider: "kit"` no funil e que a "Última rodada --send" do painel de
   lotes Kit mostra a rodada sem falha.

## 4. Piloto supervisionado (pré-requisito do corte, não o corte em si)

**Autorização necessária do editor, especificamente:**
- **Destinatários**: uma lista curta e nomeada de e-mails de teste que o
  editor controla (nunca assinantes reais não-avisados) — este documento
  não propõe uma lista, porque a issue trata "destinatários de teste
  explicitamente autorizados" como decisão do editor, não do código.
- **O que sai**: os 3 e-mails do onboarding (kind `email1`/`email2`/`email3`),
  cada um como um broadcast Kit separado dirigido só à tag do piloto — nunca
  a base real. `email3` sempre nasce rascunho (`send_at: null` forçado,
  estrutural); agendar o piloto do e-mail 3 exige
  `--approve-email3-lot --send-at` explícito, mesma aprovação humana do
  fluxo real.
- **Por que é envio real, não prévia**: a issue é explícita — "Teste via
  broadcast é envio real, não prévia inofensiva." O Kit não tem endpoint de
  preview-sem-envio para broadcast (diferente do builder da Beehiiv);
  qualquer broadcast agendado/enviado passa pela infraestrutura de entrega
  real do Kit, mesmo com poucos destinatários.

**Status (30/09/2026):** doc aprovado e piloto autorizado pelo editor na
#7922 para UM destinatário de teste (o próprio editor); kill switch de
produção segue OFF até o editor ver o resultado.

### 4.1 Comando exato do piloto (modo `--pilot`)

O runner tem um modo piloto dedicado (`scripts/lib/onboarding-kit-pilot.ts`)
que **não toca o store real nem o kill switch**. Substitua
`<email-autorizado>` pelo destinatário aprovado na issue (nunca cole o
e-mail na issue — só o summary, que sai sem PII):

```bash
# 0) store isolado (fora de data/onboarding/); o runner recusa o store real
PILOT_STORE="$HOME/onboarding-pilot-7922/store.json"

# 1) dry-run — semeia só em memória e imprime o plano dos 3 lotes
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE"

# 2) envio real: e-mail 1 e 2 agendados para ~5 min a partir do PATCH (feito só depois das verificações); e-mail 3 fica RASCUNHO
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE" --send

# 3) e-mail 3: aprovação humana explícita, como no fluxo real
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE" \
  --approve-email3-lot email3-AAAA-MM-DD-01 --send-at 2026-10-01T13:00:00Z

# 4) depois do envio: releitura de status / repetição segura
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE" --reconcile
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE" --send   # 2ª vez: nada duplica

# 5) cancelamento de um lote do piloto (só aceita tag onboarding-pilot-* e destinatários da allowlist)
npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email-autorizado> --store "$PILOT_STORE" --cancel-lot <lot_id>
```

O que o modo piloto garante, em camadas independentes:

- **Store isolado**: `--store` é obrigatório e é recusado se apontar para o
  store real (`onboarding.store_path` ou `data/onboarding/store.json`),
  comparado por caminho canônico (`realpathSync.native` — `data/` é junction
  OneDrive). Um store isolado que já contenha qualquer entry fora de
  `--pilot-recipients` (ex: uma cópia do real) também é recusado.
- **Kill switch**: ignorado **só** com `--pilot` — `platform.config.json`
  não é tocado; o executor de produção continua bloqueado.
- **Cadência**: os 3 kinds são planejados no mesmo dia (D+3/D+10 e as regras
  de abertura do e-mail 3 são ignoradas **só** no piloto — o objetivo é
  validar segmentação/entrega/renderização dos 3 conteúdos; a régua tem
  cobertura própria). Re-rodar não replaneja kind já confirmado.
- **Allowlist por lote**: os destinatários de cada lote têm de estar em
  `--pilot-recipients` — senão aborta antes de qualquer escrita no Kit.
  `--cancel-lot`/`--approve-email3-lot` com `--pilot` também exigem a tag
  com prefixo `onboarding-pilot-` e a allowlist.
- **Tag**: nome `onboarding-pilot-{lot_id}` (nunca colide com tag de
  produção). Num **lote novo** a tag precisa ser recém-criada (tag
  pré-existente aborta); o id usado é o devolvido pela criação. Após
  taguear, busca por nome + membros são relidos no mesmo loop de retry
  (~4 min, cobre os ~90s de propagação da tag e ~180s da listagem de
  membros): nome resolvendo pra outro id, tag vazia, com membro estranho ou
  com contagem ≠ destinatários do lote aborta (risco #6126).
- **Broadcast**: nasce **sempre rascunho** e é relido. O PATCH que agenda
  (e-mail 1/2 e `--approve-email3-lot`) **reenvia o `subscriber_filter`**
  junto com `send_at` (PATCH no Kit pode zerar campo omitido, #8208) e o
  broadcast é **relido de novo depois**. Filtro divergente em qualquer
  releitura → broadcast apagado e aborta (2xx não é prova, #6582); se o
  delete falhar, a mensagem manda apagar no painel. Releitura que **falha**
  (rede/5xx/404) nunca agenda, com ou sem flag. PATCH que não deixa o
  broadcast `scheduled` é falha (exit 1). Filtro **não ecoado** pela API →
  rascunho mantido sem agendar e aborta; conferir a audiência no painel do
  Kit e, se ok, agendar à mão no painel — ou `--cancel-lot <lot_id>` e
  re-rodar `--send` com `--pilot-allow-unechoed-filter`, que agenda com
  aviso em stderr (sem o cancelamento o rascunho conta como lote confirmado
  e não é replanejado). O eco de `subscriber_filter` por
  `GET /broadcasts/{id}` nunca foi confirmado ao vivo.
- **E-mail 3**: rascunho; `--approve-email3-lot` no piloto repete prefixo +
  allowlist + releitura da tag + do filtro, e agenda pelo mesmo PATCH
  verificado acima; `--send-at` precisa ser ≥ agora + 5 min.
- **PATCH que lança** (timeout/rede): o broadcast é relido mesmo assim —
  se saiu de rascunho ou não dá pra ler, é apagado e a rodada aborta; se
  segue rascunho, nada foi agendado.
- **Store que não persiste** depois de existir broadcast: além do aviso em
  stderr, o lote vai para `<store>.pending-broadcasts.json`, e o piloto não
  recria aquele kind enquanto o registro existir (apague a linha à mão só
  depois de conferir o broadcast no painel).
- **Summary**: contagens, ids de lote/broadcast, status e o filtro que o Kit
  ecoou (só ids de tag). Mensagens de erro passam por redação de e-mail
  (o corpo de um erro da API do Kit pode ecoar endereço) — mesmo assim,
  revise antes de colar na issue. Lote que falha ou não persiste sai com
  `failed: true` e exit 1.

O que o piloto precisa validar (todos os itens da issue, seção "Piloto e
transição"):

| Item | Como verificar | Onde registrar |
|---|---|---|
| Segmentação | Confirmar no painel Kit que o broadcast do lote atingiu SÓ a tag do lote (`onboarding-{lot_id}` em produção; `onboarding-pilot-{lot_id}` no piloto) — nunca a base inteira. Comparar contagem esperada (`recipient_emails.length` do lote) com o destinatário real reportado pelo Kit. | Comentário na issue com contagem, sem PII (só números). |
| Entrega | Confirmar recebimento nas caixas de teste (inbox, não spam) para os 3 e-mails. | Idem — agregado, nunca lista de e-mails/nomes na issue. |
| Renderização | Abrir o e-mail recebido: HTML íntegro, sem quebra de layout, personalização (se houver merge tag) resolvida, link de descadastro presente e funcional. | Idem. |
| Métricas | Rodar `--reconcile` após o envio e conferir que o status do lote reflete o real (`scheduled`/`completed`) — e, quando disponível, `fetchSubscriberStatsKit`/`GET /subscribers/{id}/stats` mostrando a abertura do destinatário de teste (mesmo endpoint que o e-mail 3 usa para elegibilidade; ver seção 5 sobre a validação já feita neste PR). | Idem. |
| Repetição segura | Rodar `--send` uma 2ª vez com o MESMO lote já criado — confirmar via `summary.lots[].skipped === "reuse"` (no piloto: `note` "já têm lote confirmado") que nada duplica (mecanismo já testado em `test/onboarding-kit-transport-run-lock-7922.test.ts`, mas nunca contra a API real). | Idem. |
| Cancelamento | Rodar `--cancel-lot <id>` num lote do piloto (rascunho ou agendado) e confirmar no painel Kit que o broadcast foi removido/abortado. Confirmar que um lote com `status: sending`/já enviado recusa o cancelamento com o erro esperado do Kit (422 "Broadcast has already been sent"), nunca reportado como sucesso. | Idem. |
| Entrega por provedor | Reusar a instrumentação de #6504 (acompanhamento de entrega) para os destinatários de teste, na medida em que o mecanismo já existente cobrir Kit. | Idem. |

Nenhum dado de PII (e-mail, nome) do piloto deve ser colado na issue —
apenas contagens agregadas e status, seguindo a mesma disciplina de
"Piloto supervisionado registra evidência agregada... sem PII na issue" do
critério de aceite.

## 5. Evidência de abertura de edição — validação feita nesta sessão

A issue registra a ressalva: "`fetchSubscriberStatsKit` atual contém
ressalva de não validação ao vivo; não tratar isso como integração
comprovada." Nesta sessão (28/09/2026), com `KIT_API_KEY` disponível via
Doppler, foi feita **uma única chamada de leitura** (`GET
/v4/subscribers/{id}/stats` sobre 1 assinante real da conta Free, sem
nenhuma escrita) que confirma o shape exatamente como o código já lê:

```
{ subscriber: { id, stats: { sent, opened, clicked, bounced, open_rate,
  click_rate, last_sent, last_opened, last_clicked,
  sends_since_last_open, sends_since_last_click } } }
```

com `opened` como `number` — o mesmo shape que o fix do #8100 já
implementava (confirmado antes só contra a documentação pública, nunca ao
vivo contra a conta). A docstring de `fetchSubscriberStatsKit`
(`scripts/onboarding-welcome-run.ts`) foi atualizada para remover a
ressalva "não confirmado ao vivo", que deixou de se aplicar.

**O que isto valida:** o shape de resposta do endpoint de stats no plano
Free é o esperado, e a distinção de nível (`subscriber.stats.opened`, não
`subscriber.opens`) do #8100 está correta na prática, não só na doc.

**O que isto NÃO valida:** que a métrica de abertura reportada por este
endpoint conta corretamente uma abertura de uma EDIÇÃO da newsletter
especificamente (vs. abertura de qualquer e-mail daquele assinante,
incluindo o próprio e-mail de onboarding) — essa distinção de atribuição é
tratada por `buildEmail3Info`/`onboarding-funnel-report.ts` (#7917) a nível
de PRODUTO (o campo é populado só a partir do fluxo correto), não pelo
endpoint em si, e seguir correta em produção depende do piloto (seção 4),
não desta validação de shape.

## 6. Rollback

Princípio: **pausar o transporte Kit primeiro, reconciliar/cancelar o que
está pendente, e só então considerar qualquer fallback — nunca um fallback
cego que reenvie pela Brevo em cima do que o Kit já entregou.**

1. **Pausar novas entradas Kit**: `onboarding.kit_transport.enabled: false`
   em `platform.config.json` (o mesmo kill switch do flip, reversível —
   commit revertendo o valor). A partir daqui, nenhuma escrita nova ao Kit
   acontece (`--send`/`--cancel-lot`/`--approve-email3-lot` recusam com o
   guard dedicado); leituras (`--reconcile`) continuam permitidas e são a
   forma de auditar o que ficou pendente.
2. **Reconciliar/cancelar pendências ANTES de qualquer fallback**: rodar
   `--reconcile` para atualizar o status real de todos os lotes não-
   terminais contra o Kit. Para cada lote em `pending`/`created` (rascunho
   ainda não enviado), decidir explicitamente:
   - Se o conteúdo/timing ainda faz sentido: deixar como rascunho e
     agendar manualmente mais tarde (não é uma emergência automática).
   - Se o rollback é por um problema no CONTEÚDO/segmentação: `--cancel-lot
     <id>` para cada lote pendente, confirmando no painel Kit que o
     broadcast foi de fato removido antes de seguir.
   - Um lote já `scheduled` (fila do Kit) que precise ser interrompido:
     `--cancel-lot` também funciona sobre agendado (`deleteBroadcast`
     aceita draft/scheduled); um lote já `completed`/enviando não pode ser
     cancelado — aceitar que já saiu, nunca reenviar o mesmo conteúdo pela
     Brevo para os MESMOS destinatários.
3. **Nunca fallback cego — checagem MECÂNICA desde #8979, não mais só
   prosa.** `filterBrevoPlanForKitCutover` (`onboarding-state.ts`) consulta
   `findKitLotForEntry` (hoje em `onboarding-kit-transport.ts`, junto do
   tipo `OnboardingKitLot` que define; `onboarding-funnel-report.ts`
   re-exporta pra quem já importava de lá) para CADA ação `email1`/`email2`
   do plano — **sempre**, com `onboarding.kit_transport.enabled` `true` OU
   `false`. Se existir um lote Kit para aquela etapa/entrada em qualquer
   estado que não seja `cancelled` (`pending`/`created`/`scheduled`/
   `completed` todos contam, conservador), a ação vira skip
   `kit_lot_existente` e `onboarding-welcome-run.ts` nunca a processa —
   inclusive no rollback, quando o switch já está `false`. Antes do #8979,
   o switch desligado era passagem livre byte a byte e o achado (review
   consolidado 260928c, issue #8979) confirmou o cenário descrito nesta
   seção: entrada com e-mail 1/2 servido por lote Kit `completed` seria
   reenviada pela Brevo assim que o rollback desligasse o switch. Só um
   lote `cancelled` (ou a ausência de qualquer lote) libera a Brevo para
   aquela etapa — não é preciso mais nenhuma ação manual de conferência
   antes de reativar o transporte Brevo, o guard já recusa a duplicação.
4. **Alarme de continuidade no rollback**: com o switch `false`, o check do
   transporte Kit (`onboarding-continuity-alarm.ts`, check
   `onboarding-kit-transport`) deixa de se aplicar — uma issue dele que
   estiver aberta é comentada e fecha SOZINHA após 2 execuções. Esse
   fechamento é consequência do rollback, não prova de que a causa foi
   resolvida: registrar a causa no item 6 abaixo antes de religar o switch.
   Também desligar (ou deixar de armar) a task agendada do executor Kit.
5. **Nunca resetar histórico/cursor** durante o rollback — mesma regra do
   corte (seção 2, item 1). O rollback é sobre TRANSPORTE FUTURO, nunca uma
   reescrita do que já aconteceu.
6. **Registrar o rollback** como comentário na issue #7922 (ou uma issue
   dedicada, se o motivo for um bug específico) com: motivo, lotes
   cancelados/reconciliados, e se alguma entrada precisou de intervenção
   manual (sem PII).

## 7. Fora de escopo deste documento

- Não encerra a conta Brevo (fora de escopo da própria issue).
- Não migra reativação/diária/outros envios (só onboarding).
- Não decide comprar plano Kit pago — o desenho inteiro pressupõe Free.
- Não antecipa/reabre as recuperações históricas #7665/#7675.
- Não implementa o guard de mútua-exclusão do item 2.4 — está listado aqui
  como pré-requisito BLOQUEANTE do cutover, mas a implementação em si fica
  para quando o cutover for de fato autorizado (para não construir um guard
  às cegas antes de o piloto confirmar o desenho).
