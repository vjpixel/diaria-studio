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
   nesses campos (docstring do módulo, "sem criar outra fonte de verdade") e
   nunca reprocessa uma entrada que a Brevo já tratou — a decisão de "due"
   em `onboarding-state.ts` é por TEMPO (âncora + dias), não por transporte,
   então uma entrada com `email1_sent_at` preenchido nunca aparece de novo
   como candidata a e-mail 1 em nenhum dos dois executores.
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
4. **Risco identificado e MITIGADO (#8966, guard implementado).** Os dois
   executores rodam sobre o MESMO `selectCandidatesNeedingRefresh`/
   `buildRunPlan`, e se ambos tiverem seus respectivos "envio" habilitado ao
   mesmo tempo, um candidato de e-mail 1 due poderia, em teoria, ser
   processado por AMBOS na mesma rodada (Brevo envia via
   `POST /smtp/email`, Kit cria um broadcast) — duplicando o e-mail 1 para
   quem confirma exatamente na janela de transição. **Mitigação:**
   `filterBrevoPlanForKitCutover` (`scripts/lib/onboarding-state.ts`),
   aplicado pelo `onboarding-welcome-run.ts` sobre o plano JÁ MONTADO por
   `buildRunPlan`, logo após lê-lo de `onboarding.kit_transport.enabled` do
   `platform.config.json` — kill switch desligado é passagem livre (estado
   atual em produção). Ligado: e-mail 1 é sempre recusado pelo lado Brevo
   (por definição, todo candidato de e-mail 1 é uma entrada nova, sem
   histórico em nenhum transporte — o Kit passa a servir toda entrada nova a
   partir do corte); e-mail 2 só continua na Brevo se a entrada tiver
   `email1_brevo_id` preenchido (prova de que o e-mail 1 dessa escada já
   saiu pela Brevo) — sem esse id, a escada começou no Kit e a Brevo recusa,
   igual ao e-mail 1. `email3_campaign` fica fora do escopo do guard (o
   e-mail 3 já é sempre rascunho com aprovação humana explícita — risco de
   duplicação automática não se aplica). Teste de regressão:
   `test/onboarding-brevo-kit-mutex-8966.test.ts`.
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
- [ ] Painel do Studio (`/assinantes`, #7917/#8955) mostrando os lotes Kit
      corretamente para pelo menos 1 ciclo completo em dry-run.

Sequência de flip:

1. `platform.config.json` → `onboarding.kit_transport.enabled: true`.
   Commitado, revisado, nunca editado direto em produção sem PR (mesma
   disciplina de "pipeline reproducible" do `CLAUDE.md`).
2. Rodar `onboarding-kit-transport-run.ts` (sem `--send`) uma vez para
   conferir o PLANO antes de qualquer escrita — o dry-run já reflete o
   estado real (kill switch só bloqueia escrita, nunca leitura).
3. Primeira rodada com `--send` real: acompanhar o `summary` impresso
   (lotes criados, `excluded`, `skips`) e confirmar no painel Kit
   (broadcasts criados como rascunho/agendado, nunca `public`).
4. Confirmar no Studio (#7917) que as entradas processadas aparecem com
   `provider: "kit"` no funil.

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

O que o piloto precisa validar (todos os itens da issue, seção "Piloto e
transição"):

| Item | Como verificar | Onde registrar |
|---|---|---|
| Segmentação | Confirmar no painel Kit que o broadcast do lote atingiu SÓ a tag `onboarding-{lot_id}` — nunca a base inteira. Comparar contagem esperada (`recipient_emails.length` do lote) com o destinatário real reportado pelo Kit. | Comentário na issue com contagem, sem PII (só números). |
| Entrega | Confirmar recebimento nas caixas de teste (inbox, não spam) para os 3 e-mails. | Idem — agregado, nunca lista de e-mails/nomes na issue. |
| Renderização | Abrir o e-mail recebido: HTML íntegro, sem quebra de layout, personalização (se houver merge tag) resolvida, link de descadastro presente e funcional. | Idem. |
| Métricas | Rodar `--reconcile` após o envio e conferir que o status do lote reflete o real (`scheduled`/`completed`) — e, quando disponível, `fetchSubscriberStatsKit`/`GET /subscribers/{id}/stats` mostrando a abertura do destinatário de teste (mesmo endpoint que o e-mail 3 usa para elegibilidade; ver seção 5 sobre a validação já feita neste PR). | Idem. |
| Repetição segura | Rodar `--send` uma 2ª vez com o MESMO lote já criado — confirmar via `summary.lots[].skipped === "reuse"` que nada duplica (mecanismo já testado em `test/onboarding-kit-transport-run-lock-7922.test.ts`, mas nunca contra a API real). | Idem. |
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
3. **Nunca fallback cego**: se a decisão for "voltar a enviar pela Brevo"
   para as entradas que ficaram sem transporte, isso exige, para CADA
   entrada afetada, confirmar que ela NÃO tem um lote Kit `completed`/
   `scheduled` ativo para aquela etapa (`findKitLotForEntry`, já exportado
   por `onboarding-funnel-report.ts`, é a consulta certa) antes de deixar
   `onboarding-welcome-run.ts` processá-la — nunca reativar o Brevo como
   transporte "por via das dúvidas" sem essa checagem, porque duplicaria
   exatamente o e-mail que o rollback deveria evitar duplicar.
4. **Nunca resetar histórico/cursor** durante o rollback — mesma regra do
   corte (seção 2, item 1). O rollback é sobre TRANSPORTE FUTURO, nunca uma
   reescrita do que já aconteceu.
5. **Registrar o rollback** como comentário na issue #7922 (ou uma issue
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
