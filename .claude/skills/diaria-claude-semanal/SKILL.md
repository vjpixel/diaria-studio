---
name: diaria-claude-semanal
description: E-mail semanal "Claude na semana" (#14329) para quem ASSINA o Claude tirar o máximo da ferramenta — coleta as atualizações OFICIAIS da semana (Anthropic News, blog do Claude, release notes dos apps e da plataforma, releases do Claude Code, Engineering, Academy), escreve de 8 a 15 itens com resumo + "como usar" (agente `claude-semanal-writer`, humanizador, Clarice), valida (fonte oficial, dedup entre semanas, volume, cópia), mostra a prévia com a contagem da tag e o horário num gate, e só com a aprovação do editor agenda o broadcast Kit (não público) para domingo 08:00 BRT. Fase de teste só com o Núcleo; público em `platform.config.json` → `kit_claude_semanal`. Nunca pula semana. Uso — `/diaria-claude-semanal [AAMMDD-do-domingo]`.
disable-model-invocation: true
---

# /diaria-claude-semanal

E-mail semanal com as atualizações do Claude, escrito para quem assina (Pro/Max,
apps web, desktop e mobile, Claude Code) e quer tirar o máximo da ferramenta.
Critério de entrada de cada item: **isso muda o que um assinante consegue fazer
com o Claude?** Decisões do editor em 27/11/2026 (#14329):

- **Público:** fase de teste só com o Núcleo (`patrono`). O público definitivo
  ainda não foi decidido e é config, não código:
  `platform.config.json` → `kit_claude_semanal.audience_niveis` /
  `audience_tag` (+ `preview_text`, `footer_note`). Trocar o público é editar o
  config e rodar o sync da tag (Passo 5).
- **Fontes:** só oficiais da Anthropic/Claude, nada de comunidade ou terceiros
  (`isOfficialClaudeUrl` em `scripts/lib/claude-semanal.ts` barra o resto).
- **Formato:** resumo de 2 a 3 frases + uma linha "como usar" por item, nas
  seções Lançamentos, No dia a dia, Claude Code e Aprenda.
- **Rotina própria,** fora do `/diaria-pacote-semanal`.
- **Nunca pula semana.** Semana fraca completa com No dia a dia, Claude Code e
  Aprenda e, se faltar, amplia a coleta nas fontes oficiais. O gate não tem
  opção de pular.

Peças: `scripts/claude-semanal-collect.ts` (coleta), `.claude/agents/claude-semanal-writer.md`
(escrita), `scripts/publish-claude-semanal-kit.ts` (validação, prévia e envio),
`scripts/sync-apoio-claude-semanal-tag-kit.ts` (audiência), lógica pura em
`scripts/lib/claude-semanal.ts`, estado em `data/claude-semanal/{AAMMDD}/`.

## Argumentos

- `AAMMDD` (opcional) — o **dia do envio** (default domingo, `send_weekday`).
  Omitido: `npx tsx scripts/claude-semanal-collect.ts --resolve-week` devolve o
  próximo domingo (hoje incluído); imprimir o banner
  `Data não informada — assumindo {AAMMDD} (próximo domingo). Passe AAMMDD explicitamente para outra semana.`
  e seguir, sem perguntar. Data que não cai no dia de envio configurado é
  recusada pelos scripts (exit 2).

A janela de coleta são os 7 dias anteriores ao envio mais o próprio dia (8
dias, de domingo a domingo). A sobreposição de um dia com a semana anterior é
de propósito; o dedup impede que um item saia duas vezes.

## Guard de execução

- O Passo 7 (agendamento) só roda com a aprovação do editor no gate do Passo 6
  NESTA invocação. Nunca rodar o Passo 7 dentro de `/diaria-overnight`,
  `/diaria-continuo` ou `/diaria-develop`: rodadas autônomas podem mexer no
  código desta skill, nunca agendar o envio.
- Passos 1 a 4 só leem fontes oficiais e gravam arquivos locais em
  `data/claude-semanal/{AAMMDD}/`. O Passo 5 escreve no Kit (membresia da tag) e
  lê a tag; o Passo 7 cria o broadcast.
- Tag inexistente ou vazia **recusa** o envio (exit 2 do publicador) e nunca
  cai na base inteira (#6126). O broadcast é relido depois de criado para
  conferir filtro, agendamento e `public: false` (#6582); sem as três
  confirmações ele é apagado.

## Passo 1 — Coleta

1. `npx tsx scripts/claude-semanal-collect.ts --week {AAMMDD}` — lê os feeds
   oficiais (`kind: "rss"` em `kit_claude_semanal.sources`), filtra pela janela,
   por fonte oficial e pelo dedup contra os envios anteriores, e grava
   `data/claude-semanal/{AAMMDD}/_internal/01-candidates.json`. A saída lista
   `pages_to_fetch`: as fontes sem feed (e as de feed que falhou).
2. Para cada página de `pages_to_fetch`, ler com WebFetch e extrair os itens
   **publicados ou atualizados dentro da janela** (`window` do JSON), com a URL
   oficial de cada um, título, data (`published_at` ISO) e um resumo curto do
   que a página diz. A URL é a do post; numa página de release notes (uma URL
   para todas as entradas) é a da página **com fragmento por entrada**: a
   âncora da entrada se a página tiver, senão `#AAAA-MM-DD` da data dela. O
   fragmento é a chave do dedup entre semanas (`normalizeClaudeSemanalUrl`):
   sem ele, a 1ª entrada enviada marcaria a página inteira como "já enviada".
   Release notes de API e Agent SDK: só o que chega ao assinante. Releases do
   Claude Code: o feed traz o resumo truncado; ler a página do release (ou
   `https://code.claude.com/docs/en/changelog`) e passar o texto completo no
   `summary` do candidato, para o writer fazer um item por mudança relevante
   (nunca um por versão). Gravar a lista num arquivo do scratchpad com o número
   da issue e sufixo aleatório (ex.: `paginas-14329-{random}.json`) e mesclar:
   `npx tsx scripts/claude-semanal-collect.ts --week {AAMMDD} --merge {arquivo}`.
   O merge passa pelos mesmos filtros (item sem data, fora da janela, não
   oficial ou já enviado fica de fora, listado em `rejected`/`already_sent`).
3. Imprimir um resumo: candidatos por fonte, já enviados, rejeitados.

## Passo 2 — Volume: nunca pular semana

Se `volume.kind` for `abaixo` (menos de `min_items`, default 8), ampliar a
coleta **dentro das fontes oficiais**: artigos novos ou atualizados da central
de ajuda (`support.claude.com`), páginas de boas práticas e guias de
`docs.claude.com`/`code.claude.com`, cursos da Academy, cookbooks da
organização `anthropics` no GitHub. Mesclar com `--merge` e repetir até chegar
ao mínimo. Não existe saída "sem e-mail esta semana": se mesmo assim faltar, o
writer escreve os que houver, e o gate mostra o volume abaixo do mínimo para o
editor decidir o que acrescentar (nunca se ele quer pular).

## Passo 3 — Escrita (agente `claude-semanal-writer`)

```
Agent(subagent_type: "claude-semanal-writer",
      prompt: "Insumo: {abs}/data/claude-semanal/{AAMMDD}/_internal/01-candidates.json. Grave o rascunho em {abs}/data/claude-semanal/{AAMMDD}/_internal/02-draft.json.")
```

Se o rascunho já existe (rodada anterior ou ajuste do editor), dizer isso no
prompt para o agente preservar o que estiver bom. Resposta com `FALTAM: N`:
voltar ao Passo 2 com a dica do agente e chamá-lo de novo.

## Passo 4 — Humanizador e Clarice

Igual à diária, sobre `02-draft.json` ({D}):

1. Humanizador, passe completo:
   Skill("humanizador", "Leia {D}, humanize SÓ os campos intro, subject_options, subject e, em cada item de sections[].items, title, resumo e como_usar (passe completo), e salve no mesmo arquivo sem tocar week, id nem url. Tetos: subject e cada subject_option até 52 caracteres; intro 320; title 120; resumo 2 a 3 frases e 480 caracteres; como_usar uma linha e 220 caracteres. Sem markdown, sem URL, sem emoji, sem seta, sem bajulação. Nomes de produto e de recurso ficam como estão.")
2. Clarice: `mcp__clarice__correct_text` sobre a intro, o assunto e o resumo e
   o "como usar" de cada item; filtrar com
   `npx tsx scripts/clarice-filter.ts --suggestions {S}.json --out {S}-filtrado.json`
   (#11798), aplicar as filtradas (aceitar as sugestões da Clarice é o padrão do
   projeto) e regravar {D}. Clarice indisponível = halt banner (#738), nunca
   seguir em silêncio.

## Passo 5 — Audiência e prévia

1. Audiência (projeção do `apoio_nivel`, escrita no Kit só da tag):
   ```
   npx tsx scripts/sync-apoio-nivel-kit.ts --push               # se ainda não rodou nesta semana
   npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts          # dry-run: quem entra/sai da tag
   npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts --push   # aplica
   ```
   O 1º `--push` é quem cria a tag `claude-semanal`. Blast radius bloqueado
   (exit 1) = parar e mostrar ao editor; `--force-blast-radius` só com a
   decisão dele.
2. Validação + prévia + contagem real:
   `npx tsx scripts/publish-claude-semanal-kit.ts --week {AAMMDD} --check-audience`
   (só GET no Kit). Grava a prévia em `_internal/claude-semanal-preview.html` e
   `.txt` e devolve `problems`, `audienceMemberCount`, `sendAt` e `late`. Exit 2
   com tag vazia ou inexistente: voltar ao item 1, nunca seguir.
3. Cada item de `problems` é consertado no rascunho (fonte não oficial ou item
   já enviado: trocar pelo próximo candidato; teto de caracteres: reescrever,
   nunca truncar; seta/markdown/URL no texto: tirar) e o item 2 roda de novo,
   até `problems` vir vazio. Volume abaixo do mínimo é o único problema que pode
   chegar ao gate, e só depois do Passo 2 esgotado.
4. Publicar a prévia como Artifact privado (`Artifact(file_path: "{abs do HTML}",
   title: "Claude na semana {AAMMDD}", description: "Prévia do e-mail semanal do Claude", icon: "news")`;
   na 2ª rodada da mesma semana, republicar no mesmo arquivo). Sem a ferramenta
   (sessão sem Artifact): mostrar o `.txt` no chat.

## Passo 6 — Gate do editor

Uma `AskUserQuestion` só, com a prévia (link do Artifact), o assunto, as 3
opções de assunto, o total de itens por seção, a audiência (`tag`,
`audienceMemberCount` membros) e o horário (`sendAt` em BRT; `late: true` =
o horário configurado já passou e o envio sai daqui a pouco). Opções:

- **Aprovar e agendar** — segue para o Passo 7.
- **Trocar o assunto** — o editor escolhe outra opção (ou escreve uma); gravar
  em `subject`, refazer o Passo 5 item 2 e voltar ao gate.
- **Ajustar** — o editor diz o que mudar (tirar/trocar item, reescrever);
  aplicar no rascunho (ou chamar o writer de novo com o pedido), refazer o
  Passo 5 item 2 e voltar ao gate.

Não há opção de pular a semana nem de não enviar (decisão do editor, #14329).
Falha do `AskUserQuestion` = halt banner (#3938).

## Passo 7 — Agendamento

`npx tsx scripts/publish-claude-semanal-kit.ts --week {AAMMDD} --send`

Cria o broadcast agendado para `sendAt`, com a tag como filtro e
`public: false`, relê e confere, e grava
`_internal/claude-semanal-published.json` com os itens (é dele que o dedup das
semanas seguintes lê). Até `sendAt` o envio é cancelável no painel do Kit.

| Saída | O que fazer |
|---|---|
| `exit 0`, `kind: "enviado"` | informar o editor: broadcast id, horário BRT, membros da tag |
| `exit 0`, `kind: "ja-enviado"` | a semana já estava agendada; informar o id e o horário |
| `exit 2` (guard) | nada foi criado: mostrar a mensagem, corrigir e rodar de novo |
| `exit 1` (incidente) | um broadcast PODE existir no Kit: mostrar a mensagem inteira ao editor e não reexecutar; `--force` só depois de ele conferir o Kit |

## Fora de escopo

- Task agendada: esta skill roda à mão. Se virar task depois, entra em
  `scripts/lib/scheduled-tasks.ts` e `docs/scheduled-tasks-registry.md`.
- Comunicação do benefício (apoia.se, página de apoio): fica para depois da
  decisão do público definitivo.
