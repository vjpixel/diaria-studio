---
name: diaria-mensal-apoiadores
description: Envia a edição mensal (data/monthly/{ciclo}/draft.md) por e-mail pros apoiadores dos níveis Mantenedor/Patrono — skill manual e separada do fluxo 0-5 de /diaria-mensal (o editor decide o timing). Canal Brevo (migrado de Beehiiv, #4572/#4593 — plano Launch/free bloqueia segmentação multi-condição na Beehiiv). Uso — `/diaria-mensal-apoiadores --cycle YYMM-MM [--force] [--mark-sent]`.
---

# /diaria-mensal-apoiadores

> **STATUS (#4593, 260804): migração de canal CONCLUÍDA no código — falta só
> a lista Brevo existir de verdade.** O #4572 trocou o canal de Beehiiv pra
> Brevo (a Beehiiv bloqueia "Include and exclude segments", o mecanismo de
> audiência multi-segmento do fluxo antigo, atrás do plano Scale — workspace
> é Launch/free) e entregou a ponte de audiência
> (`scripts/sync-apoio-nivel-brevo.ts`). O #4593 fecha o resto: o Passo 2
> abaixo agora cria uma campanha Brevo REAL (rascunho, via
> `scripts/publish-monthly-apoiadores-brevo.ts`) em vez do paste manual no
> Beehiiv. **Pré-requisito real ainda pendente:** `platform.config.json` →
> `brevo_apoiadores.list_id` continua `null` — a lista dedicada aos
> apoiadores ainda não foi criada na conta Brevo do editor. Sem ela, tanto
> `sync-apoio-nivel-brevo.ts --push` quanto `publish-monthly-apoiadores-brevo.ts`
> (fora de `--dry-run`) abortam com erro explícito — nenhum dos dois tenta
> criar a campanha/mutar audiência com uma lista inexistente. Ação pendente
> do editor: criar a lista na Brevo e gravar o `list_id`.
>
> O módulo de render Beehiiv antigo (`scripts/render-monthly-beehiiv.ts` /
> `scripts/lib/mensal/monthly-beehiiv-render.ts` / `scripts/send-monthly-apoiadores.ts`)
> **continua no repo, intocado** (decisão do #4593 item 2, opção b — ver
> rationale completo no docstring de `monthly-apoiadores-brevo-render.ts`) mas
> **não é mais usado por esta skill** — o envio Beehiiv nunca saiu do estágio
> de draft órfão criado durante o teste ao vivo do #4572.

Entrega o "artigo especial do mês" já anunciado como recompensa Mantenedor/
Patrono (`context/snippets/agradecimento-apoiadores.md`) — hoje só existe como
página paywall do worker `artigo-mensal`, sem nenhum aviso ativo pro
assinante (#4521). Esta skill fecha esse ciclo: reusa o MESMO `draft.md` que
já vai pra Clarice, trocando só a AUDIÊNCIA (lista Brevo dedicada,
`platform.config.json` → `brevo_apoiadores.list_id`, alimentada por
`sync-apoio-nivel-brevo.ts` a partir de quem tem nível Mantenedor/Patrono) e
removendo o conteúdo Clarice-only.

**Skill manual e SEPARADA de `/diaria-mensal`** (decisão do #4521, ver "não
uma etapa nova dentro de /diaria-mensal") — o editor decide quando disparar,
independente do timing do envio canônico Clarice do mês.

## Histórico — #4482 → #4521 → #4572 → #4593

- **#4482** (fechado, merge #4510): módulo de render Beehiiv + 4 decisões de
  produto (cadência = envio extra num dia sem edição pesada; segmento = só
  Mantenedor/Patrono; seções Clarice removidas sem substituição; plataforma
  = Beehiiv — **revertida pelo #4572**).
- **#4521** (fechado): skill própria (esta) + idempotência/dedup
  (`scripts/lib/mensal/monthly-apoiadores-state.ts`, ver Passo 3) — módulo
  reusado sem alteração, é channel-agnostic (só lê/grava um JSON de estado
  local, não depende de qual ESP publica).
- **#4572** (fechado, merge #4592): pivot de canal Beehiiv → Brevo (bloqueio
  de plano confirmado ao vivo) + `scripts/sync-apoio-nivel-brevo.ts` (ponte
  de audiência).
- **#4593** (esta unidade): Passo 2 reescrito pro fluxo Brevo real
  (`scripts/publish-monthly-apoiadores-brevo.ts`) + decisão sobre o módulo de
  render antigo (opção b — perfil UTM Brevo dedicado
  `APOIADORES_BREVO_UTM_PROFILE`, sem renomear/tocar
  `BEEHIIV_UTM_PROFILE`/`CLARICE_UTM_PROFILE` existentes; rationale completo
  no docstring de `scripts/lib/mensal/monthly-apoiadores-brevo-render.ts`).

**Conteúdo: mantém a decisão já tomada no #4482, não a reabre.** A issue
#4521 sugeriu reusar os snippets Patronos da diária
(`context/snippets/patronos-*.md`) no espaço deixado vazio pelas seções
Clarice removidas. Essa MESMA pergunta já tinha sido decidida ao vivo pelo
editor no comentário do #4482 (260803, decisão 3): "remover DIVULGAÇÃO/
TUTORIAL sem substituir por nada — mais simples, espaço reservado fica
vazio." Esta skill preserva essa decisão (o espaço fica vazio) — os snippets
Patronos, além disso, são específicos do nível Patrono, então estendê-los
pro mensal/Mantenedor arrastaria uma decisão de copy por nível que ninguém
tomou ainda. **Se o editor quiser reabrir essa decisão**, é questão de
produto, não técnica — registrar como comentário na issue de acompanhamento.

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo no formato `YYMM-MM` (ex:
  `--cycle 2607-08`). **Obrigatório, sempre explícito** — nunca inferir a
  partir de `today()` (regra invariável do CLAUDE.md). Aceita o legado `YYMM`
  com derivação automática + warning, mesmo comportamento de
  `requireMonthlyCycleArg` (`scripts/lib/mensal/monthly-paths.ts`).
- `--force` (opcional) = permite re-preparar/regenerar o HTML mesmo se este
  ciclo já estiver marcado como `sent` no estado local (ver Passo 3). Sem
  essa flag, um ciclo `sent` bloqueia a preparação de novo (dedup real,
  #4521 questão 3) — proteção contra reabrir por engano o fluxo de uma
  edição já confirmada como enviada.
- `--mark-sent` (opcional) = **não prepara nada** — só registra no estado
  local que o EDITOR já enviou de verdade pela UI da Brevo (Passo 3 abaixo).
  Rodar sem preparo prévio dá erro; rodar 2x é idempotente (noop na 2ª vez).

## Pré-requisito

1. `_internal/public-images.json` do ciclo já existe — rodar a Etapa 3/4 do
   `/diaria-mensal` (`monthly-preview-cloudflare.ts`) nesse ciclo antes, mesmo
   que o envio Clarice em si ainda não tenha acontecido (o preview já sobe as
   imagens pro KV independente do envio). Sem isso,
   `render-monthly-apoiadores-brevo.ts` aborta com instrução clara.
2. **`platform.config.json` → `brevo_apoiadores.list_id` precisa estar
   preenchido** (ação pendente do editor, ver banner de STATUS acima) —
   `publish-monthly-apoiadores-brevo.ts` aborta com erro explícito fora de
   `--dry-run` enquanto isso não acontecer.

## Passo 1 — Reservar o ciclo (idempotência local, opcional mas recomendado)

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE
```

Este comando é **reusado do fluxo Beehiiv antigo só pelo lado de estado**
(`scripts/lib/mensal/monthly-apoiadores-state.ts`, channel-agnostic) — grava
`data/monthly/$CYCLE/_internal/beehiiv-apoiadores-state.json` com
`status: "draft_prepared"`, o mesmo dedup real do #4521. O HTML que ele
escreve (`beehiiv-preview.html`, com UTM `mensal-beehiiv`) **não é o que será
publicado** — ignore-o; é resíduo do fluxo antigo, mantido só pelo efeito
colateral de estado. Rodar este passo é opcional (o Passo 2 abaixo funciona
sem ele) mas recomendado: sem ele, `--force`/`--mark-sent` não têm state
prévio pra referenciar.

## Passo 2 — Publicar (cria a campanha Brevo real, sempre rascunho)

```bash
# Preview local, NUNCA chama a API Brevo — confirme assunto/preview/HTML antes de seguir.
npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle $CYCLE --dry-run

# Cria a campanha na Brevo de verdade — SEMPRE como rascunho (nunca agenda/envia sozinho).
npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle $CYCLE
```

- Renderiza a variante Brevo (`scripts/lib/mensal/monthly-apoiadores-brevo-render.ts`
  — mesmo filtro de seções Clarice-only do módulo Beehiiv antigo, reusado sem
  modificação; UTM próprio `mensal-apoiadores-brevo`; relink pra edição diária
  de origem, #4048).
- Escreve `data/monthly/$CYCLE/_internal/apoiadores-brevo-preview.html`.
- Fora de `--dry-run`: cria a campanha via `POST /emailCampaigns` (mesma
  estrutura de auth/endpoint de `scripts/publish-daily-brevo.ts`) mirando
  `brevo_apoiadores.list_id` — **audiência = a lista inteira**, não precisa
  escolher segmento na UI (diferente do fluxo Beehiiv antigo, que exigia
  toggle manual de "Include and exclude segments"; a Brevo resolve por
  membresia de lista, já convergida por `sync-apoio-nivel-brevo.ts`).
- **A campanha SEMPRE sai como rascunho** — sem `scheduledAt`, sem
  `sendNow`. Depois de criada, ação manual do editor no painel Brevo:
  1. Send test email pra confirmar visualmente.
  2. Escolher um dia SEM edição diária pesada antes de agendar/enviar
     (decisão 1 do #4482 — evitar fadiga de 2 e-mails no mesmo dia).
  3. Schedule/Send pela UI da Brevo quando pronto.
- Aborta (exit 2) fora de `--dry-run` se `brevo_apoiadores.list_id`,
  `sender_email` ou a API key não estiverem configurados — nunca tenta criar
  a campanha com uma lista/remetente ausente.

## Passo 3 — Confirmar o envio (idempotência)

Depois de enviar de verdade pela UI da Brevo:

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE --mark-sent
```

Grava `status: "sent"` + `sentAt` no estado local — sem isso, o Passo 1
continuaria "permitido" indefinidamente pra este ciclo (nenhum sinal de que
já foi enviado). Depois de marcado, uma nova tentativa do Passo 1 pra este
MESMO ciclo é bloqueada por padrão (proteção contra reenvio acidental);
`--force` desbloqueia para o caso legítimo "preciso reenviar uma correção".

**Gap conhecido, aceito nesta unidade (#4593):** `publish-monthly-apoiadores-brevo.ts`
(Passo 2) **não consulta nem grava** o estado de `monthly-apoiadores-state.ts`
sozinho — rodar o Passo 2 duas vezes pro mesmo ciclo cria DUAS campanhas
rascunho na Brevo (nunca duas ENVIADAS — ambas exigem ação manual pra sair do
rascunho, então o blast radius é baixo, mas é ruído). A mitigação atual é
disciplinar: sempre rodar o Passo 1 antes (reserva o ciclo, mesmo sem o
render dele importar) e conferir no painel Brevo se já existe um rascunho
pro ciclo antes de rodar o Passo 2 de novo. Wiring automático (Passo 2
checando/gravando o mesmo estado antes/depois de criar a campanha) é
follow-up natural, não implementado aqui — abrir issue se o ruído incomodar.

## Saídas

- `data/monthly/{ciclo}/_internal/apoiadores-brevo-preview.html` — HTML da
  campanha (variante Brevo, UTM `mensal-apoiadores-brevo`).
- `data/monthly/{ciclo}/_internal/beehiiv-apoiadores-state.json` — estado de
  idempotência (`draft_prepared` | `sent`, timestamps) — nome do arquivo é
  resíduo histórico do fluxo Beehiiv (#4521), mas o conteúdo/semântica são
  channel-agnostic; não renomeado nesta unidade (fora de escopo, zero
  consumidor externo do nome do arquivo).
- Campanha Brevo criada como rascunho na conta do editor (id logado no
  stdout do Passo 2) — visível no painel Brevo, `Campaigns → Drafts`.

## Escopo explícito, ainda parcial

Publicação real (test email, Schedule/Send) continua manual — ação do
editor no painel Brevo, mesma linha do #4482/#4572. O que esta skill garante
hoje: conteúdo certo, audiência certa (lista Brevo dedicada, convergida por
`sync-apoio-nivel-brevo.ts`), campanha SEMPRE criada como rascunho (nunca
agenda/envia sozinha). O que NÃO garante ainda: dedup automático entre
Passo 1 (estado) e Passo 2 (campanha real) — ver gap conhecido no Passo 3
acima. 1º envio ao vivo depende do editor criar a lista Brevo dedicada
(`brevo_apoiadores.list_id`, ver banner de STATUS) — não feito nesta unidade
(worktree isolado, sem credencial Brevo real, mesma disciplina dos
#4320/#4382/#4490/#4534/#4572).
