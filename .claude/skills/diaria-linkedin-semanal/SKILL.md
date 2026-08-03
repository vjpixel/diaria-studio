---
name: diaria-linkedin-semanal
description: Newsletter semanal do LinkedIn (perfil pessoal, #4456) — 3 matérias da semana selecionadas por clique verificado + bloco Use Melhor com comentário do editor + lista do resto da semana. Produzida domingo, publicada segunda ~09:30 BRT (artigo colado à mão — LinkedIn não tem API de publicação de newsletter). Uso — `/diaria-linkedin-semanal --publish-monday AAMMDD`.
disable-model-invocation: true
---

# /diaria-linkedin-semanal

Monta o artefato colável da newsletter semanal do LinkedIn (issue #4456):
3 matérias da semana que acabou (segunda a sexta), selecionadas por **taxa
de clique verificado** — não pela posição na edição de origem — mais o
bloco **Use Melhor** (com comentário do editor, obrigatório) e uma lista de
1 linha por edição das demais.

**A spec desta skill mudou várias vezes ao longo do dia 260802 — os
comentários da issue #4456 têm precedência sobre o corpo original.** Se
você (ou um agente futuro) for alterar este arquivo, releia a issue
inteira antes — não só o body.

## Decisões do editor já tomadas (não são desta skill pra revisitar)

- **Canal: newsletter nativa do LinkedIn** (perfil pessoal do editor, não a
  Page) — diferente de `/diaria-instagram-semanal` (post de feed, só
  Instagram desde #4483, sábado, com ranking por clique restrito a
  D1/D2/D3). As duas skills seguem **separadas** (ver "Sobreposição"
  abaixo) — não fundir, não renomear esta.
- **Seleção: por clique verificado, não por manchete.** A regra antiga
  "só DESTAQUE 1" foi substituída em 260802 — matéria secundária, item de
  Radar ou entrada de Use Melhor são candidatos legítimos quando o clique
  justificar. Ver `scripts/lib/weekly-linkedin-select.ts`.
- **Sem link por destaque.** O texto lifted já É o conteúdo completo — um
  link de volta pra edição de origem prometeria mais do que existe. A
  seção "ATERRISSAGEM" que existiu numa versão intermediária da spec foi
  **removida**.
- **Título literal + numeração.** Nunca reescrever o título do bloco de
  origem — só prefixar "1.", "2.", "3.".
- **Use Melhor é obrigatório, mas só COM comentário do editor.** Sem
  comentário honesto, o bloco inteiro sai da edição — nunca gerado
  automaticamente (`renderLinkedinWeeklyHtml` em
  `scripts/lib/weekly-linkedin-render.ts` faz isso mecanicamente).
- **Edição #1 não é mais exceção** (260802, último comentário) — cobre a
  janela normal como qualquer outra. Não tratar a primeira invocação
  desta skill como recorte mensal/moldura de estreia.

## Argumentos

- `--publish-monday AAMMDD` — **obrigatório e explícito** (mesmo invariante
  de `CLAUDE.md`: nunca inferir de `today()`). É o AAMMDD da SEGUNDA em que
  o artigo será publicado — a janela de conteúdo (segunda a sexta) é
  resolvida automaticamente como a semana ANTERIOR a essa data
  (`resolveWeeklyLinkedinCycle` em `scripts/lib/weekly-linkedin-cycle.ts`).
  Se omitido, pergunte ao editor com a próxima segunda como sugestão —
  nunca assuma silenciosamente.

O **ciclo** (`{YY}w{WW}`, ex: `26w31`) é derivado da semana de CONTEÚDO
(não da segunda de publicação) e usado como namespace de diretório
(`data/weekly/{cycle}/`) e como `utm_campaign` (`ln-{cycle}`).

## Pré-requisitos

- As edições da semana (segunda a sexta) precisam ter
  `data/editions/{AAMMDD}/02-reviewed.md` no disco — mesmo risco de
  retenção documentado em `/diaria-instagram-semanal` (se
  `data/editions/{AAMMDD}/` for arquivado antes de rodar esta skill, essa
  edição não pode ser recuperada pro cálculo).
- `data/beehiiv-cache/posts/*.json` — populado por `scripts/beehiiv-sync.ts`
  (roda automaticamente no Stage 0 de cada edição diária). Não precisa
  rodar manualmente, mas o Passo 1 abaixo checa se falta enriquecimento de
  clicks pros posts da janela.

## Passo 1 — Checar se falta enriquecimento de clicks

```bash
npx tsx scripts/select-linkedin-weekly.ts --publish-monday {AAMMDD} --manifest-only
```

Imprime `{cycle, contentWindow, editionsFound, posts_needing_clicks}`.
**Por que este passo existe:** o gate de estabilização de CTR do pipeline
diário (`MIN_AGE_DAYS_FOR_CLICKS = 7`, `scripts/lib/shared/ctr-config.ts`)
NUNCA enriquece posts com menos de 7 dias — e os posts desta janela têm
entre 2 e 6 dias no momento em que esta skill roda (domingo, semana que
acabou de terminar). Sem este passo explícito, a seleção rodaria com
clicks zerados pra toda a semana.

Se `posts_needing_clicks` for não-vazio:

```
Agent(subagent_type="beehiiv-clicks-enricher", prompt=<manifest items uma por linha>)
```

Mesmo agent reusado do Stage 0 diário (0h.2) — cada item do prompt no
formato `post_id=<id> title=<title>`, um por linha. **Não reinventar** um
enricher próprio — MCP `list_post_clicks` só roda de subagent/top-level
com a tool declarada, nunca de script TS standalone (ver docstring de
`scripts/lib/weekly-linkedin-clicks.ts`).

Se `posts_needing_clicks` já vier vazio (todos os posts da semana já
enriquecidos — ex: alguém já rodou o Stage 0 de uma edição posterior que
puxou esses posts pro gate normal), pule direto pro Passo 2.

## Passo 2 — Rodar a seleção de verdade

```bash
npx tsx scripts/select-linkedin-weekly.ts --publish-monday {AAMMDD}
```

Escreve `data/weekly/{cycle}/_internal/ln-selection.json` com: manchetes
selecionadas (rank + auditoria completa dos candidatos, inclusive
excluídos por serem comercial/próprio), candidato de Use Melhor, lista do
resto da semana, e warnings (empates dentro do ruído de 1 clique, edições
faltando, etc — ver `scripts/lib/weekly-linkedin-select.ts`).

**Semana curta (feriado):** se `editionsFound < 5`, o script já reduz o
número de manchetes automaticamente (`computeHeadlineCap`) — nunca puxa
conteúdo da semana anterior pra completar 3. Se `editionsFound === 0`, o
script aborta (exit 1) — reporte ao editor em vez de prosseguir.

## Passo 3 — Gate humano: apresentar seleção + pedir texto novo

Mostrar ao editor:

```
📰 LinkedIn semanal — ciclo {cycle} (segunda {AAMMDD})

Manchetes selecionadas (por taxa de clique verificado):
  1. [{taxa}%] {título} ({edição de origem}, {seção})
  2. ...
  3. ...

Use Melhor: {título ou "nenhum candidato elegível"}

Resto da semana: {N} edições

{warnings, se houver — inclusive empates dentro do ruído de 1 clique}

Aprovar seleção? sim / trocar {N} por outro candidato / abortar
```

Se aprovado, pedir ao editor (nunca gerar sozinho):
1. **Comentário do Use Melhor** (1-3 frases, honesto — se o editor não
   tiver nada de verdade pra dizer, o bloco sai da edição, não force).
2. **Abertura** (1 parágrafo curto identidade+promessa+cadência).
3. **Fecho** (1 parágrafo curto antes do CTA final).

Mesmo padrão do corpo original da issue ("a skill NUNCA gera esse
comentário, ela pergunta e espera resposta") — vale pros 3 textos novos,
não só o comentário do Use Melhor.

## Passo 4 — Humanizador + Clarice (só no texto NOVO)

**Regra do #4456: bloco levantado (manchetes) NÃO passa por humanizador
nem Clarice — só o texto novo (abertura, fecho, comentário do Use
Melhor).** O texto já foi revisado pelo editor e pela Clarice na edição
diária de origem; reprocessar reintroduziria risco factual e deriva de
voz sem ganho (mesma lógica do corpo original da issue, "Montagem —
levantar literal").

Para cada um dos 3 textos novos (abertura, fecho, comentário Use Melhor):

```
Skill("humanizador", "Humanize este texto em português, mantendo o
sentido: <texto>")
```

Depois:

```
mcp__clarice__correct_text(<texto humanizado>)
```

Aplique as sugestões da Clarice manualmente (texto curto — não precisa de
`clarice-apply.ts`). Guarde o resultado final dos 3 textos pro Passo 5.

## Passo 5 — Renderizar o artefato final

```bash
npx tsx scripts/render-linkedin-weekly.ts --cycle {cycle} \
  --opening "{abertura humanizada}" \
  --closing "{fecho humanizado}" \
  --use-melhor-comment "{comentário humanizado, ou omitir a flag inteira se o editor não deu comentário}"
```

(`--opening-file`/`--closing-file`/`--use-melhor-comment-file` aceitam
texto longo via arquivo, mesmo padrão de outros scripts do repo.)

Escreve `data/weekly/{cycle}/ln-{cycle}.html` (fragmento HTML colável —
sem `<html>`/`<body>`, é o payload que vai no `text/html` do
`ClipboardEvent`, ver `context/publishers/linkedin.md` §Newsletter
LinkedIn) e `data/weekly/{cycle}/ln-{cycle}.json` (metadados + warnings).

Se `--use-melhor-comment` foi omitido (ou vazio), o bloco Use Melhor sai
inteiro do HTML — mecânico, não pergunte de novo, já foi perguntado no
Passo 3.

## Passo 6 — Entregar o artefato ao editor

Publique `ln-{cycle}.html` como Artifact (padrão do repo: entregas vão
como artefato aberto no browser, não `.md`/arquivo solto) pro editor
revisar e copiar. Inclua no artifact (ou na mensagem) as instruções de
publicação de `context/publishers/linkedin.md` §Newsletter LinkedIn —
resumo:

1. Ir em `linkedin.com/newsletters/{urn}/` (a página DA newsletter, não
   o feed pessoal) → clicar **Write article** DALI (não em
   `/article/new/` direto — senão o artigo nasce desvinculado e o convite
   automático pra rede não dispara).
2. Confirmar que o cabeçalho do editor mostra o nome da newsletter, não
   "Individual article".
3. Colar o conteúdo de `ln-{cycle}.html`.
4. Revisar visualmente (numeração, sem link nos blocos de manchete, Use
   Melhor com comentário se presente, CTAs no fim).
5. Publicar.

**Sem gate de agendamento automático** — ver "Reuso do agendamento"
abaixo pra por quê.

## Reuso do agendamento — decisão: NÃO reusar `/diaria-6-agendamento`

`/diaria-6-agendamento` (`.claude/skills/diaria-6-agendamento/SKILL.md`)
existe pra agendar o ENVIO da newsletter diária no **Beehiiv** — chama a
API/UI do Beehiiv via Claude in Chrome (`context/publishers/beehiiv-playbook.md`
§9-10) e verifica o estado agendado via `scripts/verify-scheduled-post.ts`.

Isso não se aplica aqui: **o LinkedIn não tem API de agendamento de
newsletter** (só de posts de feed comuns, que é o mecanismo que
`context/publishers/linkedin.md` §1-8 já cobre pro Stage 6 social da
diária). O artigo da newsletter do LinkedIn só nasce por ação humana
direta no editor (`linkedin.com/newsletters/{urn}/` → Write article →
Publish) — não existe "rascunho agendável programaticamente" nesse fluxo,
então não há nada mecânico de `/diaria-6-agendamento` (o Schedule
click-e-verifica do Beehiiv) que faça sentido reusar aqui. O único
padrão que ESTA skill reusa do Stage 6 é conceitual — gate humano antes
de considerar a unidade "pronta" — não código.

## Sobreposição com `/diaria-instagram-semanal` — mantenha separadas

| | `/diaria-instagram-semanal` | `/diaria-linkedin-semanal` |
|---|---|---|
| Seleção | itens mais clicados (D1/D2/D3; RADAR/USE MELHOR ainda não competem — limitação técnica de asset, não decisão de escopo, ver #4513) | 3 matérias por taxa de clique (D1/D2/D3/RADAR/USE MELHOR) |
| Cadência | produz sexta, publica sábado | produz domingo, publica segunda |
| Canal | post social (só Instagram, desde #4483) | newsletter nativa do LinkedIn (perfil pessoal) |
| Formato | 5 itens curtos, carrossel de imagens | 3 blocos longos + Use Melhor + lista |
| Entrega | feed, ranqueado pelo algoritmo | notificação + e-mail, fora do feed |

Decisão do editor (comentário 260802 do #4456): **produtos diferentes,
seguem separados.** `/diaria-semanal` foi renomeada pra
`/diaria-instagram-semanal` e restrita a Instagram pelo #4483 (260803) —
`.claude/skills/diaria-instagram-semanal/` é a skill atual, não mexer nela
daqui.

## Casos de borda

- **0 edições na janela:** `select-linkedin-weekly.ts` aborta (exit 1) —
  reporte ao editor, não prossiga pra render.
- **Menos de 3 edições (feriado):** reduz o nº de manchetes
  automaticamente — nunca puxa da semana anterior.
- **Nenhum candidato Use Melhor elegível na semana:** `useMelhor` sai
  `null` no JSON — o Passo 3 não pergunta comentário (não há bloco).
- **Empate dentro do ruído de 1 clique:** o script já resolve via
  critério editorial (ângulo Brasil > implicação profissional >
  diversidade de categoria) e registra em `warnings` — mostre esse
  warning ao editor no gate do Passo 3, é informação relevante mesmo já
  resolvida mecanicamente.

## Outputs

```
data/weekly/{cycle}/
  _internal/ln-selection.json   seleção completa + auditoria (Passo 2)
  ln-{cycle}.html                artefato colável (Passo 5)
  ln-{cycle}.json                 metadados do render (Passo 5)
```
