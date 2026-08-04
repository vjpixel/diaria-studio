---
name: diaria-mensal-apoiadores
description: Envia a edição mensal (data/monthly/{ciclo}/draft.md) por e-mail pros apoiadores dos níveis Mantenedor/Patrono — skill manual e separada do fluxo 0-5 de /diaria-mensal (o editor decide o timing). CANAL EM MIGRAÇÃO de Beehiiv pra Brevo (#4572, ver nota logo abaixo) — o mecanismo descrito neste arquivo ainda é o antigo (Beehiiv); a ponte de audiência Brevo (scripts/sync-apoio-nivel-brevo.ts) já existe, o Passo 2 abaixo ainda não foi reescrito. Uso — `/diaria-mensal-apoiadores --cycle YYMM-MM [--force] [--mark-sent]`.
---

# /diaria-mensal-apoiadores

> **STATUS (#4572, 260804): canal em migração de Beehiiv pra Brevo — este
> SKILL.md ainda descreve o fluxo ANTIGO.** A Beehiiv bloqueia "Include and
> exclude segments" (o mecanismo de audiência que o Passo 2 abaixo depende)
> atrás do plano Scale — o workspace é Launch/free. Decisão do editor:
> reescrever pra Brevo, reusando a maquinaria de `publish-daily-brevo.ts`.
> **Já pronto:** `scripts/sync-apoio-nivel-brevo.ts` — espelho de
> `scripts/sync-apoio-nivel-beehiiv.ts` (#4436) que converge a membresia de
> uma lista Brevo dedicada (`platform.config.json` → `brevo_apoiadores.list_id`,
> ainda `null` — lista não criada na conta Brevo do editor) com quem tem nível
> Mantenedor/Patrono. **Ainda pendente:** reescrever o Passo 2 (Publicar)
> abaixo pro fluxo Brevo de verdade (criar campanha via API `emailCampaigns`
> em vez de colar no Beehiiv) e avaliar rename de
> `scripts/lib/mensal/monthly-beehiiv-render.ts`/`scripts/render-monthly-beehiiv.ts`
> — entrelaçado com `scripts/lib/shared/utm-registry.ts` (registro de
> atribuição), decisão maior que ficou pra próxima rodada (ver PR #4572). Até
> lá, o texto abaixo (Beehiiv) continua sendo o mecanismo REAL — não confundir
> com o canal-ALVO (Brevo).

Entrega o "artigo especial do mês" já anunciado como recompensa Mantenedor/
Patrono (`context/snippets/agradecimento-apoiadores.md`) — hoje só existe como
página paywall do worker `artigo-mensal`, sem nenhum aviso ativo pro
assinante (#4521). Esta skill fecha esse ciclo: reusa o MESMO `draft.md` que
já vai pra Clarice/Brevo, trocando só a AUDIÊNCIA (Beehiiv, segmentos
`Apoio — Mantenedor`/`Apoio — Patrono`) e removendo o conteúdo Clarice-only.

**Skill manual e SEPARADA de `/diaria-mensal`** (decisão do #4521, ver "não
uma etapa nova dentro de /diaria-mensal") — o editor decide quando disparar,
independente do timing do envio canônico Clarice/Brevo do mês.

## Relação com #4482

A issue #4482 (fechada, merge #4510) já entregou o módulo de render
(`scripts/render-monthly-beehiiv.ts` / `scripts/lib/mensal/monthly-beehiiv-render.ts`)
e as 4 decisões de produto (cadência = envio extra num dia sem edição pesada;
segmento = só Mantenedor/Patrono; seções Clarice removidas sem substituição;
plataforma = Beehiiv). Esta skill (#4521) fecha os 3 gaps que o #4482 deixou
como follow-up explícito:

1. Skill própria (esta), não uma seção dentro do SKILL.md de `/diaria-mensal`.
2. Mecanismo de audiência multi-segmento **verificado de verdade** — ver
   Passo 2 abaixo. A Beehiiv suporta nativamente incluir/excluir até 5
   segmentos combinados na Audience page de um mesmo post
   (`mcp__claude_ai_Beehiiv__search_documentation` → "Options on the
   Audience page of the post flow", confirmado 260803). **Não é preciso
   criar um 7º segmento combinado** — a hipótese de precisar disso (texto
   original do #4482) está descartada.
3. Idempotência/dedup real — `scripts/lib/mensal/monthly-apoiadores-state.ts`,
   ver Passo 3.

**Conteúdo: mantém a decisão já tomada no #4482, não a reabre.** A issue
#4521 sugeriu reusar os snippets Patronos da diária
(`context/snippets/patronos-*.md`) no espaço deixado vazio pelas seções
Clarice removidas. Essa MESMA pergunta já tinha sido decidida ao vivo pelo
editor no comentário do #4482 (260803, decisão 3): "remover DIVULGAÇÃO/
TUTORIAL sem substituir por nada — mais simples, espaço reservado fica
vazio." Sem editor presente pra confirmar uma mudança de rumo, esta skill
preserva essa decisão (o espaço fica vazio) em vez de decidir sozinha por
conteúdo novo — os snippets Patronos, além disso, são específicos do nível
Patrono, então estendê-los pro mensal/Mantenedor arrastaria uma decisão de
copy por nível que ninguém tomou ainda. **Se o editor quiser reabrir essa
decisão**, é questão de produto, não técnica — registrar como comentário na
issue de acompanhamento.

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo no formato `YYMM-MM` (ex:
  `--cycle 2607-08`). **Obrigatório, sempre explícito** — nunca inferir a
  partir de `today()` (regra invariável do CLAUDE.md). Aceita o legado `YYMM`
  com derivação automática + warning, mesmo comportamento de
  `requireMonthlyCycleArg` (`scripts/lib/mensal/monthly-paths.ts`).
- `--force` (opcional) = permite re-preparar/regenerar o HTML mesmo se este
  ciclo já estiver marcado como `sent` no estado local. Sem essa flag, um
  ciclo `sent` bloqueia a preparação de novo (dedup real, #4521 questão 3) —
  proteção contra reabrir por engano o fluxo de uma edição já confirmada
  como enviada.
- `--mark-sent` (opcional) = **não prepara nada** — só registra no estado
  local que o EDITOR já enviou de verdade pela UI da Beehiiv (Passo 5 abaixo).
  Rodar sem preparo prévio dá erro; rodar 2x é idempotente (noop na 2ª vez).

## Pré-requisito

`_internal/public-images.json` do ciclo já existe — rodar a Etapa 3/4 do
`/diaria-mensal` (`monthly-preview-cloudflare.ts`) nesse ciclo antes, mesmo
que o envio Clarice em si ainda não tenha acontecido (o preview já sobe as
imagens pro KV independente do envio). Sem isso, `send-monthly-apoiadores.ts`
aborta com instrução clara.

## Passo 1 — Preparar (render + estado local)

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE
```

- Renderiza a variante Beehiiv (mesma lógica de `render-monthly-beehiiv.ts`
  — filtra seções Clarice-only, injeta UTM `mensal-beehiiv`, relinka
  destaques pra edição diária de origem).
- Escreve `data/monthly/$CYCLE/_internal/beehiiv-preview.html`.
- Grava/atualiza `data/monthly/$CYCLE/_internal/beehiiv-apoiadores-state.json`
  com `status: "draft_prepared"`.
- **Idempotente e seguro rodar de novo** enquanto o estado não for `sent` —
  só regenera o HTML a partir do `draft.md` mais recente.
- Se o ciclo já estiver `sent`, bloqueia com instrução pra usar `--force`
  (ver "Argumentos" acima).

Este script **NUNCA chama a API de escrita da Beehiiv** — produz só HTML e
estado locais (guard de publicação, invariante do repo).

## Passo 2 — Publicar (manual)

O comando acima já imprime o passo-a-passo completo (mesma técnica do
`context/publishers/beehiiv-playbook.md` §5 — browser + `javascript_tool` no
Custom HTML block). Resumo:

1. Colar o HTML de `beehiiv-preview.html` no Custom HTML block (os scripts de
   staging do playbook — `upload-html-public.ts`/`chunk-html-base64.ts` —
   esperam `data/editions/{AAMMDD}/_internal/newsletter-final.html`; adaptar
   `--edition-dir`/path pro HTML mensal na hora do envio real).
2. Compose tab → Title + Subject Line (sugestão vem no JSON impresso pelo
   Passo 1, campo `subject`).
3. **Audience tab → toggle "Include and exclude segments"** → incluir
   `Apoio — Mantenedor` e `Apoio — Patrono` (**nunca "All subscribers"** —
   este é o envio EXTRA restrito a apoiadores). Confirmado (#4521): a
   Audience page da Beehiiv aceita até 5 segmentos incluídos/excluídos
   combinados por post — **não precisa criar segmento combinado novo**.
4. Send test email pra confirmar visualmente antes de agendar/publicar.
5. Escolher um dia SEM edição diária pesada antes de agendar/enviar (decisão
   1 do #4482 — evitar fadiga de 2 e-mails no mesmo dia).

## Passo 3 — Confirmar o envio (idempotência)

Depois de enviar de verdade pela UI da Beehiiv:

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE --mark-sent
```

Grava `status: "sent"` + `sentAt` no estado local — sem isso, rodar o Passo 1
de novo pra este ciclo continuaria "permitido" indefinidamente (nenhum sinal
de que já foi enviado). Depois de marcado, uma nova tentativa de preparar
este MESMO ciclo é bloqueada por padrão (proteção contra reenvio acidental);
`--force` no Passo 1 desbloqueia para o caso legítimo "preciso reenviar uma
correção".

## Saídas

- `data/monthly/{ciclo}/_internal/beehiiv-preview.html` — HTML pronto pra
  colar (mesmo artefato que `/diaria-mensal` já produz via `render-monthly-beehiiv.ts`
  — script compartilhado, sem duplicação).
- `data/monthly/{ciclo}/_internal/beehiiv-apoiadores-state.json` — estado de
  idempotência (`draft_prepared` | `sent`, timestamps, segmentos-alvo).

## Escopo explícito, ainda parcial

Publicação em si continua manual (paste + Audience tab + Schedule, feito
pelo editor via Chrome) — automação completa do staging/publicação real é
follow-up, fora do escopo desta skill (mesma linha do #4482). O que esta
skill garante é: conteúdo certo, audiência certa (verificada), e nunca
reprocessar/reenviar a mesma edição por engano.
