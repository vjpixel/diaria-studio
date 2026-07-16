# Template — Edição Mensal diar.ia.br

Formato exato do digest mensal. Cada destaque é uma narrativa multi-artigo cobrindo um tema do mês (não um único artigo, como no diário).

**Todo label de seção (linha isolada tipo `ASSUNTO`, `DESTAQUE 1 | TEMA`, `INTRO` etc.) DEVE sair envolto em `**negrito**`** — é o único sinal que o render (`isSectionLabel`/`splitByLabels` em `scripts/lib/mensal/monthly-render.ts`) usa pra separar as seções do draft. Um label em texto plano (sem `**`) faz o draft inteiro colapsar num único bloco de prosa no email final — zero imagens, zero seções (#2794, causa raiz do ciclo 2606-07). O render tem uma tolerância de emergência para alguns labels sem negrito, mas ela é rede de segurança, não licença — sempre emitir com `**`.

```
**ASSUNTO (3 OPÇÕES)**
1. [opção 1 — máx. 70 chars, destaca o tema central do mês]
2. [opção 2 — outro ângulo do mês]
3. [opção 3 — terceira via]

**PREVIEW**

[1 linha — síntese do mês em até 100 chars]

**APRESENTAÇÃO**

Esta é a newsletter mensal da [Clarice](https://clarice.ai/?via=diaria), em parceria com a diar.ia.br: uma curadoria para você entender, em poucos minutos, o que mudou no mundo da IA.

Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo "quero". Se quiser receber tutoriais e notícias de IA todos os dias, se cadastre gratuitamente [aqui](https://diaria.beehiiv.com).

Você está recebendo esse e-mail porque se cadastrou na [Clarice](https://clarice.ai/?via=diaria). Caso não queira receber a newsletter, pode se [descadastrar aqui]({{ unsubscribe }}).

**INTRO**

[2-3 frases contextualizando o mês: o que dominou a pauta, qual o tom geral.
Não cita os 3 destaques explicitamente — abre cena.]

---

**DESTAQUE 1 | [TEMA]**

[Título narrativo do tema — máx. 60 chars]

[Parágrafo 1 — abre o tema com o evento mais marcante do mês; cada evento referencia sua fonte com link ancorado: "o [modelo identificou 27 mil falhas](https://fonte.com/artigo)"]

[Parágrafo 2 — desenvolve, conecta com outros artigos do tema; cada fato com link ancorado na frase correspondente]

[Parágrafo 3 — atores, dados, números do mês; cada dado ancorado à fonte]

[Parágrafo 4 — fecha com a leitura editorial; se o limite de chars apertar, fundir P3+P4 em um parágrafo só]

O fio condutor:
[1 parágrafo — o que esse tema revelou sobre o mês de IA. Não é "Por que isso importa" do diário; é síntese do tema. Sem URLs inline.]

---

**CLARICE — DIVULGAÇÃO**

[Placeholder — inserir aqui a seção de divulgação da Clarice: apresentação do produto, proposta de valor, call to action com link.]

---

**DESTAQUE 2 | [TEMA]**

[mesmo formato]

---

**CLARICE — TUTORIAL**

[Placeholder — inserir aqui um tutorial prático de uso da Clarice: dica, caso de uso ou passo a passo curto com link para saber mais.]

---

**DESTAQUE 3 | [TEMA]**

[mesmo formato]

---

**USE MELHOR**

[[Título do tutorial 1](https://url)]

[1-2 frases — o que o tutorial ensina.]

[... 3 itens: os tutoriais Use Melhor mais clicados do mês (de `## Use Melhor` em prioritized.md)]

---

**RADAR**

[[Título do link 1](https://url)]

[1-2 frases de descrição — por que importa.]

[[Título do link 2](https://url)]

[1-2 frases de descrição — por que importa.]

[... 7 itens: os links mais clicados do mês fora dos Destaques e do Use Melhor (de `## Radar` em prioritized.md)]

---

**É IA? — DESTAQUE**

[Recap de UM É IA? do mês — preferir a edição cujo poll ficou mais próximo de 50% de acerto
(mais ambígua para os leitores). Se poll não disponível, escolher a mais visualmente difícil.
Inserir: edição de origem, % de acerto (se disponível), breve análise do que tornou aquela
imagem boa/difícil. 1-2 parágrafos curtos.]

---

**PARA ENCERRAR**

[Chamada padrão pra interação: responder ao e-mail, sugerir tema, indicar a
newsletter pra colega. Tom igual ao diário. Incluir call-to-action para assinar
a newsletter diária com o link https://diaria.beehiiv.com/?utm_source=clarice
(o parâmetro utm_source é obrigatório — é o que rastreia quantos assinantes
da diária vieram pela mensal; usar diaria.beehiiv.com direto pois diar.ia.br
dropa a query string no redirect — causa raiz do #2613 resolvida em 260626;
ver #2457 e #2613).

Seguido de 2 parágrafos fixos (#3219, fonte única em
context/snippets/encerramento-social-apoio.md, compartilhada com o diário):
apoio à curadoria via Apoia.se e convite pra interagir no LinkedIn/Facebook.]
```

**Exemplo negativo (NÃO fazer) — #2794:**

```
DESTAQUE 1 | BRASIL          ← ERRADO: sem negrito, o render não reconhece
                                 como label de seção. O draft inteiro vira um
                                 parágrafo só, sem imagem, sem "O fio condutor".

**DESTAQUE 1 | BRASIL**      ← CORRETO
```

## Limites de caracteres por destaque

Contados do primeiro parágrafo de prosa até o fim do "O fio condutor:", **excluindo** a linha de cabeçalho (`DESTAQUE N | [TEMA]`) e a linha de título:

- **D1**: máximo **1.500 chars**
- **D2** e **D3**: máximo **1.200 chars** cada

## Regras de preenchimento

- **APRESENTAÇÃO (#2913): boilerplate fixo, NUNCA editorial.** Preâmbulo Clarice × diar.ia.br + CTA de prioridade + linha de descadastro — o texto é sempre o mesmo, mês a mês (só o merge tag `{{ unsubscribe }}` varia por envio). Emitir literalmente o texto do bloco acima, sem parafrasear. Links fixos: `[Clarice](https://clarice.ai/?via=diaria)` (2×), `[aqui](https://diaria.beehiiv.com)` (cadastro gratuito — NÃO `diar.ia.br` como href), `[descadastrar aqui]({{ unsubscribe }})`. `diar.ia.br` aparece em **texto plano** (não como link markdown) na primeira frase — o render aplica o wordmark da marca automaticamente (`applyBrandWordmark`) e, na mensal, já o linka pro Beehiiv por conta própria; virar link markdown quebra o wordmark. Gramática: "na Clarice" (não "em Clarice"). Faltou na edição 2606-07 (reinserida manualmente) — daí morar no template.
- **Tema dos destaques**: cobertura específica do mês — Brasil, empresa (Anthropic, OpenAI, Google, DeepSeek), área (regulação, agentes, open source, benchmarks). **Brasil é sempre um dos 3** (regra editorial do `analyst-monthly`).
- **Título narrativo**: descreve o arco do tema, não um artigo isolado. Exemplos: "Brasil acelera regulação de IA em abril", "Anthropic dobra aposta em agentes", "Open source ganha terreno em modelos de raciocínio".
- **Conexão entre artigos**: cada destaque tem N artigos de suporte (de edições diferentes do mês). O texto narra o tema como sequência — use no máximo 2–3 referências temporais por destaque ("no início do mês", "meados de abril", "no final do mês"). Não abra cada frase com "Em X de [mês]". Agrupe eventos por tema, não por cronologia.
- **Links ancorados nos destaques**: cada evento ou dado referenciado usa a sintaxe `[texto âncora](url)` — ex: `o [modelo identificou 27 mil falhas](https://...)`. O fio condutor não recebe links. No Use Melhor e no Radar, o título é a âncora: `[Título](url)`. Os limites de chars (D1: 1.500, D2/D3: 1.200) excluem URLs da contagem.
- **Sem bloco "Para aprofundar"**: não listar URLs ao final de cada destaque.
- **Use Melhor**: 3 tutoriais mais clicados do bucket `use_melhor` das edições diárias do mês (#1902). Vem pronto de `## Use Melhor` em `prioritized.md` (selecionado por `monthly-click-sections.ts`). Formato: `Título URL` + descrição de 1–2 frases abaixo.
- **Radar**: 7 links mais clicados do mês, fora dos já cobertos nos Destaques e no Use Melhor (#1901). Vem pronto de `## Radar` em `prioritized.md`. Formato: `Título URL` + descrição de 1–2 frases abaixo. (Ex-"Outras Notícias", 10 itens por relevância editorial.)
- **É IA? recap**: preferir a edição com poll mais próximo de 50% de acerto (mais ambígua). Se poll não disponível (ver issue #419), escolher a mais visualmente difícil.
- **Boxes de divulgação mid-body (colados manualmente entre destaques, isolados por `---` — não auto-inseridos pelo pipeline, decisão do editor 260716):** (a) **recomendação da edição DIÁRIA pra base da Clarice** — fonte única `context/snippets/diaria-recomendacao-clarice.md`. Audiência = base INATIVA da Clarice que JÁ recebe esta mensal; o box recomenda a diária como upgrade de frequência (cadastro no site), NÃO re-anuncia a parceria (que é a própria mensal) nem presume uso ativo da ferramenta Clarice. CTA "Assinar a edição diária" com `utm_source=clarice`; (b) **box livro** — usar `context/snippets/recomendacao-leitura-mensal.md`, que traz o label de seção `**LIVRO**` (kicker próprio, SEM título interno — o render usa `renderClariceBox` com `noSubtitle`) + título do livro em negrito-com-link + 2 parágrafos impessoais (autor / livro). Instância de referência: 2041/Kai-Fu Lee. (#3581 removeu o sufixo "do mês" do kicker — redundante pro leitor; label longo `LIVRO DO MÊS` segue aceito na detecção por back-compat.) **Não** usar o `livros-divulgacao.md` genérico do diário (kicker "Livros" + imagem promo) nem o `recomendacao-leitura.md` (1ª pessoa, exclusivo do diário). Substituem os boxes improvisados "Um recado rápido da equipe da Clarice" e "LIVROS/Curadoria de livros" da edição 2606-07.

## Diferenças vs template diário (`newsletter.md`)

- 3 opções de **subject line** auto-geradas (em vez de ficar no nível dos destaques).
- Sem "Por que isso importa:" → vira "O fio condutor:" (síntese do tema, não justificativa de pauta).
- **Sem bloco "Para aprofundar"** (diferente de versões anteriores do template).
- Use Melhor e Radar têm **descrição** após título+URL (igual ao diário, diferente de versões anteriores).
- Sem LANÇAMENTOS / PESQUISAS — toda categoria vira tema ou Radar.
- É IA? é recap de uma do mês, não comparação nova.
- Limites de caracteres por destaque (D1: 1.500, D2/D3: 1.200).

## Não fazer (no output gerado)

> Nota: as seções de instrução acima (fora do bloco de código) usam markdown (`**`, listas `-`) como formato de documento — isso não é output gerado. As regras abaixo se aplicam ao texto do draft em `out_path`.

- Não usar markdown (`**`, `#`, `-`, `_`, `>` etc.) no **corpo** da newsletter (parágrafos, título, "O fio condutor:", itens de Use Melhor/Radar). **Exceção obrigatória (#2794): os labels de seção em si (`**ASSUNTO**`, `**DESTAQUE 1 | TEMA**`, `**INTRO**` etc.) SEMPRE levam `**` — não são "corpo", são o delimitador estrutural que o render usa pra fatiar o draft.** Confundir essa regra e tirar o `**` dos labels foi a causa raiz do ciclo 2606-07 (draft inteiro virou 1 parágrafo, zero imagens).
- Não incluir texto fora do template.
- Não adicionar emojis.
- Não mencionar "diar.ia.br" dentro do corpo dos destaques.
- Não inventar conexões — só conectar artigos que de fato cobrem o mesmo tema.
- Não repetir destaques entre temas. Cada artigo de suporte aparece em no máximo um destaque (os que sobram concorrem ao Radar por cliques).
- Não listar "Para aprofundar" com URLs ao final dos destaques.
