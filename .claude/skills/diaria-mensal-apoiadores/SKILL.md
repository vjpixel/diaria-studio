---
name: diaria-mensal-apoiadores
description: Fecha o loop de divulgação da Retrospectiva do Mês (data/monthly/{ciclo}/draft.md) — página no ar (retrospectiva.diar.ia.br/{AAMM}), e-mail Kit pros apoiadores Mantenedor/Patrono, post restrito no apoia.se, posts públicos de chamada (CTA pro apoia.se) — 3 por rede, um por história D1/D2/D3, no formato dos destaques diários, em LinkedIn página, Facebook, Instagram, Threads e X (D+1 nos slots da diária, 10:00/12:30/17:30 BRT, as 5 redes juntas, #9508) + 1 no perfil LinkedIn (D+2 09:30, manual) — e box no slot 2 da diária (alternando com o Artigo Especial) — com gate humano único e state por canal (#9474, espelho de /diaria-artigo-especial). Skill manual e separada do fluxo 0-5 de /diaria-mensal. Requer a máquina do editor (Claude in Chrome logado) pro apoia.se. Uso — `/diaria-mensal-apoiadores --cycle YYMM-MM [--skip pagina,apoiase,linkedin,facebook,instagram,threads,x,box,email,{rede}:dN] [--dry-run] [--force canal[:dN][,canal]] [--replace-linkedin-single] [--schedule "AAAA-MM-DDTHH:mm" | --draft] [--base-date AAAA-MM-DD] [--at ISO] [--unpin] [--mark-sent]`.
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
| Posts públicos (editor, 02/10/2026) | **Sim — LinkedIn página + perfil.** CTA aponta pro apoia.se, **NUNCA** pra URL direta da retrospectiva paywalled: linha literal `Apoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria` (adaptação da frase do editor no Artigo Especial — não reescrever, não passar por Clarice/humanizador). Texto de chamada, não recorte. |
| Facebook/Instagram/Threads/X (editor, 02/10/2026, #9500) | **Sim, os quatro**, mesma regra de CTA. X/Threads (≤280) aceitam a linha curta `Apoie e leia a retrospectiva completa: apoia.se/diaria` (premissa do #9500: mantém o "Apoie", corta o resto pra caber); LinkedIn/Facebook/Instagram, a longa. |
| Um post por história (editor, 02/10/2026, #9508) | **3 posts por rede, um por história** (DESTAQUE 1/2/3 do `draft.md`), no **formato dos destaques diários**: Instagram e Threads = carrossel de 5 slides fixos (capa 4:5 com o título + 3 parágrafos + CTA, #6005 Parte B); X = até 4 imagens (capa + 3 parágrafos, **sem** o slide de CTA, #8202); Facebook e página LinkedIn = 1 imagem (a capa 4:5 da história, como a diária prefere) + texto. O **perfil LinkedIn segue com 1 post só**, manual. Textos (premissa do #9508, espelho da diária `# Social`/`# Curto`): por história, `d{N}.md` = **exatamente 3 parágrafos** (≤260 cada; os slides E o corpo da legenda de LinkedIn/Facebook/Instagram — o script soma a linha longa de CTA) e `d{N}-curto.md` = ≤280 com a linha curta (Threads e X). Parágrafo que não cabe no card é **REESCRITO**, nunca encolhido nem truncado (#6078). Slide de CTA = a linha longa, faixa "Exclusivo para apoiadores". Capa = `04-d{N}-2x1.jpg` do ciclo recortada em 4:5, título da história, linha "Retrospectiva de {Mês}". Tudo por `publish-retrospectiva-social.ts`; X via Buffer MCP pelo top-level (o script só monta os 3 payloads). |
| Agenda (editor, 02/10/2026, #9508) | D = data do ENVIO do e-mail (`--base-date`). Os 15 posts no **dia D+1**, nos **mesmos slots dos dias de semana da diária** (`publishing.social.fallback_schedule`, fonte do `compute-social-schedule.ts`): **história 1 às 10:00, 2 às 12:30, 3 às 17:30 BRT**, com as **5 redes no mesmo horário** (sem escalonar). Por isso o dia **não pode ter edição diária agendada**: post vivo no store da diária desse dia (`editionDir(AAMMDD)/_internal/06-social-published.json` (`data/editions/{AAMM}/{AAMMDD}/`)) recusa o pré-voo; pasta da edição sem posts (edição em curso) ou dia útil sem edição viram **aviso** no JSON (`warnings`) e no gate. Sábado/domingo não têm edição — o envio do e-mail no 1º sábado (#9473) cai os posts no domingo. Perfil LinkedIn **D+2 09:30 BRT**, manual (o Worker rejeita `pixel` + `post`). Página `webhook_target: "diaria"`. |
| Post único legado da página (#9474 → #9508) | O ciclo 2609-10 já tem 1 post geral da página agendado. Enquanto ele estiver vivo no Worker e algum post da página estiver pedido, o pré-voo **inteiro** é recusado (tudo-ou-nada; sairiam 4 na página). O post único do #9500 nas outras redes (`divulgacao-social-published.json`), se existir vivo, também recusa — sem cancelamento por script. `--replace-linkedin-single` cancela a entry (DELETE `/queue/:key`) antes de despachar os 3; se ela já saiu da fila (provavelmente publicada), os 3 seguem e o resultado avisa (`legacy_linkedin.action: "already-gone"`). |
| Box (editor, 02/10/2026) | **Slot 2, o mesmo do Artigo Especial — os dois se ALTERNAM.** Mecanismo: pin last-writer-wins (quem publica por último ocupa o slot); `--unpin` de um só solta o slot se ele ainda aponta pro arquivo dele, nunca derruba o pin do outro (`scripts/lib/box-slot-pin.ts`). Trade-off do #6748: em edição de 2 destaques o slot 2 não aparece. CTA do box leva à página da Retrospectiva (trecho + paywall, a página feita pra vender o apoio) — mesma escolha do box do Artigo Especial. |
| Horário do e-mail | **1º sábado do mês de envio, 06:00 BRT** (#9473, `monthly_send_schedule` no config; regra única em `lib/mensal/monthly-send-schedule.ts`). O 4b agenda por ela por padrão (rascunho se faltar <24h ou com `--draft`; `--schedule` sobrepõe). O LinkedIn herda a âncora D dessa mesma data (`ruleBaseDateForCycle`) quando o e-mail ainda sai agendado pela regra. |

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo `YYMM-MM` (ex: `--cycle 2609-10`).
  **Obrigatório, sempre explícito** — nunca inferir de `today()` (regra
  invariável do CLAUDE.md). Aceita o legado `YYMM` com derivação automática +
  warning (`requireMonthlyCycleArg`).
- `--skip pagina,apoiase,linkedin,facebook,instagram,threads,x,box,email` —
  pula canal(is). `linkedin` cobre perfil e os 3 posts da página; cada rede
  cobre as 3 histórias; `{rede}:d{N}` (#9508, ex: `instagram:d2`,
  `linkedin:d3` = página da história 3) pula 1 post só. Token desconhecido é
  erro (`parseRetrospectivaSkip`), nunca "não pulou nada".
- `--dry-run` — roda o preflight, gera os textos e mostra tudo no gate;
  **para no gate**, sem publicar/agendar/gravar nada.
- `--force canal[,canal]` — reexecuta SÓ os canais nomeados que já estão
  `done` (mesmos tokens do `--skip`, inclusive `{rede}:d{N}` pra 1 post só).
  **Nunca global**: um `--force` sem lista
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
- `--base-date AAAA-MM-DD` — data do ENVIO do e-mail, âncora do D+1/D+2 dos
  posts públicos. Default (decidido pelo AGENTE, não pelo script): a data do
  `--schedule`, se houver; senão a data da regra #9473 (1º sábado do mês de
  envio, se o e-mail ainda sai agendado por ela); senão hoje (banner). O agente sempre repassa o
  valor resolvido explicitamente ao `publish-retrospectiva-social.ts` — o
  script sozinho só conhece a regra e "hoje". Horário de história que já passou é recusado no
  pré-voo, por post (nunca reagenda pra daqui a minutos): `--skip {rede}:dN`
  das histórias vencidas, ou outro dia.
- `--at ISO` — escolhe o DIA dos posts por história (o dia local do ISO; os
  horários continuam sendo os slots 10:00/12:30/17:30) e o horário do perfil.
- `--replace-linkedin-single` (#9508) — cancela no Worker o post ÚNICO legado
  da página LinkedIn (#9474) antes de despachar os 3 por história. Sem ele, um
  post único ainda agendado faz o pré-voo recusar a execução inteira.
- `--unpin` — só tira o pin do box da Retrospectiva do slot 2 (no-op se o
  Artigo Especial já assumiu o slot). Não mexe em nenhum outro canal.
- Flags repassadas a um script específico (não são da skill como um todo):
  `--accept-teaser` (Passo 3, `verify-retrospectiva-page.ts`), `--no-pin`
  (Passo 7, `update-retrospectiva-box.ts`), `--old-cancelled post[,post]`
  (Passo 6, `publish-retrospectiva-social.ts` — destrava o `--force` sobre
  post vivo de Facebook/X que o editor já apagou na rede).
- `--mark-sent` — **não prepara nada**: registra que o EDITOR já enviou o
  e-mail de verdade pela UI (Passo 4c). Rodar 2x é idempotente.

## Pré-requisitos

1. `draft.md` do ciclo aprovado (Etapa 4 de `/diaria-mensal`).
2. `_internal/public-images.json` do ciclo — rodar a Etapa 3/4 do
   `/diaria-mensal` (`monthly-preview-cloudflare.ts`) antes, mesmo que o envio
   Clarice ainda não tenha acontecido (o preview já sobe as imagens pro KV).
   Os posts públicos (#9508) geram as próprias imagens — capa 4:5 + 4 slides
   por história, em `divulgacao/` — a partir de `04-d{N}-2x1.jpg` do ciclo
   (Etapa 3) e do título da história no `draft.md`; sobem pro KV no envio.
   Georgia instalada (sem ela a arte sai fora da marca — o script aborta).
3. `KIT_API_KEY` (e-mail), `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN`
   (página: push + conferência do KV), `DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`
   (LinkedIn, Instagram e Threads — o mesmo Worker), `FACEBOOK_PAGE_ID`/
   `FACEBOOK_PAGE_ACCESS_TOKEN` (Facebook) no ambiente; MCP do Buffer na
   sessão (X).

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
   `apoiase`, `linkedin_perfil`, `box`, `email` e, desde o #9508, um por post:
   `{linkedin_pagina,facebook,instagram,threads,x}:d{1,2,3}`; as chaves sem
   sufixo `linkedin_pagina`/`facebook`/`instagram`/`threads`/`x` são legado
   do post único, só lidas;
   `decideChannelAction` reusado do Artigo Especial). Canal `done` sem
   `--force` é pulado (log, não erro); `failed` é sempre retentável.
   Rodar antes `npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --sync-email`
   pra projetar no canal `email` o que o publisher Kit já fez.

5. **Agenda dos posts públicos.** `resolveRetrospectivaPostScheduledAts`
   (`scripts/lib/mensal/retrospectiva-schedule.ts`, #9508) com `--at` ou
   `--base-date` (o `--dry-run` do Passo 6 imprime os 15 horários + o do
   perfil). Imprimir o **banner de defaults assumidos** (#5321) sempre
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
   que o box e o apoia.se apontam. Os e-mails de `apoio_gate_editor_emails`
   (`platform.config.json`, #9491) entram sempre — é o que deixa o editor
   conferir a página como apoiador.

## Passo 1 — gerar os textos (agente, 1 dispatch)

Dispatch de **1** subagente `adhoc-opus-low` (agent dedicado, `model: claude-opus-5-5` +
`effort: low` no frontmatter — o Agent tool não aceita `effort`, #9081; #2019/#8941), a partir do `draft.md` do ciclo:

```
Agent(subagent_type="adhoc-opus-low", prompt=<
  Gere os textos de divulgação da Retrospectiva do Mês a partir de
  data/monthly/{ciclo}/draft.md. Nunca invente fatos além do que o draft
  sustenta.

  Todos são CHAMADA, não recorte: despertam curiosidade com o caso concreto
  e param antes do prêmio. Não copie nem parafraseie parágrafos do draft,
  não entregue as conclusões ("o fio condutor") — é isso que a pessoa vai
  buscar na retrospectiva. Nada de clickbait vazio. NUNCA cite
  retrospectiva.diar.ia.br nem qualquer URL da retrospectiva.

  Textos gerais (leia os títulos e o 1º parágrafo de cada DESTAQUE):
  1. apoiase.md — fala com quem JÁ apoia (R$25+): título na 1ª linha + 2
     parágrafos curtos. NÃO coloque a URL no texto: ela vai no campo
     "Link externo" do post ({retrospectivaUrl}). Sem CTA de conversão.
  2. linkedin-perfil.md — 1ª pessoa (voz do Pixel), sobre o mês inteiro,
     formato de post LinkedIn comum (context/publishers/linkedin.md seções
     1-8). Termine com a linha literal, sozinha:
     Apoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria
  3. box-gancho.md — 1 frase (≤ 160 caracteres) de gancho pro box da diária.

  Um par de textos POR HISTÓRIA (N = 1, 2, 3; leia o DESTAQUE N inteiro, mas
  chame só pelo caso concreto mais forte DELE — cada história é um post
  separado, no mesmo dia, então não repita o gancho entre elas):
  4. dN.md — voz institucional diar.ia.br (3ª pessoa), EXATAMENTE 3
     parágrafos separados por linha em branco, cada um com no máximo 260
     caracteres (é 1 slide de carrossel por parágrafo, com fonte fixa: o que
     não cabe é REESCRITO, nunca cortado). O 3º parágrafo fecha apontando pra
     Retrospectiva de {Mês}, sem entregar a conclusão. Opcional: uma linha
     final com até 5 hashtags. SEM CTA, sem apoia.se, sem markdown — o script
     soma a linha de CTA à legenda e o último slide já é o CTA. O mesmo texto
     vira a legenda de LinkedIn página, Facebook e Instagram (o link não é
     clicável no Instagram: nada de "clique no link").
  5. dN-curto.md — 1 parágrafo curto da mesma história + a linha literal
     curta, sozinha:
     Apoie e leia a retrospectiva completa: apoia.se/diaria
     Total ≤ 280 caracteres contando o CTA (o X conta apoia.se/diaria como
     23), no máximo 1 hashtag, sem URL, sem markdown. Vai pro Threads e pro X.

  Escreva os 9 arquivos em data/monthly/{ciclo}/divulgacao/.
>)
```

Depois, pros arquivos 1-2 e 4-5: `Skill("humanizador", ...)` e
`mcp__clarice__correct_text(...)`, aplicando as sugestões da Clarice
incondicionalmente (#4514), **exceto na linha literal de CTA** (frase do
editor — remover antes, recolocar depois) e em marca/identificador técnico.
Pular a geração dos canais em `--skip`. O e-mail não tem texto novo: é o
render Kit do próprio `draft.md`.

Checagem mecânica antes do gate — valida o `--skip` e roda
`publicPostCtaProblems` no post do perfil, `retrospectivaHistoriaBodyProblems`
em cada `d{N}.md` (exatamente 3 parágrafos, ≤260 cada, nenhum slide
transbordando o card — o mesmo guard do invariante `carousel-text-overflow`
da diária — sem CTA/URL paywalled/markdown), o título da capa (cabe a 62px)
e `retrospectivaSocialPostProblems` na legenda de cada rede (CTA + teto;
exit 1 = texto reprovado: REESCREVER — nunca encurtar o CTA nem truncar —
antes de mostrar no gate):

```bash
npx tsx scripts/check-retrospectiva-divulgacao.ts --cycle $CYCLE [--skip ...]
```

Os posts por história são rechecados no dispatch; o do PERFIL é colado à
mão, então esta é a única barreira mecânica dele.

Depois, gerar os slides pra o editor ver no gate (só local, sem upload nem
dispatch):

```bash
npx tsx scripts/publish-retrospectiva-social.ts --cycle $CYCLE --base-date {D} [--at ISO] [--skip ...] [--replace-linkedin-single] --dry-run
```

Com post único legado da página vivo (ciclo 2609-10), sem
`--replace-linkedin-single` o dry-run é recusado inteiro. Se o horário de
alguma história já passou (ex: D+1 = hoje e já passou das 10:00), o pré-voo
também recusa tudo: `--skip linkedin:d1,facebook:d1,instagram:d1,threads:d1,x:d1`
libera as histórias 2/3, ou escolha outro dia (`--base-date`/`--at`). Dia com
edição diária agendada é recusado (mesmos slots); os avisos de `warnings`
vão pro gate.

Grava `divulgacao/04-d{N}-4x5.jpg` (capa) e
`divulgacao/04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg` e imprime os 15 horários,
os textos finais (já com o CTA) e, se houver post único legado da página,
`legacy_linkedin.action: "would-cancel"`.

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

LinkedIn perfil (MANUAL, 1 post só, agenda {perfil}):
{linkedin-perfil.md}

Posts por história (3 × 5 = 15, dia {D+1}, slots da diária, 5 redes no mesmo horário; slides em divulgacao/04-d{N}-*.jpg):
  Edição diária em {D+1}: {nenhuma (fim de semana) | aviso de warnings}
  História 1 — {título do DESTAQUE 1} — 10:00:
    LinkedIn página + Facebook (capa) + Instagram (carrossel 5):
      {d1.md + linha longa de CTA}
    Threads (carrossel 5) + X via Buffer (capa + 3 slides):
      {d1-curto.md}
  História 2 — {título} — 12:30, mesmo formato ({d2.md} / {d2-curto.md})
  História 3 — {título} — 17:30, mesmo formato ({d3.md} / {d3-curto.md})
  Post único legado da página: {cancelar e substituir (--replace-linkedin-single) | nenhum}

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

## Passo 6 — posts públicos: 3 por rede (script) + X (Buffer, top-level) + perfil (manual)

Pulado post a post por `--skip` ou já `done` sem `--force` (#9508).

1. **LinkedIn página, Facebook, Instagram, Threads (script):**
   ```bash
   npx tsx scripts/publish-retrospectiva-social.ts --cycle $CYCLE \
     --base-date {data do envio, Passo 0.5} [--at ISO] [--skip ...] [--force canal[:dN][,...]] \
     [--old-cancelled facebook:d1,x] [--replace-linkedin-single] [--dry-run]
   ```
   Por história: gera capa 4:5 + 4 slides em `divulgacao/` e sobe os 5 pro KV
   (`img-{ciclo}-04-d{N}-4x5.jpg`, `img-{ciclo}-04-d{N}-carousel-{slot}-4x5.jpg`);
   LinkedIn página por `dispatchEntry` (Worker, `allowImmediateFallback:
   false`, #6015 — sem Worker a rota seria `make_now` e publicaria AGORA),
   Facebook por `publishFacebookCarouselByUrl` (agendamento nativo da Graph
   API, 1 foto), Instagram/Threads por `postToWorkerQueue` com `image_urls`
   (carrossel de 5). `destaque` no Worker = `especial-retrospectiva`
   (`especial-{letras}` é o único namespace sem semântica alheia; `d[123]`,
   `weekly-*` e `eia-*` são de outros fluxos). Não roda os CLIs da diária
   porque eles injetam a URL da edição — aqui seria a URL paywalled.
   **Pré-voo tudo-ou-nada:** texto reprovado, título que não cabe na capa,
   imagem da história faltando, horário a <10 min, credencial/Worker ausente
   em QUALQUER post ativo, ou post único legado da página vivo sem
   `--replace-linkedin-single` → nada é gerado nem despachado. Detalhe por
   história em `_internal/divulgacao-social-d{N}-published.json` (2º guard:
   post vivo ali pula mesmo sem registro no state). `--force` sobre um post
   vivo: LinkedIn/Instagram/Threads cancelam a entry antiga na fila do Worker
   ANTES de reenviar (se ela já saiu da fila — provavelmente publicada — o
   post falha sem reenviar); Facebook/X não têm cancelamento por script — o
   editor apaga o anterior na rede e confirma com `--old-cancelled
   {canal}:d{N}`, senão o pré-voo recusa (sairiam dois). Posts do Worker
   reconciliados por história (DLQ → `failed`; reconciliação que não roda
   deixa `done` e sai com exit 1). Rede desligada no `platform.config.json`
   (`publishing.social.{canal}.enabled: false`) é pulada com aviso.

   **Post único legado da página (ciclo 2609-10):** com
   `--replace-linkedin-single`, a entry do #9474
   (`_internal/divulgacao-linkedin-published.json`) é cancelada no Worker
   antes dos 3 novos — store legado vira `deleted`, canal `linkedin_pagina`
   (sem sufixo) vira `pending` com o motivo. `legacy_linkedin.action` no JSON:
   `cancelled`; `already-gone` (já tinha saído da fila — provavelmente
   publicado; os 3 seguem mesmo assim, reportar ao editor); `failed` (o DELETE
   falhou — os 3 da página NÃO saem, os das outras redes sim; rodar de novo).
2. **X (top-level):** o mesmo comando devolve, no JSON, 3 itens
   `{"channel": "x", "action": "x-payload", "historia": "d{N}"}`, cada um com
   `channelId`, `text`, `dueAt`, `images` (capa + 3 parágrafos, **sem** o
   slide de CTA — até `TWITTER_IMAGE_LIMIT` = 4) e `publishedPath` (o store da
   história) — o MCP do Buffer só é alcançável daqui. Pra CADA payload:
   **antes da mutation**, listar os posts agendados do canal no Buffer
   (`execute_query`) e pular se já houver um com o mesmo `dueAt` — uma
   execução anterior pode ter criado o post e caído antes de gravar (o
   payload é reimpresso até o `append`). `imagePendingUpload: true` só
   aparece no `--dry-run` (as URLs nascem no upload do envio). Chamar `mcp__claude_ai_Buffer__execute_mutation` (NÃO `create_post`: o
   schema não tipa `assets` como array, ver Passo 5c-3b de
   `.claude/agents/orchestrator-stage-5.md`) com `createPost(input: {
   channelId, text, mode: customScheduled, schedulingType: automatic, dueAt,
   assets: [{ image: { url, metadata: { altText } } }, ...] })` — um asset por
   item de `images`, na ordem — e gravar:
   ```bash
   npx tsx scripts/append-twitter-published.ts --published-path {publishedPath} \
     --destaque especial-retrospectiva --status scheduled --buffer-post-id {id} --scheduled-at {dueAt}
   npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --channel x:d{N} --status done
   ```
   Erro na mutation → `append-twitter-published.ts ... --status failed
   --reason "{erro}"` + `mark-retrospectiva-channel.ts --channel x:d{N} --status
   failed --reason "{erro}"`; sem fallback pra `create_post`.
3. **Perfil LinkedIn (manual, 1 post só):** pulado se `--skip linkedin`.
   Rodar de novo o `check-retrospectiva-divulgacao.ts` (o texto pode ter sido
   mexido depois do gate) e agendar `divulgacao/linkedin-perfil.md` no
   composer nativo para o horário `perfil` do Passo 0.5 (D+2 09:30 BRT) e
   marcar:
   `npx tsx scripts/mark-retrospectiva-channel.ts --cycle $CYCLE --channel linkedin_perfil --status done`.
   O Worker rejeita `webhook_target=pixel` + `action=post` — não tente por
   script.

Falha num post não bloqueia os outros (fail-soft por post).

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
  (os scripts de página e dos posts públicos já registram o seu).
- Resumo no terminal: estado final de cada canal (`divulgacao-published.json`),
  URL da página, id do broadcast + status (rascunho/agendado), URL do post
  apoia.se, horário a agendar no perfil, tabela história × rede dos 15 posts
  com horário + id (`worker_queue_key`/`fb_post_id`/`buffer_post_id`), o
  destino do post único legado da página (`legacy_linkedin`) (validar com
  `scripts/lib/publish-state.ts` antes de afirmar "agendado", #573), diff do
  box + número do PR, e o banner de defaults assumidos.
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
    linkedin-perfil.md                 post do perfil pessoal, 1 só (Passo 1)
    d{N}.md                            3 parágrafos da história N — slides + legenda de LinkedIn/Facebook/Instagram (Passo 1, #9508)
    d{N}-curto.md                      ≤280 com CTA curto — Threads/X (Passo 1, #9508)
    04-d{N}-4x5.jpg                    capa da história N (Passo 1 dry-run / Passo 6, #9508)
    04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg  slides da história N (idem)
    box-gancho.md                      gancho do box (Passo 1)
  _internal/
    divulgacao-published.json          status por canal — pagina/apoiase/linkedin_perfil/box/email + {linkedin_pagina,facebook,instagram,threads,x}:d{1,2,3} (#9508; chaves sem sufixo = legado)
    divulgacao-social-d{N}-published.json  detalhe do dispatch da história N (worker_queue_key, fb_post_id, buffer_post_id)
    divulgacao-linkedin-published.json legado: post único da página (#9474) — `deleted` depois do --replace-linkedin-single
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
continua humano. Os 15 posts por história saem agendados (#9508); o X
depende do top-level (MCP do Buffer).
