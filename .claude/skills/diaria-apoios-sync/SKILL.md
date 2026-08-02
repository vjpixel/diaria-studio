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

Sem `--push`, o script só LÊ (apoia.se + Beehiiv) e imprime o diff calculado
em stderr:
- adições/trocas de nível (`toApply`)
- remoções (`toRemove`) — e se estão bloqueadas por dados parciais
- contatos "sem_dados" pulados (nível desconhecido, nunca "sem apoio")
- apoiadores sem nenhuma subscription Beehiiv casada
- guard de blast radius (quantas remoções / quantos têm nível hoje, e se
  excede o limiar de 30%)

Apresentar esse diff ao editor: quem entra, quem troca de faixa, quem sai
(com o `fromLevel`/`toLevel`), e o veredito do guard de blast radius.

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

## Passo 4 — pós-push: recalcular e reconferir

1. Para cada um dos 6 segmentos: `mcp__claude_ai_Beehiiv__recalculate_segment`
   (**hoje bloqueado pelo plano** — mesmo gate de `save_segment`; se falhar
   com `not available on your current plan`, não é erro desta skill, é
   limitação de conta. Os segmentos são `dynamic` e a própria Beehiiv os
   "regenera diariamente" — anotar que o `num_members` pode ficar
   temporariamente defasado até o próximo ciclo automático, não até 24h
   necessariamente igual ao envio).
2. `mcp__claude_ai_Beehiiv__get_segment` nos 6 de novo → ler `num_members`
   atual e comparar contra o diff aplicado no Passo 3 (quantos entraram,
   quantos saíram deveria bater aproximadamente com a variação de
   `num_members`, respeitando o caveat acima de defasagem).

## Passo 5 — relatório final

Apresentar ao editor:
- Contagem por faixa (Amigo/Apoiador/Mantenedor/Patrono/Todos/Nenhum), do
  `num_members` relido no Passo 4.
- Apoiadores/contatos **sem vínculo Beehiiv** (`diff.notBeehiivSubscriber`) —
  pagam mas não têm subscription casada, nunca receberiam a recompensa por
  e-mail.
- Assinantes com `apoio_nivel` setado na Beehiiv mas **sem apoio ativo** nem
  no mês corrente nem no anterior (resíduo — deveriam ter sido removidos
  neste `--push`; se ainda aparecerem depois de um `--push` bem-sucedido, é
  sinal de falha silenciosa a investigar, não normal).

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
