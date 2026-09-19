# Hubs temáticos GEO — sem grupo de controle (decisão do editor, 10/08/2026)

Registro da decisão citada no #4905 (Refs #4558). Não é runbook — é o mesmo
tipo de "nota de fato apurado" que `docs/seo-notes.md` mantém pra dado de SEO,
aqui aplicado à leitura do checkpoint de citação por assistente de ~07/out.

## Decisão de 18/09/2026 — produção de hub NOVO está pausada

**Decisão do editor, 18/09/2026, na auditoria de GEO desta data: "vamos parar
de criar hubs novos por enquanto."** Vale a partir daqui e até o editor
reabrir — não tem data de retorno marcada.

**O que a pausa cobre:** criar hub temático novo (módulo em
`scripts/lib/hubs/{slug}.ts` + entrada em `HUB_LOADERS`/`HUB_META` + asset
`.generated.ts`). Os hubs já publicados continuam **em manutenção normal** —
`Diaria-Hub-Staleness-Check`, `Diaria-Hub-Drift-Check`, correção de número
errado, regeneração após mudança de renderer. Pausa é sobre acervo NOVO, não
sobre deixar o que existe apodrecer.

> **Uma exceção foi aberta desde então:** a página `deepfake` (#8391,
> 19/09/2026), por dado de DEMANDA de busca — eixo que esta pausa não
> considerou. Ela é ÚNICA e não reabre a produção; ver a seção "Exceção
> ÚNICA de 19/09/2026" logo abaixo antes de decidir qualquer coisa a partir
> deste parágrafo. Por causa dela os hubs publicados passaram de 7 para 8 —
> as contagens "7 hubs"/"9 URLs" no restante desta seção descrevem o estado
> em 18/09/2026, que é o estado sobre o qual a medição do 0/177 foi feita.

**O dado que motivou** (auditoria de 18/09/2026, sobre
`data/geo-citations/history.jsonl`, 493 registros de 07/08 a 13/09):

- Painel `hubs`: **0 citações em 177 respostas válidas** (267 registros, 90
  erros), distribuídas em 6 datas de rodada — 11/08, 16/08, 23/08, 30/08,
  06/09 e 13/09. As duas primeiras rodaram incompletas (11/08 sem
  `anthropic`, 16/08 sem `google`); os 3 provedores só aparecem juntos a
  partir de 23/08. Painel `geral`, na mesma janela: 9/134 (6,7%).
- Duas das cinco explicações concorrentes pré-registradas abaixo **caíram —
  mas só valem para a ponta recente da janela**, e essa ressalva é parte do
  registro:
  - Descoberta (item 2): os bots de recuperação batem no `arquivo`
    diariamente — 11 a 17 fetches/dia entre 13 e 17/09, lidos **ao vivo do
    KV** em 18/09 (`ai-fetch-report.ts --days 7 --dry-run`). O JSONL
    commitado (`data/ai-fetch/history.jsonl`) está parado em 18/08 e não
    serve pra conferir isso — é exatamente o achado E4 da auditoria (o
    script não tem task agendada). O contador é por `(bot, dia)` no Worker
    inteiro, sem path: prova que o `arquivo` é buscado, não que cada um dos
    7 hubs foi.
  - Indexação (item 5): as 9 URLs do `arquivo` — home, índice `/temas/` e
    os 7 hubs — estão indexadas no GSC. Mas a série mostra 2/9 em 12 e
    16/08, 8/9 em 30/08 e 9/9 só a partir de 06/09; **as 3 primeiras
    rodadas do painel `hubs` aconteceram com a maioria dos hubs ainda fora
    do índice**. Uma fração do 0/177 agregado vem de um período em que esta
    explicação ainda era plenamente válida.
- Restam de pé a de demanda em pt-BR (item 3) e a da própria tese no volume
  atual de acervo (item 4) — e é entre essas duas que a pausa escolhe parar
  de gastar esforço editorial antes de saber qual é. A pausa é reversível
  justamente porque a janela limpa (3 provedores × 9 URLs indexadas) tem só
  as rodadas de 06/09 e 13/09.

