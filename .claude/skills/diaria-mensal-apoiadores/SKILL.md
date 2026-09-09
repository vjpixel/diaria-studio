---
name: diaria-mensal-apoiadores
description: Envia a edição mensal (data/monthly/{ciclo}/draft.md) por e-mail pros apoiadores dos níveis Mantenedor/Patrono — skill manual e separada do fluxo 0-5 de /diaria-mensal (o editor decide o timing). Canal Kit (migrado de Brevo, #7633; e a Brevo tinha migrado da Beehiiv, #4572). Cria SEMPRE rascunho — o disparo é ação humana no painel. Uso — `/diaria-mensal-apoiadores --cycle YYMM-MM [--force] [--mark-sent]`.
---

# /diaria-mensal-apoiadores

> **STATUS (#7655, 08/09/2026): canal migrado pra Kit, audiência populada,
> falta o 1º broadcast Kit. O canal Brevo anterior JÁ ENVIOU uma vez.**
>
> Entrega o recap mensal como recompensa Mantenedor/Patrono
> (`data/snippets/agradecimento-apoiadores.md`), prometida desde #4482. Reusa
> o MESMO `draft.md` que vai pra Clarice, trocando só a AUDIÊNCIA (tag
> `kit_apoiadores.audience_tag`) e removendo o conteúdo Clarice-only.
>
> **O envio de 04/08/2026 (ciclo 2607-08) aconteceu de verdade** — campanha
> Brevo 12, "Mensal apoiadores 2607-08", lista 8 (Mantenedor+Patrono): 10
> entregues, 4 aberturas únicas, 5 clickers, 2 cliques únicos. Medido na API
> em 08/09/2026 (#7655). Até então TODA a documentação desta skill afirmava o
> contrário — ver "⚠️ O state local não é prova de envio" abaixo, que é a
> lição de método, não uma nota de rodapé.
>
> **Estado da audiência:** `sync-apoio-mensal-tag-kit.ts --push` rodou em
> 08/09/2026 e criou a tag `apoio-mensal` (id 23210615) com os 8
> Mantenedor/Patrono do momento. Quem recebeu em agosto e não está mais:
> 1 caiu pra `apoiador` (R$10–25, abaixo do corte), 2 estão sem `apoio_nivel`
> (apoio não vigente) e 1 está blacklisted na Brevo e não existe no Kit.
>
> **O que falta pro 1º envio Kit:** rodar o Passo 2 abaixo sem `--dry-run` e
> conferir o rascunho no painel. Nenhum broadcast Kit foi criado ainda.

## ⚠️ O state local não é prova de envio

`beehiiv-apoiadores-state.json` registra o que os SCRIPTS fizeram, e
`--mark-sent` é um passo manual. O envio de 04/08 saiu à mão pela UI da Brevo
e ninguém rodou `--mark-sent` — o state ficou em `draft_prepared` para sempre.

Isso enganou por um mês, e enganou em cadeia: as docstrings do #4572/#4593
foram escritas num worktree isolado SEM credencial Brevo, concluíram "a lista
está vazia, nada foi enviado" a partir de uma leitura que nunca aconteceu, e
todo texto posterior (inclusive o do #7633) repetiu isso como fato
estabelecido. A verificação que resolveu foi uma chamada à API da Brevo.

**Regra prática:** antes de afirmar que um canal nunca enviou, perguntar ao
ESP. O repo só sabe o que foi feito através dele.

**Skill manual e SEPARADA de `/diaria-mensal`** (decisão do #4521): o editor
decide quando disparar, independente do timing do envio Clarice do mês.

## Por que Kit

Beehiiv (#4482) → Brevo (#4572/#4593) → Kit (#7633). A 1ª troca foi forçada
por bloqueio de plataforma (a Beehiiv gateia segmentação multi-condição atrás
do plano Scale, e nunca chegou a enviar); esta é consolidação:
`publishing.newsletter.backend` virou `"kit"` (#7388) e a base inteira migrou
(#7386, Beehiiv 317 → 0 ativos). Manter um 2º ESP vivo só pra este envio era
manutenção sem contrapartida.

**O que a troca custa (correção do #7655):** a Brevo enviou 1 edição real,
com audiência e engajamento medidos — não é um canal natimorto. O Kit começa
do zero em série histórica, e comparar o desempenho do 1º envio Kit com o de
04/08 exige ir buscar os números na Brevo (campanha 12), porque eles não
migram junto. Os scripts `*-apoiadores-brevo.ts` e a chave `brevo_apoiadores`
continuam no repo; quando forem removidos, o registro daquele envio precisa
sobreviver em algum lugar — aposentar o canal não é fingir que ele não rodou.

## ⚠️ Audiência é TAG, nunca segmento

A conta Kit já tem os 6 segmentos `Apoio — {…}` condicionados no custom field
`apoio_nivel` (`scripts/lib/apoio-segments-canonical-kit.ts`) — parecem o
alvo óbvio de `subscriber_filter`, e não servem:

- `GET /v4/subscribers?segment_id=X` **ignora silenciosamente** o parâmetro (o
  total volta com a conta inteira, medido nos 6 segmentos em 24/08/2026), e
  não existe rota que liste quem está num segmento. Mirar segmento é enviar
  sem poder conferir a audiência — nem antes, nem depois.
- Membresia de TAG é legível (`GET /v4/tags/{id}/subscribers`), então a tag é
  o alvo. Os segmentos ficam como conveniência de navegação no painel.

E o modo de falha é assimétrico: `subscriber_filter` ausente/não resolvido no
Kit significa **base INTEIRA** (#6126) — o erro manda conteúdo exclusivo de
apoiador pra todo mundo, não deixa de enviar. Por isso o publisher recusa
criar broadcast com tag não resolvida ou vazia.

A tag é **projeção** do custom field, não uma 2ª fonte de verdade: quem decide
nível (com carência de 1 mês e guard de blast radius) é
`sync-apoio-nivel-kit.ts` (#6049).

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo `YYMM-MM` (ex: `--cycle 2607-08`).
  **Obrigatório, sempre explícito** — nunca inferir de `today()` (regra
  invariável do CLAUDE.md). Aceita o legado `YYMM` com derivação automática +
  warning (`requireMonthlyCycleArg`).
- `--force` (opcional) = usado por dois comandos distintos, mesmo state file:
  - `send-monthly-apoiadores.ts --force` (Passo 1): re-prepara/regenera o HTML
    mesmo com o ciclo já `sent`.
  - `publish-monthly-apoiadores-kit.ts --force` (Passo 2): cria um novo
    broadcast mesmo com `kitBroadcastId` já gravado ou ciclo `sent`. O
    rascunho anterior NÃO é excluído automaticamente — vira órfão no painel, e
    o comando avisa nomeando o id.
- `--mark-sent` (opcional) = **não prepara nada** — só registra que o EDITOR
  já enviou de verdade pela UI (Passo 3). Sem preparo prévio dá erro; rodar 2x
  é idempotente.

## Pré-requisitos

1. `_internal/public-images.json` do ciclo já existe — rodar a Etapa 3/4 do
   `/diaria-mensal` (`monthly-preview-cloudflare.ts`) antes, mesmo que o envio
   Clarice ainda não tenha acontecido (o preview já sobe as imagens pro KV).
2. `KIT_API_KEY` no ambiente (mesma credencial do resto do canal Kit).
3. Tag de audiência existente e não-vazia — Passo 0 abaixo.

## Passo 0 — Audiência (obrigatório antes do 1º envio de cada ciclo)

```bash
npx tsx scripts/sync-apoio-mensal-tag-kit.ts
```

Dry-run: mostra quem entraria e quem sairia da tag `apoio-mensal`, sem tocar
em nada. Para aplicar:

```bash
npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push
```

Cria a tag se ainda não existir, adiciona quem virou Mantenedor/Patrono,
remove quem deixou de ser. Cada mutação é confirmada por releitura (o `2xx` do
Kit não é prova de escrita). Remoções acima de 30% da tag bloqueiam o `--push`
inteiro — `--force-blast-radius` destrava, sempre logado. Falha SISTÊMICA
(credencial, rate limit, 5xx) aborta o resto do `--push` na hora, em vez de
repetir o mesmo erro em cada contato restante e produzir um relatório de N
falhas escondendo a causa única — re-rodar é seguro, o sync é idempotente.

Rodar `sync-apoio-nivel-kit.ts --push` ANTES, se o `apoio_nivel` do ciclo
ainda não estiver atualizado: este sync só projeta o que aquele decidiu.

## Passo 1 — Reservar o ciclo (opcional, recomendado)

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE
```

Renderiza o HTML da variante Kit (o MESMO render do Passo 2) e grava
`data/monthly/$CYCLE/_internal/beehiiv-apoiadores-state.json` com
`status: "draft_prepared"` (nome do arquivo é resíduo histórico do fluxo
Beehiiv; o conteúdo é channel-agnostic). Opcional — o Passo 2 funciona sem
ele —, mas sem esse state prévio o `--force`/`--mark-sent` do Passo 1 não têm
o que referenciar.

## Passo 2 — Publicar (cria o broadcast Kit, sempre rascunho)

```bash
# Preview local — NUNCA chama a API do Kit, nem lê/grava o state.
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE --dry-run

# Cria o broadcast de verdade — SEMPRE rascunho (send_at: null).
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE
```

- Renderiza a variante Kit (`lib/mensal/monthly-apoiadores-kit-render.ts`):
  filtro de seções Clarice-only reusado sem modificação, UTM próprio
  (`mensal-apoiadores-kit`), merge tag Liquid do Kit no voto do "É IA?"
  (`{{ subscriber.email_address }}`), relink pras edições diárias de origem
  (#4048).
- Escreve `data/monthly/$CYCLE/_internal/apoiadores-kit-preview.html`.
- Fora de `--dry-run`: resolve a tag por NOME (nunca cria), confere que ela
  tem membros, e cria o broadcast com `subscriber_filter` de tag,
  `send_at: null` e **`public: false`** — sem `public_url`, pra recompensa de
  apoiador não virar página pública (a anual e a diária usam `public: true`
  justamente pelo motivo inverso).
- **Depois de criar, relê o broadcast e confere o `subscriber_filter` que a
  API de fato aplicou** — o 2xx da criação não é prova de que o filtro pegou,
  e o erro que passaria batido aqui é o pior possível (rascunho mirando a base
  inteira). Divergência aborta ALTO, gravando antes o `kitBroadcastId` com
  `kitAudienceVerified: false` pra que uma reexecução não crie um 2º rascunho
  por cima do problema. Falha de REDE na releitura é fail-soft: vira
  `kitAudienceVerified: null` + aviso, porque o broadcast já existe de todo
  jeito. Mesma disciplina de `kit-diaria-stage5-dispatch.ts` (#6582).
- Aborta (exit 2) se: `kit_apoiadores.audience_tag` ausente, `KIT_API_KEY`
  ausente, tag inexistente, tag vazia, ou guard de idempotência.
- **Idempotência:** fora de `--dry-run`, lê o state antes de criar e recusa um
  2º broadcast pro mesmo ciclo (`kitBroadcastId` gravado ou ciclo `sent`);
  `--force` ignora. Depois de criar, grava o id de volta.

Depois de criado, ação manual do editor no painel do Kit:
1. Test send (Broadcasts → o rascunho → Send preview) pra conferir
   visualmente.
2. Escolher um dia SEM edição diária pesada antes de disparar (decisão 1 do
   #4482 — evitar 2 e-mails no mesmo dia).
3. Send/Schedule pela UI.

## Passo 3 — Confirmar o envio

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE --mark-sent
```

Grava `status: "sent"` + `sentAt` no state local. Sem isso, nada registra que
o ciclo já saiu, e o Passo 1 continuaria "permitido" indefinidamente. Depois
de marcado, uma nova tentativa dos Passos 1/2 pro MESMO ciclo é bloqueada por
padrão; `--force` cobre o caso legítimo "preciso reenviar uma correção".

## Saídas

- `data/monthly/{ciclo}/_internal/apoiadores-kit-preview.html` — HTML do
  broadcast (UTM `mensal-apoiadores-kit`).
- `data/monthly/{ciclo}/_internal/beehiiv-apoiadores-state.json` — estado de
  idempotência (`draft_prepared` | `sent`, timestamps, `kitBroadcastId`,
  `kitAudienceVerified`, e o `brevoCampaignId` legado quando existir). Os dois
  ids coexistem de propósito: o guard de cada canal lê o campo do seu canal.
  **`kitAudienceVerified: false` é registro de INCIDENTE** — existe um rascunho
  no Kit cuja audiência divergiu do esperado e precisa ser conferida à mão
  antes de qualquer disparo; `null` significa "não confirmável" (a releitura
  falhou ou a API não ecoou o campo), não "ok".
- Broadcast criado como rascunho na conta Kit (id no stdout), visível em
  `Broadcasts → Drafts`.

## Conteúdo: decisão do #4482 preservada, não reaberta

O espaço deixado vazio pelas seções `CLARICE — DIVULGAÇÃO`/`CLARICE —
TUTORIAL` removidas **fica vazio** — decisão do editor no #4482 (comentário
260803, decisão 3). A sugestão do #4521 de preencher com os snippets Patronos
da diária (`data/snippets/patronos-*.md`) segue não adotada: além de já
decidida, esses snippets são específicos do nível Patrono, então estendê-los
ao mensal/Mantenedor arrastaria uma decisão de copy por nível que ninguém
tomou. Reabrir é questão de produto — registrar como comentário na issue.

## Escopo explícito

O disparo real (test send, Send/Schedule) continua manual no painel do Kit.
O que a skill garante: conteúdo certo, audiência certa e auditável, broadcast
SEMPRE criado como rascunho, e dedup entre Passo 1 (estado) e Passo 2
(broadcast real).
