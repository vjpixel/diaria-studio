# Unificação do render HTML diário (Beehiiv) vs mensal (Brevo/Clarice) — análise (#3269)

**Status:** investigação concluída. Não implementa a unificação — produz o mapeamento e a
recomendação para uma decisão de arquitetura informada. Um extra de baixíssimo risco
(extração de `tealDot()`) foi implementado como parte deste PR — ver [O que este PR
realmente muda](#o-que-este-pr-realmente-muda) no fim.

**Arquivos analisados na íntegra** (não por amostragem):
- `scripts/lib/newsletter-render-html.ts` — 1460 linhas no início da investigação, 1447
  após a extração da seção 7 (diário, Beehiiv)
- `scripts/lib/mensal/monthly-render.ts` — 1230 linhas no início da investigação, 1231
  após o ajuste de import da seção 7 (mensal, Brevo/Clarice)
- `scripts/lib/shared/design-tokens.ts`, `scripts/lib/shared/newsletter-styles.ts`,
  `scripts/lib/word-joiner.ts`, `scripts/lib/html-escape.ts` (o que já é de fato compartilhado)
- `test/lib-boundary.test.ts` (a fronteira lint-enforced shared/diaria/mensal, #2747)
- Amostra de testes golden/drift existentes (`test/design-tokens.test.ts`,
  `test/monthly-render-3181-3183.test.ts`, `test/email-type-scale-white-shell.test.ts`,
  `test/ds-golden-full-render.test.ts`)

---

## 1. Contexto

Os dois renderers implementam **o mesmo design system visual** (paleta de 4 cores,
tipografia, kicker, boxes "contorno"/"painel", É IA?, wordmark) para dois formatos de
e-mail (newsletter diária de 1 artigo por destaque vs digest mensal narrativo
multi-artigo) em duas plataformas de envio diferentes (Beehiiv vs Brevo). O compartilhamento
hoje é fino:

| Módulo | O que compartilha | Como |
|---|---|---|
| `scripts/lib/shared/design-tokens.ts` | `COLORS`, `FONTS`, `BOX` | import direto, ambos os arquivos |
| `scripts/lib/shared/newsletter-styles.ts` | CSS base do `<style>` (3 níveis: base/overrides/standalone dark-canvas) | `buildDiariaStyleBlock`/`buildMensalStyleBlock`/`darkCanvasMediaRule` |
| `scripts/lib/word-joiner.ts` | anti-linkify de domínios (`Clarice.ai`) | `applyWordJoiner`, import direto |
| `scripts/lib/html-escape.ts` | escape de HTML | `escHtml`/`esc`, import direto (já genérico, mas fora de `shared/`) |
| `scripts/lib/newsletter-render-html.ts` → `monthly-render.ts` | `applyBrandWordmark`, `tealDot` | **import cruzado ad-hoc** — `monthly-render.ts` importa direto do arquivo "diário", não de `shared/` |

O último item é o sintoma citado na issue: só é possível porque `newsletter-render-html.ts`
mora na raiz "legada não-classificada" de `scripts/lib/`, **fora** da fronteira que
`test/lib-boundary.test.ts` já protege para `shared/`, `diaria/` e `mensal/`. Se
`newsletter-render-html.ts` fosse movido para `scripts/lib/diaria/` (o destino óbvio,
citado no `CLAUDE.md` como "futuro"), esse import cruzado **quebraria o teste de
fronteira imediatamente** — hoje ele só não quebra porque o arquivo está tecnicamente
fora do escopo do lint.

---

## 2. Mapeamento componente a componente

Convenção de nomes: **diário** = `scripts/lib/newsletter-render-html.ts`; **mensal** =
`scripts/lib/mensal/monthly-render.ts`.

### 2.1 Já compartilhado de verdade (não requer ação)

| Componente | Diário | Mensal |
|---|---|---|
| Paleta/fontes | `COLORS`/`FONTS` (design-tokens.ts) | idem |
| CSS base do `<style>` | `buildDiariaStyleBlock` | `buildMensalStyleBlock` |
| Dark-canvas media query | `buildDarkCanvasStyleBlock` (standalone, só `fullDocument`) | embutido em `buildMensalStyleBlock` |
| Word-joiner anti-linkify | `applyWordJoiner` | idem |
| Escape HTML | `esc` (= `escHtml`, alias) | `escHtml` |

Esses 5 já passaram pela extração formal (#1936, #2018, #2635, #3104) — servem de
**precedente de processo** para a proposta da seção 3: extraído para `shared/`, com
teste de regressão pareado (`newsletter-styles.test.ts`, `word-joiner.test.ts` cobrem
os dois renderers na mesma suíte).

### 2.2 Idênticos ou quase-idênticos, HOJE não compartilhados de verdade (candidatos Tier 1 — extração direta, baixo risco)

| Componente | Diário | Mensal | Observação |
|---|---|---|---|
| `tealDot()` | `renderKicker`, `renderWhyBoxInner`, `renderEIA` | `renderKicker`, `boxFor` ("O fio condutor"), `renderEia` | **Já era import cruzado** (`monthly-render.ts` importava de `newsletter-render-html.ts`). Movido para `scripts/lib/shared/email-components.ts` **nesta issue** (ver seção 5). |
| `applyBrandWordmark()` + `BRAND_WORDMARK_HTML`/`BRAND_WORDMARK_RE` | export usado internamente (`escText`, `mdInlineToHtml`) | **já importa direto** do diário (mesmo padrão do `tealDot` antes deste PR) | Função pura, já parametrizada (`linkHref?` opcional — o mensal usa, o diário não). Zero motivo estrutural para não estar em `shared/`; é o candidato Tier 1 mais óbvio do próximo PR. Não movido aqui só para manter o blast radius desta issue pequeno (a extração teria que levar ~15 testes de `test/render-newsletter-html.test.ts` junto). |
| Box "contorno" (fundo `PAPER`+borda `RULE` 1px, `border-radius:12px`, `padding:24px 28px`) | `renderWhyBoxInner` ("Por que isso importa") | `boxFor` dentro de `renderDestaque` ("O fio condutor") | Mesma constante `PAD_BOX_OUTLINE = "24px 28px"` **duplicada literalmente nos dois arquivos** (comentário em `monthly-render.ts:52-60` documenta que foi copiada do diário no PR#3183 pra eliminar 2px de drift — ou seja, já foi corrigida manualmente 1x e pode driftar de novo). A estrutura de tabela (`<table><tr><td style="background/border/border-radius/padding">`) é byte-idêntica exceto pelo texto do label. |
| Box "painel" (fundo `SURFACE`/`BEGE`, sem borda, `border-radius:12px`, `padding:24px 28px`) | `renderEIA`, `renderSorteio`, CTA final de `renderEncerrar`, `renderIntroCallout` | `renderClariceBox` (Laboratório/Divulgação/Livros), `renderEia`, caixa final de `renderEncerramento` | Mesmo padrão estrutural repetido **~4x em cada arquivo** (8 ocorrências ao todo) da mesma tabela `background:${SURFACE_OU_BEGE};border-radius:12px;padding:24px 28px`. Nunca foi centralizado nem dentro de um único arquivo. |
| Pill/botão CTA "contorno" (fundo `paper`, borda `rule` 1px, `border-radius:999px`, bold, `padding:12px 22px` variável) | inline em `renderIntroCallout` (2 variantes: single-link e multi-link) + inline em `renderMidCallout` | `renderPillLink()` (já é um helper local compartilhado dentro do mensal, usado por `renderEncerramento`/`renderSocialFooter`) + `renderCtaButton()` (outra implementação, quase idêntica) | **5 implementações independentes do mesmo pill** contando as 2 do diário + as 2 do mensal + o CTA do box de divulgação. O mensal já fez a extração *localmente* (`renderPillLink`) — falta subir 1 nível para `shared/` e absorver as do diário. |
| `imageGeneratorCredit()` (diário) vs `GENERATOR_LABELS`/`captionForGenerator()` (mensal) | lê `platform.config.json` direto | recebe o gerador como parâmetro (caller lê o config) | Mesmo conceito, **valores em drift**: diário mapeia `openai → "Criada com gpt-image-2"` e `cloudflare → "Criada com Cloudflare FLUX"`; mensal mapeia `openai → "Criada com DALL-E"` e `cloudflare → "Criada com Cloudflare AI"`. Achado desta investigação — não estava documentado em nenhuma issue. Ver seção 4. |

### 2.3 Estruturalmente parecidos, mas com parâmetros/dados que genuinamente divergem (candidatos Tier 2 — dá para compartilhar, mas exige desenho de interface)

| Componente | Diário | Mensal | Por que não é extração mecânica |
|---|---|---|---|
| É IA? (`renderEIA` / `renderEia`) | kicker + painel + título 26px + imagens A/B empilhadas (`width="480"` px fixo, correção MSO) + crédito + **linha de vencedores do mês** (`renderLeaderboardTop1Row`, pódio 1º/2º/3º) + link persistente pro leaderboard | kicker + painel + título 26px + imagens A/B empilhadas (`width="100%"`, SEM correção MSO) + crédito + link único pro leaderboard anual (`/leaderboard/20{yy}?brand=clarice`) | Mesmo esqueleto visual, mas: (a) vote URL usa merge tag diferente por ESP (`{{email}}` Beehiiv vs `{{ contact.EMAIL }}` Brevo) + o mensal acrescenta `&brand=clarice` porque os votos das duas audiências caem no mesmo Worker KV; (b) o mensal **não tem** o bloco de vencedores/pódio do mês (não haveria "vencedores do mês" fazendo sentido no cadência mensal do jeito que faz na diária); (c) o mensal não tem a correção de `width` em pixel pro Outlook — **risco real** de estouro de layout no Outlook desktop que o diário já corrigiu (#3101) e o mensal nunca recebeu (ver seção 4). Compartilhável via componente parametrizado (voteUrlBuilder, showPodium: boolean, imageWidthStrategy), mas não é um `git mv`. |
| Item de lista (Use Melhor / Lançamentos / Radar) | `renderSectionItem` — recebe `SectionItem` tipado (de `newsletter-parse.ts`), título Georgia **22px** | `renderLinkListSection` — faz seu PRÓPRIO parsing regex de `[título](url)\n\ndescrição` a partir de markdown cru, título Georgia **20px** | Fonte de dados diferente (objeto tipado vs. parsing ad-hoc de markdown), E o tamanho de fonte diverge (20px mensal vs 22px diário — fora do type-scale {12,16,22,26} que o diário tem travado por teste, ver seção 4). O RENDER do item (uma vez que se tem `{title, url, description}`) poderia ser 1 componente só; o PARSE não deveria — são formatos de input genuinamente diferentes. |
| Parser de link markdown com parênteses balanceados | `findMarkdownLinks()` (helper exportado, reusado por `mdInlineToHtml`) **+ uma 2ª implementação inline** dentro de `tokenizeInline()` (usada por `processInlineLinks`/`renderBodyInline`, que também precisa lidar com `**bold**` colado ao link, #3220/#3280/#3316) | **3ª implementação** inline dentro de `renderInline()`, mesmo algoritmo (profundidade de parênteses), sem a lógica de bold-wrap | **3 implementações do mesmo scanner** no repo (2 no diário, 1 no mensal) — todas resolvendo o mesmo bug histórico (#1634, URLs com parênteses truncando o link). O caso do mensal é o subconjunto mais simples (sem bold-wrap) — dá pra consumir o scanner de baixo nível do diário, mas não é uma troca de 1 linha: precisa decidir se o scanner de baixo nível vira uma função exportada separada de `tokenizeInline`/`mdInlineToHtml` (hoje `findMarkdownLinks` já é essa função, só falta o mensal trocar seu próprio loop por uma chamada a ela). |
| Parágrafo de corpo (`bodyP` no diário) | helper local, usado ~15x | **sem equivalente** — o mensal repete `<p style="margin:0 0 16px 0;font-family:${FONT_SANS};">` cru em ~6 call sites (`renderParagraphs`, `renderDestaque`, `renderIntro`, `renderClariceBox`, `renderEncerramento`) | Não é bem um candidato de unificação CROSS-arquivo (a margem difere: diário usa 18px/8px escalonado, mensal usa 16px fixo) — mas é uma duplicação *interna* ao mensal que um `bodyP` local (espelhando o padrão do diário) resolveria independente desta issue. Mencionado aqui porque é o tipo de achado que aparece ao ler os dois arquivos lado a lado. |

### 2.4 Genuinamente diferentes por modelo de conteúdo ou plataforma (NÃO deveriam ser unificados)

| Diferença | Motivo estrutural |
|---|---|
| Destaque = 1 artigo (diário, manchete é `<a>` linkada) vs. Destaque = narrativa multi-artigo por tema (mensal, título é `<h2>` sem link — comentário explícito no código: "SEM sublinhado — não é link") | Modelo editorial permanente, não incidental. Forçar paridade aqui quebraria a semântica do mensal. |
| Pipeline PARSE→RENDER separado (diário: `newsletter-parse.ts` produz `NewsletterContent` tipado, consumido por `newsletter-render-html.ts`) vs. PARSE+RENDER no mesmo arquivo (mensal: `splitByLabels`/`isSectionLabel`/`parseHeaderChunk` fazem parsing de markdown cru dentro do próprio `monthly-render.ts`) | Assimetria arquitetural real. Uma unificação de "pipeline inteiro" exigiria primeiro dar ao mensal a mesma separação parse/render do diário — projeto maior, não coberto por esta issue. |
| Fragmento HTML colado no editor Beehiiv (`fullDocument:false`, o Beehiiv fornece o shell) vs. documento HTML completo sempre (`wrapEmail`, o Brevo não fornece shell) | Contrato de plataforma, não escolha de implementação. |
| UTM `clarice-{ciclo}` injetado em todo link `diaria.beehiiv.com` (`withClariceUtm`/`setMonthlyUtmCiclo`, só mensal) | Necessidade de atribuição específica da migração Clarice→Diar.ia (#2975); não existe no diário. |
| `renderIntroCallout`/`renderBoxDivulgacao`/`renderMidCallout` (diário — parsing de marcadores 📣/📚/🎉/🛒, CTA-pill heurístico #2136/#2996/#3204) vs. `renderClariceBox`/`renderCtaButton` (mensal — seções rotuladas explicitamente `CLARICE —`/`LIVROS`/`DIVULGAÇÃO` no draft) | Fontes de sinal diferentes (heurística sobre texto livre vs. rótulo explícito de seção) — refletem os pipelines de autoria diferentes (writer-destaque + humanizador no diário vs. writer-monthly com template de labels no mensal). |

---

## 3. Achados de drift concretos desta investigação (além dos já citados na issue)

A issue já cita #3181/#3183 (contraste AA + padding/letter-spacing) e #3204/#3233→#3232
(detecção de callout) como evidência de drift histórico. Lendo os dois arquivos por
completo nesta investigação, mais 4 achados **novos**, nenhum corrigido aqui (fora de
escopo — são achados para issues de follow-up, não parte da análise em si):

1. **Type scale do mensal não é testado — e já divergiu.** `test/email-type-scale-white-shell.test.ts`
   trava o diário em `{12,16,22,26}px` lendo só `scripts/lib/newsletter-render-html.ts`
   (linha 21 do teste). O mensal tem **2 ocorrências de `font-size:20px`**
   (`renderLinkListSection`, títulos de item do Use Melhor/Radar) — fora dessa escala, e
   sem nenhum teste que pegaria isso. O equivalente no diário (`renderSectionItem`) usa
   `22px`. Não dá pra saber pela leitura se é intencional ou drift histórico — é
   exatamente o tipo de coisa que um componente compartilhado + 1 teste cobrindo os 2
   renderers teria pego automaticamente.
2. **Hero image do mensal sem correção de largura para Outlook.** O diário tem
   `width="536"` (atributo HTML em pixels) em toda imagem hero, com comentário extenso
   (#3101) explicando que o Outlook desktop ignora `width` percentual em `<img>` e
   renderiza no tamanho intrínseco do arquivo, estourando o container de 600px. O
   mensal (`renderDestaque`, linha ~403) usa só `style="width:100%"`, sem o atributo
   `width` em pixel — a mesma classe de bug que o #3101 corrigiu no diário
   provavelmente também afeta o Outlook no mensal, nunca corrigida lá.
3. **`imageGeneratorCredit`/`GENERATOR_LABELS` divergem por gerador.** `openai` e
   `cloudflare` têm legendas diferentes entre os dois arquivos (seção 2.2) — se o
   `image_generator` ativo em `platform.config.json` for `openai` ou `cloudflare`
   simultaneamente para diário e mensal, o leitor vê 2 créditos de imagem diferentes
   para o "mesmo" gerador.
4. **`findMarkdownLinks` triplicado** — mesmo algoritmo (parênteses balanceados,
   correção do bug #1634) reimplementado 3x (2 no diário, 1 no mensal). Cada
   reimplementação é uma chance de o próximo bugfix de parsing de link (como #1634 foi)
   ser aplicado em só 1 ou 2 dos 3 lugares.

---

## 4. Proposta de extração concreta

Lista acionável para quem for implementar, com destino sugerido em `scripts/lib/shared/`:

| # | Função/componente | Assinatura sugerida | Destino | Risco | Status |
|---|---|---|---|---|---|
| 1 | `tealDot()` | `(): string` | `shared/email-components.ts` | Muito baixo — já era cross-import, zero parâmetros, zero dependência de estado | **Feito neste PR** |
| 2 | `applyBrandWordmark()` + `BRAND_WORDMARK_HTML`/`BRAND_WORDMARK_RE` | `(s: string, linkHref?: string): string` | `shared/email-components.ts` | Baixo — já é pura e já parametrizada; trabalho é mecânico (mover + atualizar ~15 imports de teste) | Não feito (próximo PR recomendado) |
| 3 | `renderOutlineBox(innerHtml: string, opts?: {marginTop?: string})` | wrapper da tabela "contorno" (fundo `paper`, borda `rule`, radius 12, padding 24/28) | `shared/email-components.ts` | Baixo — puramente estrutural, o CONTEÚDO interno (label + texto) continua sendo montado por cada caller | Não feito |
| 4 | `renderPanelBox(innerHtml: string, opts?: {bg?: string})` | wrapper da tabela "painel" (fundo `surface`/`bege`, sem borda, radius 12, padding 24/28) | `shared/email-components.ts` | Baixo — mesma natureza do #3 | Não feito |
| 5 | `renderPillButton(label: string, url: string, opts?: {fontSize?, padding?, background?})` | pill CTA outline (fundo paper, borda rule, radius 999, bold) | `shared/email-components.ts` | Baixo-médio — precisa reconciliar as ~5 implementações existentes (2 diário, `renderPillLink`+`renderCtaButton` no mensal) sem mudar o HTML byte-a-byte onde há golden tests | Não feito |
| 6 | `findMarkdownLinks(s: string)` | já existe no diário, exportada | mover para `shared/markdown-links.ts` (ou `shared/email-components.ts`) e trocar o loop equivalente dentro de `renderInline` (mensal) por uma chamada a ela | Médio — `tokenizeInline` (diário) tem lógica extra de bold-wrap que não deve ir junto; só o scanner de baixo nível deveria migrar | Não feito |
| 7 | `imageGeneratorCredit`/`GENERATOR_LABELS` | unificar o MAPA (`Record<string,string>`) em `shared/`, resolvendo a divergência openai/cloudflare (decisão editorial: qual legenda é a correta) | `shared/design-tokens.ts` ou novo `shared/image-credits.ts` | Baixo mecanicamente, mas **exige decisão do editor** sobre qual legenda (gpt-image-2 vs DALL-E; Cloudflare FLUX vs Cloudflare AI) é a correta antes de mover — não é só refactor | Não feito |
| 8 | É IA? (`renderEIA`/`renderEia`) | componente parametrizado por `{ voteUrlBuilder, showPodium, imageWidthPx? }` | `shared/email-components.ts` | Médio-alto — maior superfície de teste (golden tests dos dois lados), mas é o maior payoff (é literalmente o componente que mais gerou os incidentes #3181/#3183 citados na issue) | Não feito (avaliação de trade-off na seção 5) |

Itens 1–4 e 6–7 são mecânicos o bastante para PRs pequenos e isolados (1 componente por
PR, seguindo a regra de commit atômico do repo). O item 5 precisa de um pouco mais de
cuidado (reconciliar padding/fontSize entre as instâncias antes de trocar todas por 1
função). O item 8 é o único que eu classificaria como "vale um PR dedicado com plano
próprio", não algo pra enfiar dentro de um lote maior.

---

## 5. Avaliação de trade-off: vale formalizar um "component layer" único?

**Sim, parcialmente — no nível de componente visual, não no nível de pipeline.**

Argumentos a favor de uma camada `shared/email-components.ts` (ou um pequeno módulo
por componente) com os itens 1–8 acima:

- Evidência concreta e repetida de drift em produção: #3181/#3183 (padding/contraste),
  #3204/#3233 (detecção de callout), e os 4 achados novos da seção 3 — todos no mesmo
  padrão: um fix aplicado num renderer, esquecido no outro, até alguém notar meses
  depois.
- Os componentes candidatos (itens 1–7) são **estruturalmente triviais** — tabelas HTML
  com background/border/padding fixos, ou funções puras de string→string sem estado.
  Não têm as divergências reais de plataforma (UTM, merge tags, ESP) que tornam
  arriscado unificar camadas mais altas.
- Já existe precedente funcionando: a extração de `design-tokens.ts`/`newsletter-styles.ts`
  (#1936/#2635/#3104) seguiu exatamente esse padrão — "níveis" (base + overrides por
  renderer) em vez de forçar 1 função única — e não gerou regressão até hoje.
- O teste de fronteira (`test/lib-boundary.test.ts`) já existe e já cobre `shared/` —
  não é infraestrutura nova, é aplicar a que já existe a mais 6-8 funções.

Argumentos contra ir além disso (unificar `renderHTML`/`draftToEmail` num único
pipeline parametrizado por plataforma):

- **Os dois arquivos têm arquiteturas de parsing fundamentalmente diferentes**
  (parse/render separado no diário vs. parse+render juntos no mensal). Unificar em cima
  disso significaria refatorar o mensal para adotar um parser tipado equivalente a
  `newsletter-parse.ts` primeiro — projeto de escopo comparável a uma reescrita do
  renderer mensal, não uma extração.
- **Divergências de plataforma são legítimas e prováveis de crescer, não encolher.**
  Beehiiv (fragmento colado, shell da plataforma, merge tag `{{email}}`) vs. Brevo
  (documento completo, merge tag `{{ contact.EMAIL }}`, UTM de atribuição Clarice) — a
  issue já antecipa isso ("Brevo vs Beehiiv têm parsers de e-mail e limitações de HTML
  potencialmente diferentes"). Um "component layer" único que tentasse abstrair
  TAMBÉM essas diferenças de plataforma (não só as visuais) acoplaria 2 produtos de
  envio com trajetórias de produto diferentes — o mensal é uma parceria B2B2C
  (Clarice) com necessidades de atribuição que o diário não tem e provavelmente nunca
  vai ter.
- **O modelo de conteúdo do destaque diverge por design editorial**, não por acidente
  de implementação (1 artigo linkado vs. narrativa multi-artigo sem link). Forçar
  paridade aqui é a definição de "acoplar 2 produtos com necessidades que divergem".
- Risco de regressão visual é real: ambos os arquivos têm golden tests
  (`ds-golden-full-render.test.ts`, `monthly-render-3181-3183.test.ts`) que travam
  **strings exatas** de HTML. Uma extração malfeita do componente errado (ex: É IA?
  sem parametrizar a ausência do pódio no mensal) quebraria silenciosamente algo que
  hoje só é visível comparando os 2 emails renderizados lado a lado.

**Conclusão da avaliação:** o custo de manutenção do estado atual (drift silencioso,
correções replicadas manualmente, achados novos a cada leitura completa como esta) é
real e documentado — mas o remédio certo é uma **camada de componentes visuais
pequenos e sem estado** (itens 1–7, e o 8 com cautela extra), não um pipeline de
renderização único. A fronteira `shared/diaria/mensal` já modela essa decisão
corretamente — só falta povoar `shared/` com mais funções.

---

## 6. Recomendação

**PARCIAL — sim para extração de componentes (itens 1–7 da seção 4), não para unificação
de pipeline.**

Plano de execução sugerido, em ordem de risco crescente (cada um um PR isolado, seguindo
a regra "1 PR aberto por vez" do `CLAUDE.md`):

1. ~~`tealDot()` → `shared/email-components.ts`~~ **feito neste PR** (ver seção 7).
2. `applyBrandWordmark()` → `shared/email-components.ts` (mesmo padrão do #1, arrasta os
   ~15 testes de `test/render-newsletter-html.test.ts` — mover ou re-exportar).
3. `renderOutlineBox`/`renderPanelBox` (itens 3–4) — extrair como wrappers puramente
   estruturais; cada caller (`renderWhyBoxInner`, `boxFor`, `renderEIA`, `renderSorteio`,
   `renderClariceBox`, `renderEia`, CTA de `renderEncerrar`/`renderEncerramento`) passa a
   montar só o HTML interno e delega o wrapper. Byte-idêntico se feito com cuidado —
   validar com os golden tests existentes antes de merge.
4. `renderPillButton` (item 5) — reconciliar as 5 implementações; provavelmente precisa
   de 1 decisão editorial pequena (padronizar padding/fontSize) antes.
5. `findMarkdownLinks` compartilhado (item 6) — trocar o scanner duplicado do mensal
   pelo do diário.
6. `imageGeneratorCredit`/`GENERATOR_LABELS` (item 7) — **pede decisão do editor**
   primeiro (qual legenda é a correta por gerador); depois é mecânico.
7. É IA? (`renderEIA`/`renderEia`, item 8) — só depois dos itens 1–6 estarem
   estabilizados; PR dedicado, com plano de teste explícito cobrindo os 2 renderers
   (incluindo o caso `showPodium:false` do mensal e a correção de largura Outlook que
   o mensal nunca recebeu, achado #2 da seção 3).

Nenhum desses PRs precisa — nem deveria tentar — unificar `renderHTML(content, opts)` e
`draftToEmail(draft, ...)` num único ponto de entrada. Os dois pipelines continuam
existindo; só a caixa de ferramentas de componentes visuais que eles chamam por baixo
fica compartilhada.

---

## 7. O que este PR realmente muda

Conforme autorizado pelo escopo desta issue ("extração de 1-2 componentes triviais e de
baixíssimo risco... com alta confiança de fazer com segurança E cobertura de teste"),
este PR inclui, **como extra opcional, não o objetivo principal**:

- Novo módulo `scripts/lib/shared/email-components.ts`, com `tealDot()` extraído de
  `scripts/lib/newsletter-render-html.ts`.
- `scripts/lib/newsletter-render-html.ts` passa a importar `tealDot` de `shared/` e
  re-exportá-lo (`export { tealDot }`) para back-compat — nenhum import externo
  existente quebra.
- `scripts/lib/mensal/monthly-render.ts` passa a importar `tealDot` de
  `../shared/email-components.ts` em vez de `../newsletter-render-html.ts` — fecha o
  import cruzado citado na issue como sintoma principal (item 1 da seção 4).
- Novo teste `test/email-components.test.ts` — trava o output do helper compartilhado e
  confirma que os 2 renderers resolvem para o MESMO módulo (não uma cópia).
- `npx tsc --noEmit` limpo; suíte completa rodada (`npm test`, 12456 testes) — 0
  regressões atribuíveis a esta mudança (1 falha pré-existente em
  `test/resolve-edition-url.test.ts`, confirmada como flake de isolamento de log
  concorrente rodando a suíte completa, não relacionada — passa 100% quando rodado
  isoladamente).

Este passo, sozinho, não resolve o problema estrutural da issue (o import cruzado
persiste para `applyBrandWordmark`, e os componentes de maior payoff — boxes/pill/É IA? —
seguem duplicados). Ele serve de prova de conceito de baixo risco para o padrão de
extração recomendado na seção 6, e remove 1 dos 2 imports cruzados citados como sintoma
na issue original.
