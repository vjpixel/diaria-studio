# Hubs temáticos GEO — sem grupo de controle (decisão do editor, 10/08/2026)

Registro da decisão citada no #4905 (Refs #4558). Não é runbook — é o mesmo
tipo de "nota de fato apurado" que `docs/seo-notes.md` mantém pra dado de SEO,
aqui aplicado à leitura do checkpoint de citação por assistente de ~07/out.

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
pelo menos **quatro explicações concorrentes**, já levantadas por esta
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
   única das quatro que a regra de parada original de fato testa.

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
  de todo modo não resolve a ausência de randomização.
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
