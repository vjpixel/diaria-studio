---
name: diaria-mensal-apoiadores
description: Fecha o loop de divulgação da Retrospectiva do Mês (data/monthly/{ciclo}/draft.md) — página no ar (retrospectiva.diar.ia.br/{AAMM}), e-mail Kit pros apoiadores Mantenedor/Patrono, post restrito no apoia.se, posts públicos de chamada no LinkedIn (página D+1 09:00 BRT + perfil D+2 09:30 BRT, CTA pro apoia.se) e box no slot 2 da diária (alternando com o Artigo Especial) — com gate humano único e state por canal (#9474, espelho de /diaria-artigo-especial). Skill manual e separada do fluxo 0-5 de /diaria-mensal. Requer a máquina do editor (Claude in Chrome logado) pro apoia.se. Uso — `/diaria-mensal-apoiadores --cycle YYMM-MM [--skip pagina,apoiase,linkedin,box,email] [--dry-run] [--force canal[,canal]] [--schedule "AAAA-MM-DDTHH:mm" | --draft] [--base-date AAAA-MM-DD] [--at ISO] [--unpin] [--mark-sent]`.
---

# /diaria-mensal-apoiadores

Fecha o loop de divulgação da **Retrospectiva do Mês** — a recompensa
Mantenedor/Patrono (R$25+, `data/snippets/agradecimento-apoiadores.md`,
prometida desde #4482). Até o #9474 a skill só sincronizava a tag Kit e criava
o broadcast; o resto (página, apoia.se, LinkedIn, box) saía à mão — o envio de
02/10/2026 (ciclo 2609-10) exigiu todos esses passos manualmente. Agora ela
espelha `/diaria-artigo-especial` (#5979): **gate humano único** antes de
qualquer publicação e **state por canal** pra retomar com segurança.

Reusa o MESMO `draft.md` que vai pra Clarice, trocando só a AUDIÊNCIA (tag
`kit_apoiadores.audience_tag`) e removendo o conteúdo Clarice-only.

> **Histórico do canal de e-mail (#7655):** o envio de 04/08/2026 (ciclo
> 2607-08) saiu pela Brevo — campanha 12, lista 8 (Mantenedor+Patrono): 10
> entregues, 4 aberturas únicas, 5 clickers, 2 cliques únicos (medido na API
> em 08/09/2026). O 1º broadcast Kit real foi em 10/09/2026 (ciclo 2608-09,
> broadcast 25844671). Até o #7655 toda a documentação desta skill afirmava
> que a Brevo nunca tinha enviado — ver a seção abaixo, que é a lição de
> método, não uma nota de rodapé.

## ⚠️ O state local não é prova de envio

`beehiiv-apoiadores-state.json` (e, desde o #9474, `divulgacao-published.json`)
registra o que os SCRIPTS fizeram, e `--mark-sent` é um passo manual. O envio
de 04/08 saiu à mão pela UI da Brevo e ninguém rodou `--mark-sent` — o state
ficou em `draft_prepared` para sempre.

Isso enganou por um mês, e enganou em cadeia: as docstrings do #4572/#4593
foram escritas num worktree isolado SEM credencial Brevo, concluíram "a lista
está vazia, nada foi enviado" a partir de uma leitura que nunca aconteceu, e
todo texto posterior (inclusive o do #7633) repetiu isso como fato
estabelecido. A verificação que resolveu foi uma chamada à API da Brevo.

**Regra prática:** antes de afirmar que um canal nunca enviou, perguntar ao
ESP. O repo só sabe o que foi feito através dele. `done` no state por canal
diz o mesmo: o script fez a parte dele, não que o leitor recebeu.

**Skill manual e SEPARADA de `/diaria-mensal`** (decisão do #4521): o editor
decide quando disparar, independente do timing do envio Clarice do mês.

## Classificação de execução

`windows` → **Develop**, nunca Overnight (mesma regra de
`/diaria-artigo-especial` e do #5751 no `CLAUDE.md`). O canal `apoiase` exige
Claude in Chrome com o editor logado — sem navegador utilizável a skill só
fecha de ponta a ponta com `--skip apoiase`.

## Decisões já tomadas (não reabrir)

| Pergunta | Decisão |
|---|---|
| Audiência do e-mail | **TAG** `kit_apoiadores.audience_tag` (`apoio-retrospectiva`), nunca segmento — ver "Audiência é TAG" abaixo. `public: false`, envio EXTRA (a diária do dia sai normal). |
| Página | `retrospectiva.diar.ia.br/{AAMM}`, AAMM = mês de **CONTEÚDO** do ciclo (`2609-10` → `/2609`, `mensalPathFromCycle`). Gate de apoio R$25+ no Worker `workers/retrospectiva`. Tem que estar no ar ANTES do e-mail e dos posts (todos levam até ela). |
| Post apoia.se | **Restrito a R$25+** (valor `25` do `Quem pode ver?`) — mesma lógica de visibilidade do Artigo Especial (restringe ao tier que ganha a recompensa). Texto de **CHAMADA** (título + 2 parágrafos curtos; a URL da retrospectiva vai no campo `Link externo`, nunca repetida no corpo), nunca o conteúdo integral. Fala com quem JÁ apoia, sem CTA de conversão. |
| Posts públicos (editor, 02/10/2026) | **Sim — LinkedIn página + perfil.** CTA aponta pro apoia.se, **NUNCA** pra URL direta da retrospectiva paywalled: linha literal `Apoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria` (adaptação da frase do editor no Artigo Especial — não reescrever, não passar por Clarice/humanizador). Texto de chamada, não recorte. Facebook/Instagram/X: **a avaliar**, fora desta skill. |
| Agenda LinkedIn | Página `webhook_target: "diaria"` **D+1 09:00 BRT**, perfil **D+2 09:30 BRT**, D = data do ENVIO do e-mail (`--base-date`). Agenda do dia: `09:00 retrospectiva-pagina | 10:00 d1 | 12:30 d2 | 17:30 d3`. Perfil é **manual** (o Worker rejeita `pixel` + `post`). |
| Box (editor, 02/10/2026) | **Slot 2, o mesmo do Artigo Especial — os dois se ALTERNAM.** Mecanismo: pin last-writer-wins (quem publica por último ocupa o slot); `--unpin` de um só solta o slot se ele ainda aponta pro arquivo dele, nunca derruba o pin do outro (`scripts/lib/box-slot-pin.ts`). Trade-off do #6748: em edição de 2 destaques o slot 2 não aparece. CTA do box leva à página da Retrospectiva (trecho + paywall, a página feita pra vender o apoio) — mesma escolha do box do Artigo Especial. |
| Horário do e-mail | **1º sábado do mês de envio, 06:00 BRT** (#9473, `monthly_send_schedule` no config; regra única em `lib/mensal/monthly-send-schedule.ts`). O 4b agenda por ela por padrão (rascunho se faltar <24h ou com `--draft`; `--schedule` sobrepõe). O LinkedIn herda a âncora D dessa mesma data (`ruleBaseDateForCycle`) quando o e-mail ainda sai agendado pela regra. |

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo `YYMM-MM` (ex: `--cycle 2609-10`).
  **Obrigatório, sempre explícito** — nunca inferir de `today()` (regra
  invariável do CLAUDE.md). Aceita o legado `YYMM` com derivação automática +
  warning (`requireMonthlyCycleArg`).
- `--skip pagina,apoiase,linkedin,box,email` — pula canal(is). `linkedin`
  cobre página e perfil. Token desconhecido é erro (`parseRetrospectivaSkip`),
  nunca "não pulou nada".
- `--dry-run` — roda o preflight, gera os textos e mostra tudo no gate;
  **para no gate**, sem publicar/agendar/gravar nada.
- `--force canal[,canal]` — reexecuta SÓ os canais nomeados que já estão
  `done` (mesmos tokens do `--skip`). **Nunca global**: um `--force` sem lista
  reexecutaria também o apoia.se e criaria um 2º broadcast Kit (com
  `--schedule`, um 2º envio agendado pros apoiadores). O gate lista os canais
  forçados. No canal `email`, vira `--force` do publisher Kit: novo broadcast
  mesmo com `kitBroadcastId` gravado (o rascunho anterior NÃO é excluído —
  vira órfão no painel, e o comando avisa nomeando o id). No canal `box`, é
  o jeito de devolver o slot 2 à Retrospectiva depois que o Artigo Especial o
  assumiu (o canal já `done` pula sem ele).
- `--schedule "AAAA-MM-DDTHH:mm"` — repassado ao publisher Kit: horário
  EXPLÍCITO, sobrepõe a regra (#7867 item 1). Sem ele, vale a regra do 1º
  sábado 06:00 BRT (#9473); `--draft` força rascunho.
- `--base-date AAAA-MM-DD` — data do ENVIO do e-mail, âncora do D+1/D+2 do
  LinkedIn. Default (decidido pelo AGENTE, não pelo script): a data do
  `--schedule`, se houver; senão a data da regra #9473 (1º sábado do mês de
  envio, se o e-mail ainda sai agendado por ela); senão hoje (banner). O agente sempre repassa o
  valor resolvido explicitamente ao `publish-retrospectiva-linkedin.ts` — o
  script sozinho só conhece "hoje". Data-base cujo D+1 09:00 / D+2 09:30 já
  passou é ERRO (nunca reagenda pra daqui a minutos): usar `--at`.
- `--at ISO` — horário único pros dois posts LinkedIn (sobrepõe o default).
- `--unpin` — só tira o pin do box da Retrospectiva do slot 2 (no-op se o
  Artigo Especial já assumiu o slot). Não mexe em nenhum outro canal.
- Flags repassadas a um script específico (não são da skill como um todo):
  `--accept-teaser` (Passo 3, `verify-retrospectiva-page.ts`), `--no-pin`
  (Passo 7, `update-retrospectiva-box.ts`), `--image-url` (Passo 6,
  `publish-retrospectiva-linkedin.ts` — default: imagem do D1).
- `--mark-sent` — **não prepara nada**: registra que o EDITOR já enviou o
  e-mail de verdade pela UI (Passo 4c). Rodar 2x é idempotente.

## Pré-requisitos

1. `draft.md` do ciclo aprovado (Etapa 4 de `/diaria-mensal`).
2. `_internal/public-images.json` do ciclo — rodar a Etapa 3/4 do
   `/diaria-mensal` (`monthly-preview-cloudflare.ts`) antes, mesmo que o envio
   Clarice ainda não tenha acontecido (o preview já sobe as imagens pro KV; o
   post LinkedIn usa a imagem do D1 daqui).
3. `KIT_API_KEY` (e-mail), `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN`
   (página: push + conferência do KV), `DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`
   (LinkedIn) no ambiente.

## Passo 0 — preflight

1. **Capacidade de navegador** (mesmo padrão do Artigo Especial, #5209):
   `npx tsx scripts/lib/browser-capability.ts`.
   - `unavailable`/`unknown` → HALT, a menos que `--skip apoiase` cubra o único
     canal que precisa de Chrome:
     ```
     npx tsx scripts/render-halt-banner.ts \
       --stage "diaria-mensal-apoiadores — Passo 0" \
       --reason "sem navegador utilizável nesta máquina (sem DISPLAY/WAYLAND_DISPLAY ou sem binário de browser)" \
       --action "esta skill precisa de navegador logado (Claude in Chrome) para o canal apoia.se; rode na máquina do editor, ou passe --skip apoiase"
     ```
     Aguardar resposta explícita antes de prosseguir (#738/#3938).
   - `available` → prosseguir.

2. **Estado da página (read-only):**
   `npx tsx scripts/verify-retrospectiva-page.ts --cycle $CYCLE --no-state`.
   `GET 200` sozinho não prova nada: `/AAMM` devolve 200 com o paywall seco
   mesmo sem conteúdo, e `HEAD` cai no 405. O script classifica o corpo
   (trecho+paywall × paywall seco) e confere a chave `article:{AAMM}` (edição
   completa) no KV `ARTICLES`. `not_live` (exit 1, por contrato) aqui não é
   falha do comando — é o sinal de que o Passo 3 vai publicar a página. Exit
   3 = `live_unconfirmed` (trecho no ar, KV não consultado por falta de
   credencial).

3. **Mural do apoia.se ANTES de criar post** (#6014 item 3). O state por
   canal só enxerga o que ESTA skill fez. Abrir a aba `Posts no Mural` da
   campanha e procurar o post da Retrospectiva do mês; se o editor já postou à
   mão, o Passo 5 **edita aquele** (preserva URL e timestamp) em vez de criar
   outro.

4. **Guard de idempotência.** State por canal em
   `data/monthly/$CYCLE/_internal/divulgacao-published.json`
   (`scripts/lib/mensal/retrospectiva-divulgacao.ts` — canais `pagina`,
   `apoiase`, `linkedin_pagina`, `linkedin_perfil`, `box`, `email`;
   `decideChannelAction` reusado do Artigo Especial). Canal `done` sem
   `--force` é pulado (log, não erro); `failed` é sempre retentável.
   Rodar antes `npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --sync-email`
   pra projetar no canal `email` o que o publisher Kit já fez.

5. **Agenda LinkedIn.** `resolveRetrospectivaScheduledAts`
   (`scripts/lib/mensal/retrospectiva-schedule.ts`) com `--at` ou
   `--base-date`. Imprimir o **banner de defaults assumidos** (#5321) sempre
   que algo for default: âncora do D (data do `--schedule`, da regra #9473 ou hoje), visibilidade
   `25` no apoia.se, slot 2.

6. **Audiência (antes do 1º envio de cada ciclo, canal `email`):**
   ```bash
   npx tsx scripts/sync-apoio-nivel-kit.ts --push        # apoia.se → apoio_nivel (se ainda não rodou no ciclo)
   npx tsx scripts/sync-apoio-mensal-tag-kit.ts          # dry-run: quem entra/sai da tag apoio-retrospectiva
   npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push   # aplica
   ```
   O script continua chamado `sync-apoio-mensal-tag-kit.ts` (o nome da tag
   mudou pra `apoio-retrospectiva` no #7867 item 4; renomear o arquivo ficou
   fora de escopo). Cria a tag se faltar, adiciona quem virou
   Mantenedor/Patrono, remove quem deixou de ser; cada mutação é confirmada
   por releitura (o `2xx` do Kit não é prova de escrita). Remoções acima de
   30% bloqueiam o `--push` (`--force-blast-radius` destrava, logado). Falha
   SISTÊMICA (credencial, rate limit, 5xx) aborta na hora; re-rodar é seguro.
   Rodar o sync da tag ANTES do de nível numa virada de mês projeta o estado
   velho.

   O gate WEB da página (`/AAMM`) não lê a tag do Kit: lê a allowlist do KV
   `ALLOWLIST`, populada por `npx tsx scripts/build-apoiador-allowlist.ts
   --push` (fail-closed, recusa push parcial). Sem rodá-lo no ciclo, quem
   virou Mantenedor este mês recebe o e-mail mas pode ser barrado na página
   que o box e o apoia.se apontam.

## Passo 1 — gerar os textos (agente, 1 dispatch)

Dispatch de **1** subagente `general-purpose` com `model: claude-opus-5-5` +
`effort: low` explícitos (#2019/#8941), a partir do `draft.md` do ciclo:

```
Agent(subagent_type="general-purpose", model="claude-opus-5-5", effort="low", prompt=<
  Gere os textos de divulgação da Retrospectiva do Mês a partir de
  data/monthly/{ciclo}/draft.md (leia só os títulos e o 1º parágrafo de cada
  DESTAQUE). Nunca invente fatos além do que o draft sustenta.

  Todos são CHAMADA, não recorte: despertam curiosidade com o caso concreto
  mais estranho do mês e param antes do prêmio. Não copie nem parafraseie
  parágrafos do draft, não entregue as conclusões — é isso que a pessoa vai
  buscar na retrospectiva. Nada de clickbait vazio.

  1. apoiase.md — fala com quem JÁ apoia (R$25+): título na 1ª linha + 2
     parágrafos curtos. NÃO coloque a URL no texto: ela vai no campo
     "Link externo" do post ({retrospectivaUrl}). Sem CTA de conversão.
  2. linkedin-pagina.md — voz institucional diar.ia.br (3ª pessoa), formato de
     post LinkedIn comum (context/publishers/linkedin.md seções 1-8). Termine
     com a linha literal, sozinha:
     Apoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria
     NUNCA cite retrospectiva.diar.ia.br nem qualquer URL da retrospectiva.
  3. linkedin-perfil.md — 1ª pessoa (voz do Pixel), mesma linha literal no
     fim, mesma proibição de URL. Texto distinto do da página.
  4. box-gancho.md — 1 frase (≤ 160 caracteres) de gancho pro box da diária.

  Escreva os 4 arquivos em data/monthly/{ciclo}/divulgacao/.
>)
```

Depois, pros arquivos 1-3: `Skill("humanizador", ...)` e
`mcp__clarice__correct_text(...)`, aplicando as sugestões da Clarice
incondicionalmente (#4514), **exceto na linha literal de CTA** (frase do
editor — remover antes, recolocar depois) e em marca/identificador técnico.
Pular a geração dos canais em `--skip`. O e-mail não tem texto novo: é o
render Kit do próprio `draft.md`.

Checagem mecânica antes do gate — valida o `--skip` e roda
`publicPostCtaProblems` nos DOIS posts de LinkedIn (exit 1 = texto reprovado:
reescrever antes de mostrar no gate):

```bash
npx tsx scripts/check-retrospectiva-divulgacao.ts --cycle $CYCLE [--skip ...]
```

O da página ainda é rechecado no dispatch; o do PERFIL é colado à mão, então
esta é a única barreira mecânica dele.

## Passo 2 — gate humano único

Critério 1 de "Perguntar é exceção" (`CLAUDE.md`): o post do apoia.se publica
**na hora** pra terceiros (irreversível) e sai do mesmo comando que o resto —
o gate cobre tudo junto:

```
📰 Retrospectiva de {Mês} — {retrospectivaUrl} (página: {veredito do Passo 0})

Página (Passo 3): {"já no ar" | "vai publicar via build-article-page --push"}

E-mail (Kit, tag {kit_apoiadores.audience_tag}, N membros, {rascunho | agendado pela regra #9473 | agendado --schedule}):
  assunto: {deriveApoiadoresKitSubject} — preview: _internal/apoiadores-kit-preview.html

Apoia.se (restrito R$25+, publica AGORA se aprovado):
{apoiase.md}

LinkedIn página (agenda {pagina}):
{linkedin-pagina.md}

LinkedIn perfil (MANUAL, agenda {perfil}):
{linkedin-perfil.md}

Box (slot 2, alterna com o Artigo Especial — substitui o pin atual: {slot2 hoje}):
{preview do box — update-retrospectiva-box.ts --dry-run}

Defaults assumidos: {banner do Passo 0.5}
Re-execução forçada (--force): {canais | nenhum}

Aprovar? sim / ajustar {canal} / abortar
```

`AskUserQuestion` falhando → halt banner (#3938), nunca prosseguir sem
resposta. **`--dry-run` para aqui.**

## Passo 3 — página (canal `pagina`)

Pulado se `--skip pagina` ou já `done` sem `--force`.

Se o Passo 0 deu `not_live`: publicar (só KV, **sem deploy de Worker**):

```bash
npx tsx scripts/build-article-page.ts --cycle $CYCLE --push
```

**Achado do #9474: nada publicava a página até aqui** — nem `/diaria-mensal`
nem esta skill chamavam `build-article-page.ts --push`; o último push em lote
foi manual (07/09/2026, #7580). Listar o path em `PATHS_COM_TRECHO`
(`workers/retrospectiva/src/index.ts`) só serve ao sitemap e exige deploy (CI
no merge) — opcional, fora do caminho crítico; se o editor quiser o mês no
sitemap, é uma linha + PR.

Depois, sempre:

```bash
npx tsx scripts/verify-retrospectiva-page.ts --cycle $CYCLE
```

Grava `pagina` como `done` (veredito `live`) ou `failed`. `live_unconfirmed`
(trecho no ar, KV não consultado por falta de credencial; exit 3) não grava
nada — `--accept-teaser` aceita conscientemente. Erro REAL de leitura do KV
(403, 5xx) é `not_live`, nunca aceitável pelo `--accept-teaser`. **Página `failed` bloqueia os
Passos 4-7** (todos levam até ela): parar e reportar.

## Passo 4 — e-mail (canal `email`, Kit)

Pulado se `--skip email` ou já `done` sem `--force`. O publisher não mudou no
#9474 — só passou a ser um canal do loop.

### 4a — Reservar o ciclo (opcional, recomendado)

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE
```

Renderiza o HTML da variante Kit (o MESMO render do 4b) e grava
`_internal/beehiiv-apoiadores-state.json` com `status: "draft_prepared"`
(nome histórico do fluxo Beehiiv; conteúdo channel-agnostic). Sem esse state
prévio o `--force`/`--mark-sent` não têm o que referenciar.

### 4b — Publicar (cria o broadcast Kit)

```bash
# Preview local — NUNCA chama a API do Kit, nem lê/grava o state.
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE --dry-run

# #9473: JÁ AGENDADO pela regra — 1º sábado do mês de ENVIO, 06:00 BRT
# (platform.config.json → monthly_send_schedule). Se esse horário estiver a <24h
# (#8205) ou já tiver passado, cai pra RASCUNHO com aviso.
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE

# Rascunho explícito (send_at: null) — o default antigo.
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE --draft

# #7867 item 1: horário EXPLÍCITO (sobrepõe a regra), marca status "sent" — dispensa o 4c. SEM guard
# de data (decisão do editor): o script não checa colisão com a diária.
npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle $CYCLE --schedule "2026-10-03T06:00:00-03:00"

# Projeta o resultado no state por canal (done / failed com o motivo).
npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --sync-email
```

- Variante Kit (`lib/mensal/monthly-apoiadores-kit-render.ts`): filtro de
  seções Clarice-only, UTM `mensal-apoiadores-kit`, merge tag Liquid
  `{{ subscriber.email_address }}` no voto do "É IA?", relink pras diárias de
  origem (#4048). Subject `"Retrospectiva de {mês}: {título do D1}"`, preview
  fixo "Exclusivo para apoiadores" (#7867 itens 2-3).
- Fora de `--dry-run`: resolve a tag por NOME (nunca cria), confere que tem
  membros, cria o broadcast com `subscriber_filter` de tag e **`public:
  false`** (sem `public_url`: recompensa paga não vira página pública).
- **Relê o broadcast e confere o `subscriber_filter` aplicado** — o 2xx não é
  prova. Divergência aborta ALTO gravando `kitAudienceVerified: false`
  (registro de INCIDENTE); falha de rede na releitura vira `null` + aviso.
  No state por canal, os dois viram `email: failed` (`deriveEmailChannelState`
  — "não confirmável" nunca é "ok"): conferir a audiência no painel e, se
  estiver certa, `mark-retrospectiva-channel.ts --channel email --status done`.
- Aborta (exit 2) se: `kit_apoiadores.audience_tag` ausente, `KIT_API_KEY`
  ausente, tag inexistente/vazia, ou guard de idempotência (`kitBroadcastId`
  gravado ou ciclo `sent`; `--force` ignora).

**Rascunho** (`--draft`, ou regra tarde demais): test send no painel → escolher um dia SEM
edição diária pesada (decisão 1 do #4482) → Send/Schedule pela UI → 4c.

### 4c — Confirmar o envio (só o caminho rascunho)

```bash
npx tsx scripts/send-monthly-apoiadores.ts --cycle $CYCLE --mark-sent
npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --sync-email
```

Grava `status: "sent"` + `sentAt`. Sem isso nada registra que o ciclo saiu, e
o 4a continuaria "permitido" indefinidamente; depois de marcado, um novo 4a/4b
pro mesmo ciclo é bloqueado (`--force` cobre "reenviar uma correção").

## Passo 5 — apoia.se (Claude in Chrome, top-level)

Pulado se `--skip apoiase` ou já `done` sem `--force`. Seguir
`context/publishers/apoia-se.md` §"Retrospectiva do Mês" (mesmo fluxo do
Artigo Especial: `Posts no Mural` → criar/editar; `Link externo` = URL da
retrospectiva, nunca repetida no corpo; **`Quem pode ver?` = `25`**). Clique
final do editor (irreversível pra terceiros).

Gravar o resultado SEMPRE via script, nunca editando o JSON:

```bash
npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --channel apoiase --status done --url "{URL do post}"
npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --channel apoiase --status failed --reason "{motivo}"
```

Falha aqui **continua** pros outros canais (fail-soft por canal).

## Passo 6 — LinkedIn (página por script, perfil à mão)

Pulado se `--skip linkedin`; cada canal com o próprio guard.

1. **Página:**
   ```bash
   npx tsx scripts/publish-retrospectiva-linkedin.ts --cycle $CYCLE \
     --base-date {data do envio, resolvida no Passo 0.5} [--at ISO] [--force] [--dry-run]
   ```
   Lê `divulgacao/linkedin-pagina.md`, imagem = D1 de
   `_internal/public-images.json`. Recusa ANTES de despachar se o texto citar
   a URL paywalled ou faltar a linha literal de CTA, se a agenda não estiver
   no futuro, ou se o Worker não estiver configurado (sem Worker a rota seria
   `make_now` — publicaria AGORA). `allowImmediateFallback: false` (#6015).
   `destaque` no Worker = `especial-retrospectiva` (`especial-{sufixo}` é o
   namespace que comporta um identificador próprio sem deploy; `d[123]`,
   `weekly-*` e `eia-*` têm semântica alheia). Detalhe do dispatch em
   `_internal/divulgacao-linkedin-published.json` — que também é 2º guard: se
   ele já tem o post agendado, o script pula mesmo com o state sem registro.
   Reconciliado contra o Worker (`verifyWorkerDispatch`; DLQ → `failed`);
   reconciliação que não roda deixa o canal `done` mas sai com exit 1
   ("agendado, não confirmado").
2. **Perfil (manual):** rodar de novo o `check-retrospectiva-divulgacao.ts`
   (o texto pode ter sido mexido depois do gate) e agendar
   `divulgacao/linkedin-perfil.md` no composer
   nativo para o horário `perfil` do Passo 0.5 (D+2 09:30 BRT) e marcar:
   `npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --channel linkedin_perfil --status done`.
   O Worker rejeita `webhook_target=pixel` + `action=post` — não tente por
   script.

## Passo 7 — box (script + PR)

Pulado se `--skip box` ou já `done` sem `--force`.

```bash
npx tsx scripts/update-retrospectiva-box.ts --cycle $CYCLE \
  --titulo "{título do D1}" --gancho "{divulgacao/box-gancho.md}" [--no-pin] [--force] [--dry-run]
```

Reescreve só o corpo de `data/snippets/retrospectiva-apoiadores.md` (título,
frase-padrão, URL do CTA — edição cirúrgica, #495;
`RetrospectivaBoxFormatError` se o formato divergiu: ajustar à mão 1x, ver
`context/snippets/README.md`) e pina o **slot 2**
(`boxes_divulgacao.slot2 = "retrospectiva-apoiadores.md"` + `2` em
`pinned_slots`), substituindo o pin do Artigo Especial se ele estiver lá
(alternância — ver "Decisões já tomadas"). O diff de `platform.config.json` é
cirúrgico (só as linhas `slot2`/`pinned_slots`, #9256).

**`platform.config.json` é git — abrir PR** (mesmo fluxo do Artigo Especial):

```bash
git checkout -b retrospectiva/$CYCLE
git add platform.config.json
git commit -m "chore(#9474): pin box Retrospectiva slot 2 — $CYCLE"
gh pr create --title "chore(#9474): pin box Retrospectiva — $CYCLE" \
  --body "Pin do box \"Retrospectiva do Mês\" no slot 2 (alterna com o Artigo Especial). Skill /diaria-mensal-apoiadores."
```

O snippet (`data/`, OneDrive, gitignored) **não** entra no commit. Review
automatizado via hook; merge segue a regra de sessão interativa (#5251).

Com o canal `box` já `done`, rodar de novo pula — inclusive quando o Artigo
Especial assumiu o slot 2 depois. Devolver o slot à Retrospectiva é decisão
consciente: `--force box`.

`--unpin` (standalone, sem título/gancho, não toca snippet nem state):
devolve o slot 2 ao auto-select por cliques (#4626) quando a Retrospectiva
envelhecer — **no-op** (resultado `noop`) se o Artigo Especial já assumiu o
slot; um 3º valor no slot (drift de config) também é no-op, com aviso. Mesmo
fluxo de branch/PR quando houver diff.

## Passo 8 — resumo + registro

- `logEvent` (`scripts/lib/run-log.ts`) por canal, `edition: "{ciclo}"`
  (os scripts de página e LinkedIn já registram o seu).
- Resumo no terminal: estado final de cada canal (`divulgacao-published.json`),
  URL da página, id do broadcast + status (rascunho/agendado), URL do post
  apoia.se, `worker_queue_key` + horário da página LinkedIn, horário a agendar
  no perfil, diff do box + número do PR, e o banner de defaults assumidos.
- Sem confirmação pós-sucesso; sem encadear nada — termina aqui.

## Casos de borda

- **Página não sobe** (push falhou, KV sem a chave) → `pagina: failed`, Passos
  4-7 não rodam.
- **Canal individual falha** → grava `failed` naquele canal e segue pros
  outros. Resume reexecuta só `pending`/`failed`.
- **E-mail com audiência não confirmada** → `email: failed` com o id do
  rascunho no motivo; uma reexecução é barrada pelo guard do publisher
  (`kitBroadcastId`) — a saída é conferir no painel e marcar à mão.
- **Slot 2 com o Artigo Especial pinado** → o box da Retrospectiva assume
  (last-writer-wins, avisado no gate); um `--unpin` posterior do Artigo
  Especial vira no-op e não derruba a Retrospectiva.

## Saídas

```
data/monthly/{ciclo}/
  divulgacao/
    apoiase.md                         chamada pro mural (Passo 1)
    linkedin-pagina.md                 post da página diar.ia.br (Passo 1)
    linkedin-perfil.md                 post do perfil pessoal (Passo 1)
    box-gancho.md                      gancho do box (Passo 1)
  _internal/
    divulgacao-published.json          status por canal — pagina/apoiase/linkedin_pagina/linkedin_perfil/box/email
    divulgacao-linkedin-published.json detalhe do dispatch LinkedIn (worker_queue_key, route, scheduled_at)
    apoiadores-kit-preview.html        HTML do broadcast (UTM mensal-apoiadores-kit)
    beehiiv-apoiadores-state.json      idempotência do e-mail (draft_prepared|sent, kitBroadcastId, kitAudienceVerified, brevoCampaignId legado)
data/snippets/retrospectiva-apoiadores.md   box (Passo 7)
platform.config.json                        boxes_divulgacao.slot2 + pinned_slots (Passo 7, via PR)
```

`kitAudienceVerified: false` é registro de INCIDENTE (rascunho com audiência
divergente — conferir à mão antes de qualquer disparo); `null` significa "não
confirmável", não "ok".

## Por que Kit

Beehiiv (#4482) → Brevo (#4572/#4593) → Kit (#7633). A 1ª troca foi forçada
por bloqueio de plataforma (a Beehiiv gateia segmentação multi-condição atrás
do plano Scale, e nunca chegou a enviar); esta é consolidação:
`publishing.newsletter.backend` virou `"kit"` (#7388) e a base inteira migrou
(#7386). **O que a troca custa (#7655):** a Brevo enviou 1 edição real, e
comparar com ela exige buscar os números na Brevo (campanha 12). Os scripts
`*-apoiadores-brevo.ts` e a chave `brevo_apoiadores` continuam no repo;
quando forem removidos, o registro daquele envio precisa sobreviver.

## ⚠️ Audiência é TAG, nunca segmento

A conta Kit tem os 6 segmentos `Apoio — {…}` condicionados no custom field
`apoio_nivel` (`scripts/lib/apoio-segments-canonical-kit.ts`) — parecem o alvo
óbvio de `subscriber_filter`, e não servem:

- `GET /v4/subscribers?segment_id=X` **ignora silenciosamente** o parâmetro
  (o total volta com a conta inteira, medido em 24/08/2026), e não existe
  rota que liste quem está num segmento. Mirar segmento é enviar sem poder
  conferir a audiência.
- Membresia de TAG é legível (`GET /v4/tags/{id}/subscribers`).

Modo de falha assimétrico: `subscriber_filter` ausente/não resolvido no Kit =
**base INTEIRA** (#6126). Por isso o publisher recusa tag não resolvida ou
vazia. A tag é **projeção** do custom field, não 2ª fonte de verdade: quem
decide nível é `sync-apoio-nivel-kit.ts` (#6049).

## Conteúdo: decisão do #4482 preservada, não reaberta

O espaço das seções `CLARICE — DIVULGAÇÃO`/`CLARICE — TUTORIAL` removidas
**fica vazio** (#4482, comentário 260803, decisão 3). A sugestão do #4521 de
preencher com os snippets Patronos segue não adotada. Reabrir é questão de
produto — comentário na issue.

## Escopo explícito

O e-mail sai agendado pela regra do 1º sábado, 06:00 BRT (#9473) quando faltam
>=24h; fora disso (ou com `--draft`) é rascunho e o disparo (test send,
Send/Schedule) continua humano no painel do Kit. O clique final do apoia.se
continua humano. Facebook/Instagram/X da Retrospectiva: a avaliar (decisão do
editor no #9474).
