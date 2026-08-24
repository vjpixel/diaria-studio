# Template — Newsletter Semanal do LinkedIn (diar.ia.br)

Formato do conteúdo do artigo de longa-forma publicado na newsletter nativa
do LinkedIn ("IA na Semana", perfil pessoal do editor, `/diaria-linkedin-semanal`,
#4456). **Este documento é sobre o que o conteúdo deve conter** — estrutura,
regras de UTM, armadilhas de formato. Para *como colar/publicar* (passo a
passo do editor de artigo, agendamento, verificação de destino), ver
`context/publishers/linkedin.md` §"Newsletter LinkedIn" — não duplicar aquele
conteúdo aqui.

Produzido domingo (janela de conteúdo = segunda a sexta que acabou de
terminar), publicado segunda ~09:30 BRT. Diferente do post comum de feed
(`context/templates/social-linkedin.md`, `## d{N}` do `03-social.md`) — é
outro produto, ver "Sobreposição" no `SKILL.md` da skill.

## Estrutura do artigo

Ordem de montagem (fixa, decisão do editor #4489 — o CTA que fecha o Use
Melhor precisa alcançar quem abandona antes do 3º headline):

```
[Abertura — prosa nova, 1 parágrafo curto: identidade + promessa + cadência]

[CTA de assinatura #1 — "Assinar a edição diária"]

---

1. [Título do headline 1 — LITERAL, só numerado]
[da edição de DD/MM]

[Corpo — 2-4 parágrafos curtos]

Por que isso importa: [1 frase, se houver]

---

2. [Título do headline 2 — LITERAL, só numerado]
[da edição de DD/MM]

[Corpo]

Por que isso importa: [se houver]

---

🛠️ Use melhor  (OPCIONAL — só com comentário do editor, ver abaixo)

[Título do item — literal] ([URL])
[Descrição curta, se houver]

[Comentário do editor — 1-3 frases honestas]

Links para tutoriais e dicas saem em toda edição diária.
[CTA de assinatura #2 — "Quero receber a edição diária →"]

---

3. [Título do headline 3, se houver — LITERAL, só numerado]
[da edição de DD/MM]

[Corpo]

Por que isso importa: [se houver]

---

Edições da semana

- Edição de DD/MM: [destaque 1] · [destaque 2] · [destaque 3]
- [até 5 edições, uma por dia útil da semana com D1 parseável]

---

[Fecho — prosa nova, 1 parágrafo curto antes do CTA final]

[CTA de assinatura #3 — "Assine grátis, é rapidinho →"]
```

**1 a 3 headlines**, nunca mais — semana reduzida (feriado, `editionsFound
< 5`) diminui o cap automaticamente; nunca puxa conteúdo da semana anterior
para completar. Bloco Use Melhor sempre entra depois do 2º headline (ou
depois do último disponível, se houver só 1 ou 0).

## O que preenche cada bloco

- **Headlines**: selecionados por **taxa de clique verificado** entre TODOS
  os destaques/itens de seção da semana (não só D1/D2/D3 — RADAR e USE
  MELHOR competem também). Fonte: `scripts/lib/weekly-linkedin-select.ts`.
  - **Título**: sempre literal, cópia exata do bloco de origem — só a
    numeração ("1.", "2.", "3.") é adicionada. Nunca reescrever, nunca
    linkar (decisão #4456 — "Sem link por destaque": o texto já é o
    conteúdo completo, um link de volta prometeria mais do que existe).
  - **Linha de proveniência** ("da edição de DD/MM", #5109): texto puro, sem
    link — sinaliza de qual das 5 edições da semana o headline veio.
  - **Corpo**: resumo próprio a partir da fonte primária (`textOrigin:
    "autoral"`, #5108) quando a fonte segue acessível — 2-4 parágrafos
    curtos, tamanho comparável a um destaque da diária, nunca cópia literal
    de frases da fonte. Se a fonte ficou inacessível (paywall/removida)
    desde a edição de origem, mantém o corpo LEVANTADO original
    (`textOrigin: "literal"`) em vez de resumir um stub.
  - **"Por que isso importa"**: 1 frase, só quando fizer sentido — omitir o
    parágrafo inteiro se não houver.
- **Use Melhor** (opcional, mas OBRIGATÓRIO renderizar quando há candidato
  elegível **com** comentário do editor — sem comentário honesto, o bloco
  inteiro sai, nunca gerado automaticamente): título/URL/descrição literais
  do item + comentário do editor (1-3 frases) + CTA.
- **Edições da semana**: lista PLANA (nunca `<ul>` aninhada — ver armadilha
  de paste #1 abaixo), uma linha por edição da janela com D1 parseável, link
  para a edição + seus até-3 destaques separados por " · " em texto.
- **Abertura/Fecho**: prosa nova de cada ciclo, escrita pelo editor no gate
  (a skill nunca gera esses textos sozinha) — depois passa por
  `Skill("humanizador")` + `mcp__clarice__correct_text`.

## Regras de UTM

Toda URL de CTA/link carrega o triplo completo + `utm_content` (contrato do
#4456, `scripts/lib/weekly-linkedin-render.ts`):

```
utm_source=linkedin
utm_medium=newsletter
utm_campaign=ln-{cycle}          # {cycle} = {YY}w{WW} da semana de CONTEÚDO
utm_content=mencao-abertura | cta-abertura | lista | cta-usemelhor | cta-fim
```

- `mencao-abertura`: a primeira menção em prosa a `diar.ia.br` DENTRO da
  abertura vira link com este UTM automaticamente (`linkifyWordmark`) — só
  a abertura, não o fecho nem o corpo das manchetes (essas menções, se
  houver, viram auto-link do LinkedIn sem UTM).
- `cta-abertura`, `cta-usemelhor`, `cta-fim`: os 3 convites de assinatura,
  um por terço da peça — existem separados de propósito, pra saber qual
  posição converte.
- `lista`: cada link de "Edições da semana" aponta pra URL derivada do D1
  daquela edição (`deriveEditionUrl`), com este `utm_content`.

Sem UTM próprio por posição, não dá pra saber qual CTA (ou qual edição
listada) de fato gerou o clique — a decisão de manter/cortar um bloco vira
palpite.

## Regra de rótulo de link: nunca termina em domínio nu

`endsInBareDomainLabel()` (`scripts/lib/weekly-linkedin-render.ts`) é o
guard determinístico: se o RÓTULO de um link termina exatamente no domínio
nu (ex: "assine em diar.ia.br"), o auto-linkificador do LinkedIn **parte o
link em dois** e a parte clicável perde o `href`/UTM original. Por isso
todo rótulo gerado por este template é um rótulo de AÇÃO, nunca o domínio
cru — "Assinar a edição diária", "Quero receber a edição diária →", "Assine
grátis, é rapidinho →". A extensão automática do wordmark em prosa
(`linkifyWordmark`) segue a mesma regra: estende a âncora por até 3
palavras além do domínio para não terminar nu; se não conseguir, não linka
(emite warning em vez de publicar um link que parece rastreado e não é).

## As 3 armadilhas de paste (já documentadas em `linkedin.md` §Nota técnica)

Resumo — detalhes completos e exemplos ao vivo (260803) ficam só em
`context/publishers/linkedin.md`, não duplicar aqui:

1. **Lista aninhada é achatada, sem separador.** "Edições da semana" precisa
   ser lista PLANA com separador em TEXTO (" · ") entre os destaques de uma
   mesma edição — o editor do LinkedIn funde `<ul>` dentro de `<li>` num
   bloco corrido sem nada entre os itens.
2. **Link no ÚLTIMO nó colado perde a âncora.** O render precisa terminar
   com um parágrafo de sentinela depois do último link, nunca com o link
   como nó final do HTML colado.
3. **Âncora que termina em domínio nu tem o `href` sequestrado** no paste
   — mesma regra da seção UTM acima, mas o efeito é mais agressivo no
   paste (reescreve pra `http://diar.ia.br` cru, perdendo toda a UTM).

## Convenção de storage

```
data/weekly/{cycle}/
  _internal/ln-selection.json   seleção completa + auditoria + textOrigin por headline
  _internal/ln-fact-check.json  claims verificados do texto autoral (se houver)
  ln-{cycle}.html                artefato colável final (fragmento HTML, sem <html>/<body>)
  ln-{cycle}.json                 metadados do render + warnings
```

`{cycle}` é sempre `{YY}w{WW}` derivado da semana de CONTEÚDO (segunda a
sexta), não da segunda de publicação — usado tanto como namespace de
diretório quanto como `utm_campaign`.

## Não fazer

- Não reescrever o título de um headline — literal, só numerado.
- Não linkar o corpo de um headline de volta pra edição de origem (regra
  "sem link por destaque", #4456).
- Não gerar o bloco Use Melhor sem comentário do editor.
- Não aninhar lista em "Edições da semana".
- Não terminar um rótulo de link no domínio nu.
- Não pular a linha de proveniência ("da edição de DD/MM") dos headlines.