**O que esta decisão NÃO é:** não é veredito sobre a tese GEO, e não
transforma o 0/177 em prova de nada — a seção "O que o checkpoint PODE e NÃO
PODE concluir" abaixo continua valendo inteira, inclusive a proibição de ler
snapshot como resultado causal. A série semanal segue rodando sem data de
corte; o que parou foi a produção, não a medição.

**Como reabrir:** decisão explícita do editor, como esta. O sinal natural pra
reavaliar é o painel `geral` ou o painel `acervo` (#8334) mostrarem que
citação acontece e de onde ela vem — aí a pergunta "hub ajuda?" volta a ter
contraste pra ser respondida.

## Exceção ÚNICA de 19/09/2026 — a página `deepfake` (#8391)

**Decisão do editor, 19/09/2026, resposta literal "8391: a e c": está
autorizada UMA página perene sobre deepfake, no molde dos hubs existentes.
A pausa registrada acima continua valendo para qualquer outro tema.** Uma
segunda exceção exige nova decisão explícita do editor. Este parágrafo é o
registro canônico dela — quem ler a pausa acima e encontrar
`scripts/lib/hubs/deepfake.ts` no repo deve ler esta seção antes de concluir
que a produção de hubs reabriu (não reabriu) ou que o hub foi criado
irregularmente (não foi).

**O motivo, e por que ele não contradiz a pausa:** a pausa de 18/09 foi
motivada por dado de **citação por assistente** (painel `hubs`, 0/177). A
exceção é motivada por dado de **demanda de busca** — o Google Ads Keyword
Planner (Brasil/pt) mede `deepfake` em **33.100 buscas/mês com competição
LOW**, a melhor relação volume×alcançabilidade da auditoria. Esse eixo não
entrou na deliberação da pausa porque o dado ainda não existia: o Keyword
Planner só foi acessado horas depois. Duas perguntas diferentes, duas
respostas diferentes — a pausa segue de pé para o eixo que ela mediu.

**O que a página é, para não ser lida como mais um hub temático:** é escrita
PARA O TERMO. `<title>`, `<h1>`, `introHeading`, os headings de seção e o
FAQ usam o fraseado de busca ("deepfake", "o que é deepfake", "como
identificar deepfake"), não o fraseado de manchete que os 7 hubs anteriores
usam ("O que aconteceu com X desde Y?"). A infraestrutura é a mesma —
mesmo renderer, mesmo JSON-LD, mesmo `<lastmod>`, mesma entrada no sitemap
do `arquivo`, mesmo IndexNow no deploy; nada de superfície nova.

**Critério pré-registrado (escrito antes da medição, #8391):**

- Medir na primeira rodada de `Diaria-SEO-Weekly` **8 semanas após a página
  entrar no índice** — não após publicar; a série do `arquivo` mostra 2–3
  semanas de defasagem, e `especial`/`arquivo` já estão na checagem de
  indexação desde o #8343.
- **Funcionou:** impressões em consultas contendo "deepfake" **e** alguma em
  posição ≤20.
- **Não funcionou:** indexada e ~0 impressão, como o resto do acervo.
- Resultado intermediário fica registrado como intermediário.
- É também o teste limpo da tese "cobrir o que tem volume faz aparecer": se
  não funcionar com 33k/LOW e material próprio, o resultado pesa contra
  estender a lógica a outros temas — e a favor da opção B do #8350.

**O painel GEO não é o critério desta página.** As duas perguntas de
deepfake acrescentadas a `GEO_HUB_QUESTIONS` existem só para satisfazer o
guard de cobertura por hub (`test/geo-hub-questions-cobrem-hubs-4900.test.ts`)
e manter a série do painel `hubs` homogênea. Ler o resultado delas como
veredito sobre a #8391 seria trocar o critério depois da medição.

**Limitação conhecida, registrada para não ser reaberta como achado novo:**
o comentário de decisão pedia puxar as variantes e volumes do termo no
Keyword Planner antes de escrever. O #8366 está bloqueado — o MCP do Google
Ads não conecta na máquina onde a página foi escrita (`pipx` ausente) e ligar
o Keyword Planner é tarefa de sessão `develop`. O fraseado usa o único
volume MEDIDO que existe (o termo-raiz) mais as variantes de pergunta que o
próprio corpus sustenta; nenhum volume por variante foi inventado. Refinar o
fraseado com os volumes finos continua em aberto e depende da #8366.

## A decisão

Até 10/08/2026 havia a opção de tratar `anthropic-claude` como hub "tratado"
e manter `openai-chatgpt`/`google-gemini` congelados como grupo de controle
até o checkpoint. **O editor decidiu, em 10/08/2026, que todas as regras
desta auditoria GEO valem para os hubs existentes — `anthropic-claude`,
`openai-chatgpt`, `google-gemini` — e para qualquer hub futuro.** Não há
grupo de controle, e não vai haver.

**Achado da Fase 1.5 (rodada overnight 260811):** `meta-ai`, o 4º hub, já
existia no repo desde as 14:40 de 10/08/2026 (commit `19ca96a0`) — antes
até do `base_sha` desta rodada — quando este documento foi escrito às
23:27 do mesmo dia. Não é "hub futuro": já era hub presente, e a decisão
do editor o cobre pela mesma cláusula "e para qualquer hub futuro" (que
por definição inclui qualquer hub que já não fosse um dos 3 nomeados
explicitamente). O motivo estrutural da seção seguinte (renderer/lint
compartilhados) já se aplicava a ele desde que nasceu. Referências a "3
hubs" abaixo refletem a contagem no momento da decisão original — a
decisão em si vale para os 4.

Consequência direta: nada no corpus de hubs fica congelado como referência.
Qualquer achado da auditoria (prosa, FAQ, JSON-LD, sitemap, etc.) se aplica
igualmente a todos eles.

## O que isso já não permitiria medir, mesmo antes da decisão

O motivo estrutural é anterior à decisão do editor e não depende dela: os 3
hubs são gerados pelo mesmo renderer compartilhado, então uma mudança nele
sempre atingiu os três no mesmo commit, por construção.

- `renderHubPage` / `renderHubBodyStyles` em `scripts/lib/shared/hub-page.ts`
  — layout e CSS do corpo do hub, comuns aos 3.
- `scripts/lib/shared/geo-faq.ts` — bloco de FAQ + JSON-LD FAQPage/Article,
  também usado por livros/cursos/arquivo.
- `scripts/lib/shared/seo-meta.ts` — meta tags SEO, também usado por
  livros/cursos/arquivo/workers/poll.
- `scripts/lib/shared/markdown-links.ts` — parser de link inline, também
  usado por livros/cursos/arquivo.
- `renderGeneratedModule` (`scripts/build-hub-page.ts`) — gera o asset
  committed (`workers/arquivo/src/hubs/{slug}.generated.ts`) a partir do
  loader de cada hub, registrados em `HUB_LOADERS` (mesmo arquivo).

O caso mais duro é o lint que **lança**: `validateHubContent`
(`scripts/lib/shared/hub-page.ts`) é chamado dentro de `renderHubPage` e
qualquer violação vira `throw` — uma regra nova ali quebra o build dos 3
hubs de uma vez. Ou a regra entra pros 3, ou não entra pra nenhum; não há
meio-termo possível dentro da arquitetura atual. `geo-faq.ts` e
`markdown-links.ts` também servem livros/cursos/arquivo, e `seo-meta.ts`
serve esses quatro mais workers/poll — motivo a mais pra regra compartilhada
nunca ter sido diferenciável por hub.

A decisão de 10/08 estendeu à **prosa** (o texto escrito à mão em
`scripts/lib/hubs/{slug}.ts`) o que a arquitetura do renderer já impunha ao
**layout/estrutura**. Antes da decisão, só a prosa ainda podia divergir
entre hubs; agora nem essa divergência é objetivo do projeto.

## Consequência operacional imediata

Mudança de prosa que antes ia pra 1 hub agora vale pros 3 — e o artefato
derivado precisa ser regenerado nos 3 ou o CI reprova:

```
npx tsx scripts/build-hub-page.ts --all
```

Sem isso, `test/hub-page-drift.test.ts` (que itera `HUB_LOADERS` e compara
cada asset committed contra um render fresco) reprova no primeiro hub que
ficar desatualizado. A #4897 já documentou esse esquecimento acontecendo 3×
numa única sessão, um hub por vez, antes desta decisão — com a regra valendo
pros 3 ao mesmo tempo, a chance de esquecer ao menos um sobe.

## O que o checkpoint de ~07/out PODE e NÃO PODE concluir

Pré-registro, escrito **antes** do checkpoint — este é o ponto central do
#4905: com os 3 hubs tratados, **nem uma citação nem a ausência dela é
atribuível às mudanças desta auditoria**. O checkpoint continua medindo se a
frente de hubs produz citação; ele não mede se estas regras específicas
produzem citação. São perguntas diferentes, e só a primeira segue
respondível com o desenho atual (N=3, sem randomização, sem controle).

Se o resultado em outubro for "zero citação" (ou próximo disso), existem
pelo menos **cinco explicações concorrentes**, já levantadas por esta
auditoria, e **nenhuma delas é separável com o desenho atual**:

1. **O instrumento não pergunta sobre o tema.** As 8 perguntas originais de
   `GEO_QUESTIONS` (`scripts/lib/geo-citation-monitor.ts`) não mencionam
   Anthropic, Claude, OpenAI, ChatGPT, Google nem Gemini — perguntam sobre
   newsletter, curso e livro de IA em português, não sobre os temas que os
   hubs cobrem.
2. **As páginas podem não ter sido descobertas.** Achado de sitemap/
   IndexNow/Bing desta mesma auditoria: `/temas/` ficou, por um tempo, fora
   de toda medição de indexação do projeto (corrigido em parte pelo #4909 —
   `<lastmod>`/`Last-Modified`/`ETag` — mas a verificação em Bing Webmaster
   Tools segue pendente, bloqueio externo/local).
3. **Pode não haver demanda em pt-BR** pelas perguntas-alvo que os hubs
   respondem — achado de demanda desta auditoria (#4908), ainda não medido
   com dado real de query.
4. **A tese GEO pode não se sustentar no volume de acervo atual** — esta é a
   única das cinco que a regra de parada original de fato testa.
5. **As páginas podem estar descobertas mas não indexadas — mensurável AGORA,
   diferente das outras quatro (#5619).** Medição de 18/08/2026:
   `data/seo/index-status-arquivo-2026-08-16.md` mostra 6 das 8 URLs do
   `arquivo.diar.ia.br` fora do índice do Google (2/8 indexadas). Entre as
   ausentes, 5 dos 6 hubs temáticos — `openai-chatgpt`, `google-gemini`,
   `meta-ai`, `brasil-regulacao`, `mercado-trabalho` — e o índice `/temas/`;
   só `anthropic-claude` e a home entraram. Diferente do item 2 (descoberta:
   "o buscador sabe que a página existe?"), este é sobre indexação
   ("o buscador colocou a página no índice de onde ele cita?") — as páginas já
   passaram pelo problema do item 2 e ainda assim majoritariamente não
   entraram no índice. O checkpoint de ~07/out vai perguntar "os hubs geraram
   citação?" sobre páginas que, em boa parte, o Google não indexou — isso não
   invalida o checkpoint, mas é uma explicação alternativa que precisa estar
   escrita antes do número, pela mesma lógica que produziu os quatro itens
   acima.

**Nota sobre o item 1, pra não confundir leitura futura:** em 10/08/2026 (já
no mesmo dia da decisão registrada acima, #4900) foi ativado um painel
SEPARADO, `GEO_HUB_QUESTIONS`, com perguntas temáticas que cobrem
especificamente o que cada hub responde (ex: "O que aconteceu com a
Anthropic em 2026?", "Quando saiu o Claude Opus 5?"). Isso mitiga o item 1
**a partir de 10/08/2026 em diante**, mas não retroage sobre os registros
anteriores de `GEO_QUESTIONS` (baseline desde 07/08/2026) — os dois painéis
são medidos e reportados separadamente, de propósito, pra não invalidar a
série já em andamento (ver docstring de `GEO_HUB_QUESTIONS` no código). O
item 1 continua valendo integralmente pra qualquer leitura feita sobre o
painel `"geral"`.

## Por que o desenho de controle não valia a pena manter

Vale registrar por que a decisão do editor não é uma perda grave, em vez de
só dizer que ela foi tomada. A força do desenho descartado era **consenso de
praticante**, não estudo — o survey verificado (arXiv 2607.14035) usado
nesta auditoria afirma que nenhuma técnica revisada mostra efeito causal
estável e longitudinal, ou seja, não existe efeito de referência pra
importar da literatura, e por isso a atribuição local seria a única coisa
capaz de informar o checkpoint. Mas o desenho já nascia fraco mesmo antes da
decisão: N=3, sem randomização, hubs publicados em datas diferentes, com
acervo bem diferente entre eles (96 edições citadas em `openai-chatgpt` vs
76 em `anthropic-claude` vs 61 em `google-gemini`, medido em `origin/master`
eb796bfa). Era o único sinal causal obtenível de graça, e era fraco. Perder
um sinal fraco é barato — perder o **registro** de que ele não existe é o
que sairia caro em outubro, se ninguém tivesse escrito isto antes.

## O que este documento NÃO autoriza

- **Não reabre o desenho de controle.** É decisão explícita do editor,
  10/08/2026. Quem quiser mudá-la fala com ele — não é decisão de sessão.
- **Não autoriza criar hub extra "pra recuperar N".** Contraria a mesma
  decisão e a regra de "não escrever hub novo até o checkpoint" (#4558), e
  de todo modo não resolve a ausência de randomização. A exceção única de
  19/09/2026 (`deepfake`, #8391, seção acima) não é um caso disso: ela não
  foi aberta para melhorar o N deste experimento — é uma medição de OUTRO
  eixo (demanda de busca), com critério próprio, e o editor a autorizou
  explicitamente como única.
- **Não introduz gate mecânico.** Não existe (nem deveria existir) lint que
  imponha simetria de prosa entre os 3 `scripts/lib/hubs/*.ts` — isso
  proibiria manutenção legítima de um hub só (ex: corrigir um número errado
  em `google-gemini.ts` não obriga tocar nos outros dois). O guard mecânico
  que existe (`validateHubContent`/`hub-page-drift.test.ts`) é sobre
  **estrutura compartilhada pelo renderer**, não sobre conteúdo editorial
  idêntico entre hubs.
- **Não licencia apresentar o resultado de outubro como prova causal.** Em
  nenhuma hipótese — nem "citou, logo a auditoria funcionou", nem "não
  citou, logo a auditoria falhou". O relatório do checkpoint deve carregar
  esta limitação no corpo, não em nota de rodapé, e — se o painel
  `GEO_HUB_QUESTIONS` ainda não separar tema de hub o suficiente pro que se
  quer concluir — dizer isso explicitamente em vez de reportar um número que
  não mede o que se diz que mede.

## Fonte única

Este é o registro canônico desta decisão. Não duplicar o diagnóstico em
outro arquivo — cruzar por link/comentário a partir de outros documentos
(#4558, `docs/seo-notes.md` quando relevante) em vez de reescrever o
conteúdo.
