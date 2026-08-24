---
name: diaria-artigo-especial
description: Fecha as 3 ações manuais que seguem o deploy de um Artigo Especial (`especial.diar.ia.br/{ano}/{slug}/`) — post teaser no apoia.se, posts agendados no LinkedIn (página diar.ia.br + perfil pessoal, D+1 17:30 BRT) e atualização + pin do box "Artigo Especial" (slot 3) da diária. Requer a máquina do editor (Claude in Chrome logado) — não roda no `helios`. Uso — `/diaria-artigo-especial --slug {slug} [--ano AAAA] [--at ISO] [--skip apoiase,linkedin,box] [--dry-run] [--unpin]`.
---

# /diaria-artigo-especial

Fecha o loop de divulgação de um Artigo Especial já **deployado** (issue
#5979). Todo mês o artigo sai com 3 ações manuais repetidas pelo editor:
post teaser no apoia.se, posts agendados no LinkedIn (página + perfil), e
atualização do box "Artigo Especial" da diária pinado no slot 3. Esta skill
empacota as 3 num único playbook, com gate humano único antes de qualquer
publicação e state file por canal pra resumir com segurança.

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
| Conteúdo do post apoia.se | Teaser + link: título + 2-3 parágrafos de abertura (reaproveitados do artigo) + URL. Não é o texto integral nem o conteúdo do paywall (`artigo.diar.ia.br`, `workers/artigo-mensal` — canal separado). |
| Conta(s) e horário LinkedIn | Página diar.ia.br (`webhook_target: "diaria"`) **e** perfil pessoal (`webhook_target: "pixel"`), textos distintos, **D+1 17:30 BRT** (mesmo horário `d3_time` dos posts de edição). |
| Box | Reescrever `data/snippets/artigo-especial-apoiadores.md` + pinar no slot 3 (`boxes_divulgacao.slot3` + `boxes_divulgacao_auto.pinned_slots: [3]` em `platform.config.json`). |
| Visibilidade apoia.se | Público (teaser e artigo são ambos públicos). |

## Argumentos

- `--slug` **obrigatório** — nunca inferido (mesma regra de todas as
  `/diaria-*`: data/identificador sempre explícito).
- `--ano AAAA` — default: ano corrente.
- `--at ISO` — horário do agendamento LinkedIn. Default: **D+1 17:30 BRT a
  partir de hoje**, via `scripts/lib/artigo-especial-schedule.ts::resolveArtigoEspecialScheduledAt`
  (reusa `computeScheduledAt`, não reimplementa — ver docstring do módulo
  pra como "D+1 17:30" mapeia pro vocabulário `editionDate`/`destaque` dessa
  função). Imprimir o horário assumido em destaque quando `--at` for
  omitido (banner, regra #5321 do `CLAUDE.md`).
- `--skip apoiase,linkedin,box` — pula canal(is) especificados (mesmo padrão
  `--skip` do Stage 5 diário).
- `--dry-run` — gera os 3 textos, mostra tudo, não publica/agenda/grava
  nada. Para no gate humano (Passo 2 abaixo).
- `--unpin` — só remove o `3` de `boxes_divulgacao_auto.pinned_slots`
  (`platform.config.json`) — usar quando o artigo envelhecer e o slot 3
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

4. **Guard de idempotência.** State file
   `data/artigo-especial/{ano}-{slug}/published.json`
   (`scripts/lib/artigo-especial-state.ts` — `readArtigoEspecialState`,
   `decideChannelAction` por canal: `apoiase`, `linkedin_pagina`,
   `linkedin_perfil`, `box`). Canal já `done` sem `--force` é pulado nos
   Passos 3-5 (log, não erro). `--force` reexecuta.

5. **Resolver o `--at`.** Se `--at` foi passado, validar com
   `validateExplicitAt` (ISO parseável, futuro). Se omitido, resolver via
   `resolveArtigoEspecialScheduledAt(config)` (default D+1 17:30 BRT) e
   imprimir o banner de default aplicado.

## Passo 1 — gerar os 3 textos (agente, 1 dispatch)

Dispatch de **1** subagente `general-purpose` com `model: sonnet` explícito
(#2019 — subagente ad-hoc sempre com model explícito), a partir dos
metadados do Passo 0 (`title`, `description`, `leadParagraphs`, `url`):

```
Agent(subagent_type="general-purpose", model="sonnet", prompt=<
  Gere 3 textos a partir deste artigo especial (metadados abaixo). Nunca
  invente fatos além do que os metadados sustentam.

  1. apoiase.md — teaser público: título do artigo + os leadParagraphs
     reaproveitados (não reescreva o conteúdo já publicado, é o mesmo texto
     do artigo) + call-to-action pro link. 2-3 parágrafos + URL.
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

Box (slot 3, pinado até --unpin):
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

## Passo 4 — LinkedIn (script determinístico)

Canal `linkedin_pagina` + `linkedin_perfil` — pulado(s) individualmente se
`--skip linkedin` (pula os 2) ou já `done` sem `--force` (guard por canal,
independente entre página e perfil).

```bash
npx tsx scripts/publish-artigo-especial-linkedin.ts \
  --dir data/artigo-especial/{ano}-{slug} \
  --at {--at resolvido no Passo 0} \
  [--only pagina|perfil] [--force]
```

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
próxima chamada) e — por padrão — pina o slot 3 em `platform.config.json`
(`boxes_divulgacao.slot3="artigo-especial-apoiadores.md"` +
`boxes_divulgacao_auto.pinned_slots` ganha `3`, idempotente).

**`platform.config.json` é git — abrir PR:**

```bash
git checkout -b artigo-especial/{ano}-{slug}
git add platform.config.json
git commit -m "chore(#5979): pin box Artigo Especial slot 3 — {ano}-{slug}"
gh pr create --title "chore(#5979): pin box Artigo Especial — {título curto}" \
  --body "Pin do box \"Artigo Especial\" no slot 3 para o artigo {ano}/{slug}. Skill /diaria-artigo-especial."
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
  removendo `3` de `pinned_slots` sem tocar `boxes_divulgacao.slot3` (ver
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
  apoiase.md                  teaser publico (Passo 1)
  linkedin-pagina.md          post pagina diar.ia.br (Passo 1)
  linkedin-perfil.md          post perfil pessoal (Passo 1)
  published.json              status agregado por canal — apoiase/linkedin_pagina/linkedin_perfil/box (Passo 0 guard, atualizado nos Passos 3-5)
  linkedin-published.json     detalhe do dispatch LinkedIn (worker_queue_key, route, scheduled_at — Passo 4)
```

`platform.config.json` (`boxes_divulgacao.slot3` + `pinned_slots`) e
`data/snippets/artigo-especial-apoiadores.md` — ver Passo 5.
