---
name: diaria-artigo-especial
description: Fecha as 3 ações manuais que seguem o deploy de um Artigo Especial (`especial.diar.ia.br/{ano}/{slug}/`) — post teaser no apoia.se, posts agendados no LinkedIn (página diar.ia.br D+1 09:00 BRT + perfil pessoal D+2 09:30 BRT — #6014) e atualização + pin do box "Artigo Especial" (slot 2, desde #6748 — era slot 3, eliminado) da diária. Requer a máquina do editor (Claude in Chrome logado) — não roda no `helios`. Uso — `/diaria-artigo-especial --slug {slug} [--ano AAAA] [--at ISO] [--skip apoiase,linkedin,box] [--dry-run] [--unpin]`.
---

# /diaria-artigo-especial

Fecha o loop de divulgação de um Artigo Especial já **deployado** (issue
#5979). Todo mês o artigo sai com 3 ações manuais repetidas pelo editor:
post teaser no apoia.se, posts agendados no LinkedIn (página + perfil), e
atualização do box "Artigo Especial" da diária pinado no slot 2 (desde
#6748 — era slot 3 até 29/08/2026, quando o #6748 eliminou o slot 3 da
rotação inteira; pinar no slot 3 hoje escreveria a config e reportaria
sucesso sem NENHUM efeito, porque `stitch-newsletter.ts` nunca mais
renderiza esse slot). **Trade-off aceito na troca para o slot 2**: o slot 2
só existe no gap D2/D3 — em edição de 2 destaques (#2343/#3369) o box do
Artigo Especial não aparece nessa edição, mesmo pinado (diferente do antigo
slot 3, que injetava sempre após o último destaque, independente da
contagem). Esta skill empacota as 3 ações num único playbook, com gate
humano único antes de qualquer publicação e state file por canal pra
resumir com segurança.

**Pré-requisito fora do escopo desta skill**: o artigo já precisa estar
deployado em `especial.diar.ia.br/{ano}/{slug}/` (`cd workers/artigos && npx
wrangler deploy` — ver `workers/artigos/README.md`). Esta skill só LÊ o
artigo publicado, nunca gera/edita o HTML dele.

## Classificação de execução

`windows` → **Develop**, nunca Overnight (mesma regra de `/diaria-apoios-sync`
e do próprio #5751 documentado em `CLAUDE.md`). O Passo 3 (apoia.se) exige
Claude in Chrome com o editor logado — sem navegador utilizável, a skill
inteira não fecha de ponta a ponta.

## Decisões já tomadas (editor, 23/08/2026 — não reabrir, issue #5979)

| Pergunta | Decisão |
|---|---|
| Conteúdo do post apoia.se | **CHAMADA, não recorte (revisto pelo editor 23/08/2026, 1ª execução ao vivo — substitui a decisão original de reaproveitar os `leadParagraphs`).** Título + 2 parágrafos curtos que despertem curiosidade + URL. O texto levanta uma tensão e para; o mecanismo/a tese fica no artigo, que é o que a pessoa vai lá buscar. Nunca o texto integral nem o conteúdo do paywall (`artigo.diar.ia.br`, `workers/artigo-mensal` — canal separado). |
| Conteúdo dos posts LinkedIn | Mesma regra de chamada acima (editor, 23/08/2026): o post não entrega a tese completa no feed. Isca concreta (o caso real) + promessa do que o artigo responde, sem responder. |
| **Link do artigo no LinkedIn** | **NUNCA divulgar a URL direta de `especial.diar.ia.br` nos posts de LinkedIn** (editor, 23/08/2026; justificativa corrigida em #6014/#6013: o artigo é PÚBLICO e indexado de propósito — está no `sitemap.xml` com `robots.txt` liberando crawlers de IA. O que o tier R$10+ compra é antecedência, entrega por e-mail e arquivo, não exclusividade de leitura). O CTA fecha no apoia.se porque é lá que a conversão acontece, não porque o artigo seja inacessível. Os 2 posts de LinkedIn fecham com a linha literal `Apoie nosso trabalho e leia o artigo completo em: apoia.se/diaria` (frase do editor, não reescrever, não passar por Clarice/humanizador). Só `apoiase.md` leva a URL direta, porque ali o público já é apoiador. Vale pra qualquer canal público futuro (Facebook, Instagram, X): CTA aponta pro apoia.se, nunca pro artigo. |
| Conta(s) e horário LinkedIn | Página diar.ia.br (`webhook_target: "diaria"`) **D+1 09:00 BRT** e perfil pessoal (`webhook_target: "pixel"`) **D+2 09:30 BRT**, textos distintos (#6014 item 1 — o default único antigo D+1 17:30 colidia com o `d3` da edição diária no mesmo minuto). Agenda do dia: `09:00 especial-pagina | 10:00 d1 | 12:30 d2 | 17:30 d3`. |
| Box | Reescrever `data/snippets/artigo-especial-apoiadores.md` + pinar no slot 2 (`boxes_divulgacao.slot2` + `boxes_divulgacao_auto.pinned_slots: [2]` em `platform.config.json` — era slot 3 até o #6748 eliminá-lo, ver seção "Decisões já tomadas" acima). |
| Visibilidade apoia.se | **Restrito a apoiadores R$10+ (revisto pelo editor 23/08/2026, 1ª execução ao vivo — substitui "público").** Motivo: `data/snippets/artigo-especial-apoiadores.md` vende o Artigo Especial como benefício de R$10+/mês; post público entregaria o benefício a quem não paga no mesmo instante. A restrição é do POST — o artigo em si segue público em `especial.diar.ia.br` (o canal com paywall continua sendo outro: `artigo.diar.ia.br`, `workers/artigo-mensal`). Consequência no texto: o `apoiase.md` fala com quem JÁ apoia, sem CTA de conversão. |

## Argumentos

- `--slug` **obrigatório** — nunca inferido (mesma regra de todas as
  `/diaria-*`: data/identificador sempre explícito).
- `--ano AAAA` — default: ano corrente.
- `--at ISO` — horário do agendamento LinkedIn quando quiser os DOIS
  canais no mesmo instante. Default (#6014 item 1): cada canal tem o seu —
  **página D+1 09:00 BRT, perfil D+2 09:30 BRT**, via
  `scripts/lib/artigo-especial-schedule.ts::resolveArtigoEspecialScheduledAts`
  (reusa `computeScheduledAt`, não reimplementa — ver docstring do módulo).
  Imprimir os horários assumidos em destaque quando `--at` for omitido
  (banner, regra #5321 do `CLAUDE.md`).
- `--skip apoiase,linkedin,box` — pula canal(is) especificados (mesmo padrão
  `--skip` do Stage 5 diário).
- `--dry-run` — gera os 3 textos, mostra tudo, não publica/agenda/grava
  nada. Para no gate humano (Passo 2 abaixo).
- `--unpin` — só remove o `2` de `boxes_divulgacao_auto.pinned_slots`
  (`platform.config.json`) — usar quando o artigo envelhecer e o slot 2
  deve voltar pro auto-select por cliques (#4626). Não mexe em nenhum outro
  canal; ignora `--slug`/`--ano` (não precisa do artigo).
- `--force` — reexecuta um canal já `done` no state file (ver Passo 0).

## Passo 0 — preflight

1. **Capacidade de navegador** (mesmo padrão de `/diaria-apoios-sync` Passo
   0, #5209): `npx tsx scripts/lib/browser-capability.ts`.
   - `unavailable`/`unknown` → HALT (a menos que `--skip apoiase` cubra o
     único canal que precisa de Chrome):
     ```
     npx tsx scripts/render-halt-banner.ts \
       --stage "diaria-artigo-especial — Passo 0" \
       --reason "sem navegador utilizável nesta máquina (sem DISPLAY/WAYLAND_DISPLAY ou sem binário de browser)" \
       --action "esta skill precisa de navegador logado (Claude in Chrome) para o canal apoia.se; rode na máquina do editor, ou passe --skip apoiase"
     ```
     Aguardar resposta explícita antes de prosseguir (#738/#3938).
   - `available` → prosseguir.

2. **Metadados do artigo.** Resolver
   `workers/artigos/public/{ano}/{slug}/index.html` e extrair via
   `scripts/lib/artigo-especial-meta.ts::readArtigoMeta` — `{title,
   description, url, image, datePublished, h1, leadParagraphs}`. Arquivo
   ausente → erro claro: `"Artigo não encontrado em
   workers/artigos/public/{ano}/{slug}/index.html — rode 'cd
   workers/artigos && npx wrangler deploy' antes desta skill (pré-requisito
   fora do escopo)."`

3. **Confirmar que o Worker está servindo o artigo ao vivo.** `GET`/`HEAD`
   em `meta.url` (o `og:url` extraído acima) → precisa `200`. Deploy é
   pré-requisito manual — `404`/erro de rede aqui é a mesma mensagem do
   item 2 (aponta pro `wrangler deploy`).

4. **Mural do apoia.se ANTES de criar post (#6014 item 3).** O guard de
   idempotência abaixo só enxerga o que ESTA skill fez — um post publicado
   à mão pelo editor é invisível pra ela. Antes do Passo 3 (apoia.se),
   abrir a aba `Posts no Mural` da campanha e procurar o post do mês.
   Já existe? **Editar aquele** (preserva URL e timestamp) em vez de criar
   outro — mesma classe do "publicação manual exige refresh-dedup" da
   Beehiiv registrada no `CLAUDE.md`.

5. **Guard de idempotência.** State file
   `data/artigo-especial/{ano}-{slug}/published.json`
   (`scripts/lib/artigo-especial-state.ts` — `readArtigoEspecialState`,
   `decideChannelAction` por canal: `apoiase`, `linkedin_pagina`,
   `linkedin_perfil`, `box`). Canal já `done` sem `--force` é pulado nos
   Passos 3-5 (log, não erro). `--force` reexecuta.

6. **Resolver o `--at`.** Se `--at` foi passado, validar com
   `validateExplicitAt` (ISO parseável, futuro) — vale pros dois canais.
   Se omitido, resolver via `resolveArtigoEspecialScheduledAts(config)`
   (default #6014: página D+1 09:00 BRT, perfil D+2 09:30 BRT) e imprimir
   o banner dos defaults aplicados.

## Passo 1 — gerar os 3 textos (agente, 1 dispatch)

Dispatch de **1** subagente `general-purpose` com `model: sonnet` explícito
(#2019 — subagente ad-hoc sempre com model explícito), a partir dos
metadados do Passo 0 (`title`, `description`, `leadParagraphs`, `url`):

```
Agent(subagent_type="general-purpose", model="sonnet", prompt=<
  Gere 3 textos a partir deste artigo especial (metadados abaixo). Nunca
  invente fatos além do que os metadados sustentam.

  Os 3 são CHAMADA, não recorte (editor, 23/08/2026 — ver tabela de
  decisões): despertam curiosidade e param antes do prêmio. Não copie nem
  parafraseie os leadParagraphs, e não entregue a tese/o mecanismo no
  próprio post — é isso que a pessoa vai buscar no artigo. Os títulos das
  seções (`<h3 class="sect">` do HTML) são ótimos ganchos de PROMESSA:
  citam o que o artigo responde sem revelar a resposta. Nada de clickbait
  vazio — o gancho é concreto, o interesse vem do fato real ser estranho.

  1. apoiase.md — chamada pública: título do artigo + 2 parágrafos curtos
     de chamada + URL.
  2. linkedin-pagina.md — voz institucional diar.ia.br (3ª pessoa), CTA
     pra apoia.se/diaria + link do artigo. Formato de post LinkedIn comum
     (ver context/publishers/linkedin.md seções 1-8 pro tom esperado).
  3. linkedin-perfil.md — 1ª pessoa (voz do Pixel), mesmo CTA, mais pessoal
     (mesmo espírito do post_pixel do Stage 6 diário).

  Metadados: {title, description, url, image, leadParagraphs}
  Escreva os 3 arquivos em data/artigo-especial/{ano}-{slug}/.
>)
```

Depois, para os 3 arquivos:

```
Skill("humanizador", "Humanize este texto em português, mantendo o sentido: <texto>")
```

e:

```
mcp__clarice__correct_text(<texto humanizado>)
```

Aplicar todas as sugestões da Clarice incondicionalmente (mesma disciplina
do Stage 2 diário — #4514), exceto sugestão que corrompa marca/identificador
técnico. Gravar o texto final (humanizado + corrigido) de volta nos 3
arquivos.

**Isenção do `--skip`**: se `--skip apoiase` (ou `linkedin`), ainda assim
gerar o texto correspondente é opcional — pular a geração de um canal que já
será pulado nos Passos 3-4 evita trabalho descartado. `box` não usa nenhum
dos 3 arquivos (o gancho do box vem separado, ver Passo 5).

## Passo 2 — gate humano único

Mostrar ao editor de uma vez (critério 1 de "Perguntar é exceção",
`CLAUDE.md`): o post do apoia.se publica em conta pública **na hora**
(irreversível) — mesmo LinkedIn/box sendo reversíveis (agendamento 24h+,
arquivo local), os 3 saem do mesmo comando, então o gate cobre os 3 juntos.

```
📄 Artigo Especial — {title} ({url})

Apoia.se (teaser, publica AGORA se aprovado):
{apoiase.md}

LinkedIn página (agenda {--at resolvido}):
{linkedin-pagina.md}

LinkedIn perfil (agenda {--at resolvido}):
{linkedin-perfil.md}

Box (slot 2, pinado até --unpin — só aparece em edição de 3 destaques, #6748):
{preview do box com título/gancho}

Aprovar os 3? sim / ajustar {canal} / abortar
```

`AskUserQuestion` falhando → halt banner (#3938), nunca prosseguir sem
resposta. `--dry-run` para aqui, sem publicar nada.

## Passo 3 — apoia.se (Claude in Chrome, top-level)

Canal `apoiase` — pulado se `--skip apoiase` ou já `done` sem `--force`.

Seguir `context/publishers/apoia-se.md`. **Este playbook ainda não está
mapeado ao vivo** — a 1ª execução real precisa navegar manualmente até achar
o composer de post do painel de criador e ATUALIZAR o playbook com os
seletores/fluxo reais antes de considerar a skill "pronta" (ver seção "O que
falta mapear" do arquivo).

**Gravar o resultado é SEMPRE via `scripts/mark-artigo-especial-channel.ts`
— nunca escrever `published.json` manualmente (achado #5988/type-design-
analyzer, PR #6000: sem um script determinístico, o guard deste canal
existia só como instrução em prosa, com zero enforcement — a mesma classe de
bug já corrigida pro canal `box` nesta mesma PR, mas com blast radius maior
aqui, porque `apoiase` posta numa conta PÚBLICA e irreversível).**

Falha aqui:
```bash
npx tsx scripts/mark-artigo-especial-channel.ts --ano {ano} --slug {slug} \
  --channel apoiase --status failed --reason "{motivo — ex: DOM do painel mudou, ver X}"
```
**continua** pros outros canais (fail-soft por canal, mesma disciplina do
Stage 5 diário) — nunca aborta a skill inteira por causa de um canal.

Sucesso:
```bash
npx tsx scripts/mark-artigo-especial-channel.ts --ano {ano} --slug {slug} \
  --channel apoiase --status done --url "{URL do post publicado}"
```

## Passo 4 — LinkedIn

**PÁGINA via script; PERFIL à mão (#6014 item 2).** O Worker REJEITA
`webhook_target=pixel` + `action=post` (`workers/linkedin-cron/src/index.ts`,
"supports only action='comment'") — o cenário Make do editor só faz comment,
então o post standalone no perfil pessoal NUNCA foi executável por script.
Não tente despachar o perfil pelo script: vai falhar sempre.

1. **Página (script determinístico):**

```bash
npx tsx scripts/publish-artigo-especial-linkedin.ts \
  --dir data/artigo-especial/{ano}-{slug} \
  --only pagina \
  [--at {ISO}] [--force]
```

   `--at` omitido = default do canal página (D+1 09:00 BRT, resolvido dentro
   do próprio script via `resolveArtigoEspecialScheduledAts` — banner no log).

2. **Perfil (manual, composer do LinkedIn):** agendar o texto de
   `data/artigo-especial/{ano}-{slug}/linkedin-perfil.md` para **D+2 09:30
   BRT** no composer nativo (funcionou bem na 1ª execução, 23/08). Depois,
   marcar o canal como feito:
   `npx tsx scripts/mark-artigo-especial-channel.ts --ano {ano} --slug {slug}
   --channel linkedin_perfil` (ou equivalente do state file).

   Alternativa futura a decidir (#6014): virar **comment** no post da página
   (o Worker suporta hoje) em vez de post standalone — decisão de produto,
   não implementar por conta própria.

Canal `linkedin_pagina`/`linkedin_perfil` é pulado individualmente se
`--skip linkedin` ou já `done` sem `--force` (guard por canal).

Reusa `dispatchEntry` (`scripts/publish-linkedin.ts`, sem modificação) — 2
chamadas, `webhookTarget: "diaria"`/`"pixel"`, `action: "post"`, `subtype:
"main"`, `imageUrl` = `og:image` do artigo (derivado automaticamente via
`scripts/lib/artigo-especial-meta.ts`, sem precisar passar `--image-url`).
**Fail-fast**: se o Worker LinkedIn (`DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`)
não estiver configurado, o script aborta os **2** dispatches antes de
despachar qualquer um — `webhook_target=pixel` (perfil) não tem fallback
Make, e publicar só a página sem o perfil (metade do anúncio) sem o editor
perceber é pior que abortar os 2 (ver docstring do script).

Grava o detalhe de cada dispatch (`worker_queue_key`, `route`,
`scheduled_at`) em `data/artigo-especial/{ano}-{slug}/linkedin-published.json`
(formato `SocialPublished`, mesmo de `06-social-published.json` — reconciliado
automaticamente contra o Worker via `verify-social-worker-dispatch.ts`
depois do dispatch) e o status agregado por canal em `published.json`.

## Passo 5 — box (script + PR)

Canal `box` — pulado se `--skip box` ou já `done` sem `--force`.

```bash
npx tsx scripts/update-artigo-especial-box.ts \
  --titulo "{title do artigo}" \
  --gancho "{1 frase de gancho, derivada da description ou 1º leadParagraph}" \
  --mes "{Mês por extenso, ex: Setembro}" \
  --ano {ano} --slug {slug} \
  [--no-pin] [--force]
```

**`--ano`/`--slug` não são cosméticos — são o que ativa o guard de
idempotência do canal `box`** (`decideChannelAction` em
`scripts/lib/artigo-especial-state.ts`, mesmo state file
`published.json` dos Passos 3-4): sem eles o script roda sempre, sem checar
nem gravar o canal (é o modo usado só pelo `--unpin` standalone, ver
abaixo). Rodando com `--ano`/`--slug` (o caso normal desta skill), a 2ª
chamada pro mesmo artigo sem `--force` é pulada (log, exit 0) em vez de
reabrir a branch/PR à toa.

Reescreve **só o corpo** de `data/snippets/artigo-especial-apoiadores.md`
(preserva header de comentário + parágrafo do tier + CTA — edição cirúrgica,
#495; `ArtigoEspecialBoxFormatError` se o formato divergiu — ajustar
manualmente 1x antes de rodar de novo, nunca adivinhar — e propaga: o canal
`box` grava `failed` em `published.json`, retentável sem `--force` na
próxima chamada) e — por padrão — pina o slot 2 em `platform.config.json`
(`boxes_divulgacao.slot2="artigo-especial-apoiadores.md"` +
`boxes_divulgacao_auto.pinned_slots` ganha `2`, idempotente. Era slot 3 até
o #6748 eliminar esse slot da rotação — ver "Decisões já tomadas" acima).

**`platform.config.json` é git — abrir PR:**

```bash
git checkout -b artigo-especial/{ano}-{slug}
git add platform.config.json
git commit -m "chore(#5979): pin box Artigo Especial slot 2 — {ano}-{slug}"
gh pr create --title "chore(#5979): pin box Artigo Especial — {título curto}" \
  --body "Pin do box \"Artigo Especial\" no slot 2 para o artigo {ano}/{slug}. Skill /diaria-artigo-especial."
```

(`data/snippets/artigo-especial-apoiadores.md` **não** entra no commit — é
OneDrive, gitignored, já sincroniza sozinho.) Review automatizado dispara
via hook (`pr-create-review.mjs`, `CLAUDE.md` "Effort do review
automatizado") e o merge segue a regra geral de sessão interativa (#5251,
`CLAUDE.md`): review limpo + CI verde → mergear direto, sem pausar pra
confirmação. Diff de config de 1 linha deve cair no branch `low` effort
automaticamente (abaixo do limiar de 500 linhas).

`--unpin` invocado standalone (sem `--slug`) roda só este passo, com `--pin`
implícito `false` — mesmo fluxo de branch/PR, sem tocar em
`published.json`/apoiase/LinkedIn.

## Passo 6 — resumo + registro

- `logEvent` (`scripts/lib/run-log.ts`) por canal, `edition: "{ano}-{slug}"`.
- Resumo no terminal: URL do post apoia.se (se saiu), as 2
  `worker_queue_key` do LinkedIn + horário agendado, diff do box, número do
  PR.
- Sem confirmação pós-sucesso (regra geral "Perguntar é exceção"); sem
  encadear nada — esta skill não é um stage de `/diaria-edicao`, termina
  aqui.

## Atualizações pós-1ª execução ao vivo (23/08/2026, #6014)

- **Horário real confirmado:** a 1ª execução usou `D+1 17:30 BRT` (default antigo, hoje SUBSTITUÍDO pelo par D+1 09:00 × D+2 09:30 do #6014 — justamente por ter colidido com o d3); o agendamento em si foi confirmado ao vivo (status `done` para `apoiase` 02:06, `linkedin_pagina` 02:46, `box` 02:17 — todos no mesmo dia, 23/08).
- **Visibilidade apoia.se:** confirmada como `restrito a apoiadores R$10+` (não público). Nenhuma alteração no texto do `apoiase.md`; o post não contém CTA de conversão, apenas acesso direto ao artigo para quem já apoia.
- **Perfil pessoal (`linkedin_perfil`):** falhou na 1ª execução (`failed`, `reason: "reconciliação pós-dispatch: Worker reportou falha (DLQ)."`). A falha ocorreu APÓS o dispatch — não é um erro do script `publish-artigo-especial-linkedin.ts` (o `dispatchEntry` executou sem 4xx), mas sim um erro do Worker no momento de conciliar a entrega. Isso confirma a necessidade do fix #6015: se o Worker retornar 4xx durante o dispatch, o fallback não deve ser permitido; se a falha for posterior (DLQ), o estado `failed` no `linkedin-published.json` já é a resposta correta.
- **Box (`slot3` na 1ª execução, migrado pra `slot2` no #6748 — 29/08/2026):** `done` — `platform.config.json` atualizado, PR criada automaticamente (`pr-create-review.mjs`). Nenhuma mudança adicional necessária.
- **Nenhuma alteração no conteúdo das chamadas:** a 1ª execução confirmou que o texto gerado por `subagent` (`sonnet`) segue a regra de CHAMADA, e a humanização (`humanizador`) e a correção (`mcp__clarice__correct_text`) mantêm a integridade. Nenhuma edição manual foi feita nos textos após a geração — o editor aprovou diretamente no gate (Passo 2).

## Casos de borda

- **Artigo não deployado** (`index.html` ausente ou `og:url` não responde
  200) → erro no Passo 0, aponta pro `wrangler deploy` — não segue pro
  Passo 1.
- **Canal individual falha** (apoia.se DOM mudou, Worker LinkedIn fora do
  ar) → grava `failed` naquele canal, segue pros outros (fail-soft por
  canal). Resume (`--force` não necessário — falha é sempre retentável, ver
  `decideChannelAction`) reexecuta só o(s) canal(is) `pending`/`failed`.
- **Canal já `done`** → pulado no resume, sem `--force`.
- **`--unpin`** → não gera nenhum dos 3 textos, não toca no state file de
  apoiase/LinkedIn — só o Passo 5 roda (`applyBoxPin` com `pin: false`),
  removendo `2` de `pinned_slots` sem tocar `boxes_divulgacao.slot2` (ver
  docstring de `applyBoxPin`) — o slot volta a ser candidato do auto-select
  por cliques (#4626) em vez de ficar travado no artigo antigo.
- **Formato do snippet divergiu** (`data/snippets/artigo-especial-apoiadores.md`
  foi editado manualmente fora da convenção `**Artigo Especial de {Mês}**` /
  `O Artigo Especial desse/deste mês é: ...`) → `update-artigo-especial-box.ts`
  aborta com `ArtigoEspecialBoxFormatError` em vez de adivinhar onde inserir
  — ajustar manualmente 1x (ver `context/snippets/README.md`), depois rodar
  de novo.

## Outputs

```
data/artigo-especial/{ano}-{slug}/
  apoiase.md                  chamada publica (Passo 1)
  linkedin-pagina.md          post pagina diar.ia.br (Passo 1)
  linkedin-perfil.md          post perfil pessoal (Passo 1)
  published.json              status agregado por canal — apoiase/linkedin_pagina/linkedin_perfil/box (Passo 0 guard, atualizado nos Passos 3-5)
  linkedin-published.json     detalhe do dispatch LinkedIn (worker_queue_key, route, scheduled_at — Passo 4)
```

`platform.config.json` (`boxes_divulgacao.slot2` + `pinned_slots` — desde
#6748; era `slot3`) e `data/snippets/artigo-especial-apoiadores.md` — ver
Passo 5.
