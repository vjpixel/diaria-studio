---
name: diaria-apoios-sync
description: Sincroniza o nível de recompensa de apoio (apoia.se) com o custom field `apoio_nivel` na Beehiiv, checando antes que os 6 segmentos `Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}` ainda condicionam nesse campo (drift check). Dry-run por padrão; `--push` grava de verdade. Uso — `/diaria-apoios-sync [--push] [--allow-partial] [--force-blast-radius]`.
---

# /diaria-apoios-sync

Fecha o loop entre o CRM de Apoios (apoia.se) e a segmentação de envio da
Beehiiv: escreve o nível de recompensa (Amigo/Apoiador/Mantenedor/Patrono) no
custom field `apoio_nivel` de cada assinante apoiador, e confirma que os 6
segmentos que CONSOMEM esse campo ainda estão configurados corretamente antes
de gastar o push. Sem argumento de data — roda sobre o estado atual, não uma
edição específica.

Contexto (#4436): os 6 segmentos foram criados à mão em 260729 condicionando
em `subscriber_tag` (desenho refutado — não existe escrita de tag por
assinante na Beehiiv). Corrigidos ao vivo em 260802 pra condicionar no custom
field `apoio_nivel`. Essa correção é FRÁGIL — qualquer edição manual futura
pela UI da Beehiiv pode reintroduzir o mesmo bug (condicionar em tag, ou em
qualquer outra coisa) sem que ninguém perceba até um envio segmentado errar o
alvo de novo. Por isso o passo 1 desta skill sempre confere antes de seguir.

## Passo 1 — drift check dos 6 segmentos

1. `mcp__claude_ai_Beehiiv__list_segments` com `publication_id` de
   `platform.config.json` (`beehiiv.publicationId`) → localizar os 6 pelo
   nome exato (`Apoio — Amigo`, `Apoio — Apoiador`, `Apoio — Mantenedor`,
   `Apoio — Patrono`, `Apoio — Todos`, `Apoio — Nenhum`).
2. `mcp__claude_ai_Beehiiv__get_segment` em cada um dos 6 IDs — extrai o
   campo `where`.
3. Comparar contra `APOIO_SEGMENTS_CANONICAL` de
   `scripts/lib/apoio-segments-canonical.ts` via `computeSegmentDrift`
   (`isSegmentConverged` já tolera espaçamento/ordem diferente da UI — nunca
   comparar string crua à mão).
4. **Se `allSegmentsConverged(drift) === true`**: prosseguir direto pro
   Passo 2, sem tocar em nada (idempotente).
5. **Se houver drift**: reportar ao editor quais segmentos divergem (nome +
   `where` atual vs canônico) e corrigir pela UI via Chrome, no MESMO padrão
   usado em #4436 (mutação pela UI, verificação determinística pela API —
   nunca aceitar "a tela mostrou que salvou"):
   - `get_segment(segment_id).editor_url` → navegar até lá
     (`mcp__claude-in-chrome__navigate`).
   - Editar a(s) condição(ões) divergente(s): trocar `Subscriber tags` por
     `Custom field` → selecionar `apoio_nivel` → operador (`is` pra uma das 4
     faixas + valor exato `amigo`/`apoiador`/`mantenedor`/`patrono`; `exists`
     pra Todos; `does not exist` pra Nenhum) → `Status is Active` continua
     como condição AND separada.
   - Clicar "Update segment".
   - **Reler com `get_segment` e reconferir contra o canônico antes de
     seguir** — `save_segment`/`get_segment_schema`/`recalculate_segment` via
     MCP estão bloqueados pelo plano Launch (`not available on your current
     plan`), então a mutação É pela UI mesmo, não um atalho de API.
   - Se a extensão Claude in Chrome não estiver logada, ou a navegação falhar
     de forma não-óbvia: **não force login**, pare este passo, documente o
     que falta, e pare a skill inteira aqui — os passos 2-4 dependem de os
     segmentos estarem corretos (rodar o sync com segmentos errados é
     exatamente o bug que #4436 corrigiu).

## Passo 2 — dry-run do sync

```
npx tsx scripts/sync-apoio-nivel-beehiiv.ts
```

Sem `--push`, o script nunca escreve na Beehiiv — mas não é 100% sem efeito
colateral: pode escrever LOCALMENTE (`contacts.jsonl`/`pending-promises.jsonl`,
ver mecanismos automáticos abaixo) antes de imprimir o diff calculado em
stderr:
- adições/trocas de nível (`toApply`)
- remoções (`toRemove`) — e se estão bloqueadas por dados parciais
- contatos "sem_dados" pulados (nível desconhecido, nunca "sem apoio")
- apoiadores que não casaram por e-mail exato, com candidatos heurísticos
  (#4490 causa 3, ver Passo 5)
- guard de blast radius (quantas remoções / quantos têm nível hoje, e se
  excede o limiar de 30%)

Apresentar esse diff ao editor: quem entra, quem troca de faixa, quem sai
(com o `fromLevel`/`toLevel`), e o veredito do guard de blast radius.

**Antes do diff, o script já roda 2 mecanismos automáticos (#4490), mesmo em
dry-run** — nenhum dos dois grava na Beehiiv, só refinam o dado de entrada
(apoia.se + `contacts.jsonl`) antes de calcular o diff:
- **TTL do cache do mês corrente** (causa 1/2): uma entrada `isPaidThisMonth:
  false` com mais de 8h desde a última consulta é reconsultada
  automaticamente (`checkBacker`) — não precisa mais do botão "Atualizar
  status" do painel pra pegar pagamento que entrou depois da 1ª consulta do
  mês.
- **Reconciliação de promessas pendentes** (causa 4): drena promessas novas
  do Gmail + reconsulta as já pendentes em `data/apoia-se/{campaign}/pending-promises.jsonl`
  — se alguma confirmou pagamento, promove a contato ANTES do cálculo do
  diff (então já aparece em `toApply` na mesma rodada). Falha (Gmail
  indisponível, credenciais ausentes) é fail-soft — vira aviso em stderr,
  nunca aborta o sync.

## Passo 3 — gate de decisão

Perguntar ao editor se aplica (`AskUserQuestion` ou equivalente). Opções:
- **Aplicar** → rodar com `--push`.
- **Não aplicar** → parar aqui, nada foi escrito.
- Se o guard de blast radius apareceu como "EXCEDIDO" no dry-run: avisar
  explicitamente que só há remoção em massa se `--force-blast-radius` for
  usado, e perguntar se é isso mesmo que o editor quer (não assumir).
- Se houver `sem_dados` bloqueando remoções: avisar que `--allow-partial`
  seria necessário pra forçá-las, e que o padrão (sem a flag) já aplica as
  adições/trocas normalmente — só as remoções ficam pendentes.

```
npx tsx scripts/sync-apoio-nivel-beehiiv.ts --push [--allow-partial] [--force-blast-radius]
```

Nunca rodar `--push` sem o editor ter visto o diff do Passo 2 primeiro.

## Passo 4 — pós-push: refresh manual + gate de reconferência (#4485 item 1)

**Verificado ao vivo em 260802 (#4485): o recálculo pós-`--push` NÃO é
automático.** `recalculate_segment`/`save_segment` seguem bloqueados pelo
plano Launch — isso já era sabido. O que mudou: mudar o **VALOR** de um
custom field (exatamente o que `--push` faz) não dispara reprocessamento
nenhum, nem "no próximo ciclo diário" — o teste ao vivo mostrou `Apoio —
Todos` com `total: 0` mesmo com 16 assinantes recém-gravados. Segmento na
Beehiiv é **lista materializada**, não query ao vivo — sem o refresh manual,
um envio segmentado no MESMO DIA do push acerta a lista ANTIGA (exatamente a
classe de erro que o #4436 existiu pra eliminar). O que aparenta "regenerar
sozinho" no #4436 era outra coisa: mudar a CONDIÇÃO do segmento (não o valor
do campo) dispara reprocessamento na hora — não generaliza pra mudança de
valor.

1. Para cada um dos 6 segmentos, via Chrome: `get_segment(segment_id).editor_url`
   → navegar até lá → aba **Overview** (não Configure) → clicar **"Refresh
   segment"**. Nem sempre pega na 1ª tentativa (medido: 4 de 6 pegaram no
   1º refresh, 2 precisaram de uma 2ª rodada) — é o Passo 4.2 abaixo que
   detecta isso, não assumir sucesso pelo clique.
2. `mcp__claude_ai_Beehiiv__get_segment` nos 6 de novo → ler `num_members`
   atual de cada um. Obter `activeBase` (total de assinantes ativos da
   publicação) via `mcp__claude_ai_Beehiiv__get_publication_stats` com o
   mesmo `publication_id` do Passo 1 (`platform.config.json` →
   `beehiiv.publicationId`) e `time_period: "all_time"` — o campo de
   assinantes ativos do resumo, não uma janela de tempo curta. Rodar
   `evaluateSegmentCountGate` (`scripts/lib/apoio-segments-canonical.ts`)
   com `{amigo, apoiador, mantenedor, patrono, todos, nenhum}` lidos +
   esse `activeBase` — **gate de verdade**, não estimativa: se
   `gate.ok === false`, o refresh NÃO pegou em
   algum segmento (`tiersMatchTodos: false` → confira Todos e as 4 faixas;
   `totalMatchesActiveBase: false` → confira Nenhum). Repetir o "Refresh
   segment" nos segmentos suspeitos e reler até `gate.ok === true` — nunca
   declarar sucesso com o gate falhando.

## Passo 5 — relatório final

Apresentar ao editor:
- Contagem por faixa (Amigo/Apoiador/Mantenedor/Patrono/Todos/Nenhum), do
  `num_members` relido e confirmado pelo gate do Passo 4.
- Apoiadores/contatos que **não casaram por e-mail exato**
  (`diff.notBeehiivSubscriber`, #4490 causa 3) — pagam mas o e-mail da
  apoia.se não bate com nenhuma subscription Beehiiv; **não é necessariamente
  "não assina a newsletter"**, pode assinar com outro endereço. Cada entrada
  já vem com `candidates` (heurísticas: local-part normalizado, nome no
  local-part, domínio próprio, variação/typo — `scripts/lib/apoio-email-heuristics.ts`)
  — apresentar os candidatos ao editor pra confirmação manual; **nunca casar
  um e-mail sozinho** com base num candidato heurístico. Contatos que
  persistem sem vínculo por várias rodadas seguidas: registrar como pergunta
  aberta pro editor — "isso deveria virar um alerta?" (#4485 item 3, decisão
  editorial pendente, não implementada).
- Assinantes com `apoio_nivel` setado na Beehiiv mas **sem apoio ativo** nem
  no mês corrente nem no anterior (resíduo — deveriam ter sido removidos
  neste `--push`; se ainda aparecerem depois de um `--push` bem-sucedido, é
  sinal de falha silenciosa a investigar, não normal).
- Se `scripts/lib/apoio-promise-store.ts` reportou promessa(s) promovida(s) a
  contato nesta rodada (#4490 causa 4) — mencionar quem entrou por essa via
  (promessa que confirmou pagamento entre uma rodada e outra).

## Regras invioláveis desta skill

- **Dry-run é o default.** `--push` é sempre explícito, nunca implícito por
  contexto (ex: "roda de novo" não vira `--push` sozinho).
- **Nunca pular o Passo 1** mesmo que pareça óbvio que os segmentos estão
  certos — é exatamente esse tipo de suposição que causou o bug original de
  #4436 (segmentos criados certos na intenção, errados na condição, e
  ninguém percebeu por dias).
- **Carência de 1 mês e guard de blast radius são do script, não desta
  skill** — `scripts/sync-apoio-nivel-beehiiv.ts` já aplica os dois
  internamente (ver cabeçalho do arquivo); esta skill só invoca, apresenta o
  resultado, e faz o gate humano.
- **Nunca usar `--force-blast-radius` ou `--allow-partial` sem confirmação
  explícita do editor** — são escape hatches de decisões conscientes, não
  default de conveniência.
- **Nunca declarar o Passo 4 concluído com `evaluateSegmentCountGate(...).ok === false`**
  (#4485 item 1) — um refresh que não pegou em algum segmento é indistinguível
  de "deu certo" olhando só a tela; o gate de `num_members` é o único sinal
  confiável.

## Cadência (#4485 item 2)

Invocação desta skill é manual — sem nenhuma automação, `apoio_nivel` só
fica correto enquanto alguém lembrar de rodar. A task agendada
`Diaria-Apoios-Diff-Alarm` (`scripts/setup-apoios-diff-alarm-schedule.ps1`,
**registro real pendente pro editor** — ver seção de tasks no `CLAUDE.md`)
roda diariamente só o DRY-RUN (`scripts/apoios-diff-alarm.ts`) e manda um
e-mail ao editor quando há diff pendente (adições/trocas/remoções) — nunca
`--push` automático, o gate humano desta skill (Passo 3) continua sendo a
única forma de gravar de verdade.
