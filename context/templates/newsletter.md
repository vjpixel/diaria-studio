# Template — Edição diar.ia.br

Formato exato do output da edição. Seguir rigorosamente.

**Importante (#245, #334):** sempre uma linha em branco entre qualquer elemento — header, título, URL, parágrafo. Isso vale tanto nos blocos DESTAQUE quanto nas seções secundárias (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS). Sem linhas em branco, viewers markdown (ex: GitHub) colapsam tudo em parágrafo único ilegível. **Exceção (#3821):** dentro de cada ITEM das seções secundárias, título (link) e descrição ficam em linhas ADJACENTES, sem blank line entre elas — a blank line separa ITENS entre si, não título de descrição dentro do mesmo item. O parser (`parseListItems` em `scripts/lib/newsletter-parse.ts`) depende dessa distinção: com blank line ali, cada linha vira um item quebrado sem URL.

**Formato URL (#599 — atualizado):** URL fica **embedada no próprio título via markdown link** `[Título](URL)` em vez de linha solo separada. Aplica-se tanto a destaques (cada uma das 3 opções) quanto a seções secundárias (cada item). Vantagem: menos ruído visual, título vira CTA clicável, mobile-friendly. Parsers aceitam ambos os formatos (legacy URL solo + inline) durante a transição.

**Linha de cobertura (#592, #609):** primeira linha do reviewed.md, formato literal copiado de `_internal/01-approved.json` campo `coverage.line`. Padrão esperado:

**Negrito em headers/títulos (#590):** nomes de seção e títulos saem em **negrito** (`**...**`) para hierarquia visual no review (mobile). URLs e parágrafos seguem plain. Markdown link `[Título](URL)` é compatível com bold via `**[Título](URL)**`.

```
Para esta edição, eu (o editor) enviei X submissões e a diar.ia.br encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter.

---

**DESTAQUE 1 | [CATEGORIA]**

**[Opção de título 1 — máx. 52 chars](URL)**

**[Opção de título 2 — máx. 52 chars](URL)**

**[Opção de título 3 — máx. 52 chars](URL)**

[Parágrafo 1 — abre a história]

[Parágrafo 2 — desenvolve contexto]

[Parágrafo 3 — dados/atores relevantes]

[Parágrafo 4 — fecha com consequência concreta]

Por que isso importa:

[1 parágrafo — impacto prático para o público diar.ia.br]

Aprofunde:

* [Título do artigo](URL) - Fonte
* [Título do artigo](URL) - Fonte

---

**DESTAQUE 2 | [CATEGORIA]**

[mesmo formato]

---

**DESTAQUE 3 | [CATEGORIA]**

[mesmo formato]

---

**🛠️ USE MELHOR** (opcional, #1568 — omitir bloco inteiro se editor não selecionou candidato no gate. Posição #1633: antes de LANÇAMENTOS; #3820: É IA? entra logo depois deste bloco, injetada separadamente pelo orchestrator — não faz parte deste template)

**[Título acionável do item](URL)**
[Frase descritiva curta em 1 linha — ferramenta/técnica, tempo estimado entre parênteses. #1634: título no idioma original, nunca traduzir]

---

**📺 VÍDEOS** (opcional — omitir se bucket vazio. #3820: reordenada pra antes de LANÇAMENTOS, ordem alvo USE MELHOR → É IA? → VÍDEOS → LANÇAMENTOS → RADAR)

**[Título do Vídeo](URL_DO_VÍDEO)**
Nome do Canal — [Frase descritiva em 1 linha]

---

**🚀 LANÇAMENTOS**

**[Título do item](URL)**
[Frase descritiva em 1 linha]

**[Título do próximo item](URL)**
[Frase descritiva]

---

**📡 RADAR**

[mesmo formato de Lançamentos — título e descrição em linhas adjacentes (sem blank line entre elas), blank line só entre items. Aqui caem todos os itens secundários que não viraram destaque: notícias, opiniões e papers/pesquisas.]

---

**ERRO INTENCIONAL**

Na última edição, {prev_narrative}.

Nessa edição, {curr_narrative}.

---

**🎁 SORTEIO**

Você presta atenção ao conteúdo gerado por IA que consome? Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição.

**Responda indicando qual é o erro, ou se não há nenhum, e receba um número para concorrer a uma caneca da diar.ia.br, a ser sorteada mês que vem.** Sua resposta deve chegar até mim antes do envio da edição seguinte.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria) para ganhar recompensas como **artigo especial do mês**, **sorteios** e **acesso antecipado a novos projetos**.

Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

- [Cursos](https://cursos.diar.ia.br?utm_source=newsletter&utm_medium=email&utm_campaign=cursos-rodape)
- [Livros](https://livros.diar.ia.br?utm_source=newsletter&utm_medium=email&utm_campaign=livros-rodape)
- [Equipamentos](https://www.amazon.com.br/shop/vjpixel)
- [Arquivo](https://arquivo.diar.ia.br?utm_source=newsletter&utm_medium=email&utm_campaign=arquivo-rodape)

Para acompanhar as 3 principais notícias de IA todos os dias, siga a **diar.ia.br** no [LinkedIn](https://www.linkedin.com/company/diar.ia.br/), [Instagram](https://www.instagram.com/diar.ia.br), [Threads](https://www.threads.net/@diar.ia.br), [Facebook](https://www.facebook.com/diar.ia.br) ou [X](https://x.com/diariabr).
```

**Seções 🎁 SORTEIO + 🙋🏼‍♀️ PARA ENCERRAR (#1076):** copiadas literalmente do template Beehiiv original. O label "Acesse nossas curadorias:" acima da lista de pills **não** é escrito no markdown — o render (`newsletter-render-html.ts`) gera esse label sozinho ao detectar a lista de links nessa posição; um label manual duplicaria o texto. Render parseia os blocos como kicker + parágrafos + pills, sem boxes. Pixel pediu "no reviewed" (#1076) pra ter visibilidade + edição fácil em vez de hardcoded no script. `render-newsletter-html.ts` graceful — se algum bloco ausente, omite na renderização (não falha).

**PARA ENCERRAR — o que é editável e o que é bloco fixo (#3219/#4413/#4411/#4357):** só o parágrafo de apoio (Apoia.se) + créditos de ferramentas é editável por edição — vem de `context/snippets/encerramento-social-apoio.md` (via painel Caixas do Studio, `platform.config.json` → `para_encerrar.slot_a`), injetado por `scripts/stitch-newsletter.ts`. A lista de pills "Acesse nossas curadorias" (`CURADORIA_PILLS`) e o convite social final (`SOCIAL_INVITE`) são blocos FIXOS, definidos em `scripts/lib/shared/encerramento-snippet.ts` e compartilhados verbatim com o mensal (`writer-monthly` cita as mesmas constantes literalmente no prompt) — não são mais editáveis por edição (decisão do editor, 260801, #4413: o texto do convite social tinha 5 variantes divergentes entre diário/mensal/config/docs; um bloco fixo elimina o drift). Editar o texto/link de qualquer uma das 3 peças só pela fonte única correspondente; nunca duplicar em `stitch-newsletter.ts` nem noutro lugar.

**Seção ERRO INTENCIONAL (#911 / #1079):** cada edição contém 1 erro proposital. Esta seção fecha o loop entre edições com duas frases narrativas curtas — sem convite ao concurso, sem "Responda este e-mail...". É confissão direta:

- `Na última edição, {prev_narrative}.` — revela o erro da edição anterior em forma narrativa ("coloquei X onde deveria ser Y", "escrevi X mas o correto era Y", etc).
- `Nessa edição, {curr_narrative}.` — declara o erro desta edição em forma narrativa ("eu disse X, mas Y é o correto", "afirmei X quando deveria ser Y", etc).

**Regra HTML/Beehiiv (#1079):** **o erro da edição corrente NUNCA aparece no HTML enviado aos leitores.** O HTML só mostra `Na última edição, …` (reveal anterior) dentro do bloco 🎁 SORTEIO. A linha `Nessa edição, …` vive APENAS no `02-reviewed.md` — funciona como diário interno + source-of-truth pra próxima edição extrair. Razão: o erro precisa ser descoberto pelo leitor; revelá-lo na própria edição mata o jogo.

O autor escreve `{curr_narrative}` manualmente no `02-reviewed.md` da edição corrente. O script `scripts/render-erro-intencional.ts` lê o `02-reviewed.md` da edição anterior, extrai a linha `Nessa edição, …` e renderiza como `Na última edição, …` na edição corrente. Fallback: `data/intentional-errors.jsonl` quando o MD anterior não tem a linha. Tom é de auto-zoeira editorial, não de competição — sorteio do mês ainda acontece via o bloco SORTEIO no template Beehiiv, separado dessa seção.

URL embedada no título (#599): editor poda 2 das 3 opções no gate de Etapa 2, sobrando 1 título-com-URL. Todas as 3 opções pré-gate apontam pra **mesma URL canônica** (são variantes do mesmo título do mesmo artigo).

**Formato de item da seção VÍDEOS (#3821 — corrigido):** o parser real (`parseListItems`/`parseSections` em `scripts/lib/newsletter-parse.ts`, usado pelo render HTML) só reconhece um item quando a PRIMEIRA linha do bloco é um único link markdown `[Título](URL)` — nunca 2 pares `[texto](...)` na mesma linha. O formato anterior do template (`**[Título]** — [Canal](URL)`, com o título sem URL própria) não batia em nenhum branch do parser e degradava pro fallback legado (cada linha virava um item quebrado, `url: ""`, sem link nenhum no HTML final). Formato correto: **link único pro vídeo no título**, canal entra como PREFIXO em texto plano dentro da descrição (sem link próprio), e título + descrição ficam em linhas **ADJACENTES** — sem blank line entre elas (blank line separa ITEMS entre si, não título de descrição dentro do mesmo item). Mesma convenção de LANÇAMENTOS/RADAR/USE MELHOR (ver `writer.md` passo 4) — o parser depende disso pra não confundir a linha de descrição com um novo item.

**Bloco "Aprofunde:" (#3920) — OPCIONAL, só quando há cluster same-story.** Quando várias fontes cobrem a MESMA história, o dedup preserva as fontes extras em `cluster_sources[]` do destaque (o link-título aponta pro artigo MAIS COMPLETO; ver `scripts/lib/cluster-sources.ts`). O writer então emite, logo APÓS o parágrafo "Por que isso importa:", um bloco `Aprofunde:` listando TODAS as fontes do cluster (o primário também aparece — decisão do editor). Cada item é `* [Título do artigo](URL) - Fonte`. Regras: só existe quando o destaque tem `cluster_sources` (destaque de fonte única = sem bloco, idêntico ao de hoje); vem sempre depois do "Por que isso importa"; NÃO conta no char-limit do destaque (o parser separa o bloco do `why`). Render: `renderAprofundeInner` (kicker "APROFUNDE" + lista de links, `scripts/lib/newsletter-render-html.ts`). Lint: `--check aprofunde-format`.

## Regras de preenchimento

- CATEGORIA dos destaques: label editorial específico ao conteúdo do artigo, em caps, com emoji prefix (#265). Não usar o genérico `NOTÍCIA` — escolher um que descreva o ângulo real da história. Tabela de emojis canônicos:
  | Categoria | Emoji | Categoria | Emoji |
  |---|---|---|---|
  | LANÇAMENTO | 🚀 | PRODUTO | 📦 |
  | FERRAMENTA | 🛠️ | PESQUISA | 🔬 |
  | MERCADO | 💼 | INDÚSTRIA | 🏭 |
  | TENDÊNCIA | 📈 | CONCEITO | 💡 |
  | CULTURA | 🎭 | BRASIL | 🇧🇷 |
  | OPINIÃO | 💬 | DADOS | 📊 |
  | REGULAÇÃO | ⚖️ | PRODUTO | 📦 |
  Exemplo: `DESTAQUE 1 | 🚀 LANÇAMENTO`. Para categorias não listadas, escolher emoji semanticamente próximo.
  Se nenhum se encaixar bem, criar uma nova categoria com emoji adequado.
- Ordenar destaques por relevância editorial (scorer decide).
- LANÇAMENTOS: itens da categoria `ferramenta` que não viraram destaque.
- RADAR (#1569): itens das categorias `noticia`/`opiniao`/`pesquisa` que não viraram destaque. Substituiu OUTRAS NOTÍCIAS + PESQUISAS — papers ainda entram no pipeline, só não têm seção dedicada.
- Se uma seção não tiver itens, omitir a seção inteira (incluindo o cabeçalho).

## Não fazer

- Não usar markdown em parágrafos. **Negrito (`**...**`) só é permitido em** nomes de seção (`**LANÇAMENTOS**`, `**DESTAQUE N**`) e títulos (#590). Outros markups (`#`, `-`, `_`, `>`) sempre proibidos.
- Não incluir texto fora do template.
- Não adicionar emojis no corpo do texto — apenas o emoji de categoria no header `DESTAQUE N | emoji CATEGORIA` é permitido (#265).
- Não mencionar "diar.ia.br" dentro do corpo dos destaques (é redundante).

## Bloco encaminhável por WhatsApp (#4486, posição/conteúdo revisados em #4570)

Bloco fixo, gerado deterministicamente (TS puro, sem LLM/gate — `renderWhatsappShare` em `scripts/lib/newsletter-render-html.ts`) a partir do D1 do dia + `AAMMDD` da edição. **Nunca aparece em `02-reviewed.md`** — diferente de SORTEIO/PARA ENCERRAR (que SÃO texto literal no markdown, stitchados por `stitch-newsletter.ts`), este bloco é injetado só no HTML final, **ENTRE D1 e D2** (pedido explícito do editor na revisão da edição 260804: "deixe o box de whatsapp permanente entre d1 e d2 até que eu peça para mudar" — posição antiga era entre o reveal do ERRO INTENCIONAL e o kicker "Para encerrar"). Conteúdo (#4570 reduziu ao mínimo — "nenhum texto além da URL da edição"): manchete do D1 **sem emoji** + URL da própria edição (`diar.ia.br/p/{seoSlug(D1)}`, com UTM `utm_source=whatsapp&utm_medium=share&utm_campaign={AAMMDD}` — mantida por decisão do coordenador, preserva atribuição de assinante novo) + botão **preenchido** "Compartilhar no WhatsApp" (`wa.me/?text=`, texto pré-preenchido URL-encoded). Editar o texto/wording só pela fonte única (`renderWhatsappShare`/`buildWhatsappShareBlock`) — nunca por edição.

**Dependência dura do slug do post (#4570):** a URL prevê `seoSlug(título do D1)` — se o slug REAL do post na Beehiiv divergir (a auto-derivação mangla acentos PT-BR, #1989, e não pode ser corrigida via API em plano não-Enterprise, #3449), o link do bloco já enviado no e-mail aponta pra 404. Ver `scripts/check-whatsapp-slug-guard.ts` (guard que bloqueia o Stage 6 até o editor corrigir o slug manualmente) e `context/publishers/beehiiv-playbook.md` §4a-bis/§9.

## Auditoria de encaminhamento — classificação de blocos (#4487)

Toda edição pode ser encaminhada (WhatsApp, e-mail) pra quem nunca assinou. Auditoria completa do template com a pergunta "isso faz sentido pra quem nunca leu a diária?" — cada bloco classificado em **autocontido** (funciona sem contexto), **condicional** (só faz sentido em certos canais/públicos) ou **aceito** (fica como está — custo de reescrever > benefício).

| Bloco | Classificação | Nota |
|---|---|---|
| Linha de cobertura (intro) | Autocontido | Menciona "diar.ia.br" e a mecânica de curadoria — não pressupõe assinatura prévia. |
| DESTAQUE 1-3 | Autocontido | Notícia completa, com contexto próprio (parágrafos de abertura/desenvolvimento). |
| USE MELHOR | Autocontido | Dica de ferramenta, standalone. |
| **É IA?** — painel de voto | Autocontido | Mecânica do jogo explicada na própria pergunta ("Clique na imagem que foi gerada por IA"). Link de voto usa token opaco por assinante desde #4487 (item 1 do critério de pronto) — quem recebe encaminhado não herda mais a identidade do remetente nem vê o e-mail dele na URL. |
| **É IA?** — "Resultado da última edição: X% acertaram" | **Aceito** | Referência explícita à edição anterior. Resolver custaria reescrever a mecânica de reveal (#1630/#3220) pra um formato sem histórico — desproporcional pro ganho (linha secundária, 1 frase, não quebra a leitura do resto do painel). |
| VÍDEOS | Autocontido | Item standalone (título + canal + descrição). |
| LANÇAMENTOS / RADAR | Autocontido | Itens secundários, cada um com título + descrição própria. |
| **ERRO INTENCIONAL** ("Na última edição, {prev_narrative}.") | **Aceito** | Depende inteiramente de contexto de edições anteriores (mecânica do concurso, #911/#1079) — inescapável pela própria natureza do jogo. Conteúdo de baixo volume (2 frases) — reescrever pra ser autocontido descaracterizaria a mecânica. |
| **SORTEIO** (convite ao concurso) | **Aceito** | Mesma mecânica do erro intencional acima — o convite ("responda e concorra") só faz sentido pra quem já recebe a newsletter regularmente. |
| **Bloco WhatsApp** (#4486/#4570, ver seção acima) | Autocontido | Manchete + link — mínimo suficiente pra quem recebe encaminhado entender do que se trata e abrir a edição. Desde #4570 não tem mais explicação do que é a diar.ia.br nem CTA de assinatura direto (ver nota abaixo). |
| **PARA ENCERRAR** (CTA de apoio, cupons, créditos, convite social) | **Aceito** | Fala com quem já acompanha (CTA de apoio recorrente, cupons de afiliado). Decisão do editor preservada — já era assim antes do #4487, não é regressão introduzida por esta auditoria. |

**Convite de assinatura visível sem depender do rodapé:** item do critério de pronto do #4487 — até #4570 era satisfeito diretamente pelo bloco WhatsApp (CTA de assinatura embutido no CORPO). Desde #4570 (pedido do editor: "nenhum texto além da URL da edição") o bloco deixou de conter esse CTA direto — o convite sobrevive INDIRETO, via o formulário de assinatura que a própria página pública da edição (`diar.ia.br/p/...`) tem. Não é uma regressão fechada com certeza — reabrir com o editor se o volume de assinatura via encaminhamento cair perceptivelmente após #4570.

**Itens em aberto (#4487), não resolvidos por esta auditoria — decisão editorial pendente:** (1) cabeçalho de 1 linha explicando o que é a diária pra quem não veio da lista (e se dá pra detectar isso); (2) tratamento diferenciado pra versão web (pra onde o encaminhamento tende a levar); (3) como medir encaminhamento de fato (sem rastro direto — a proxy mais próxima é assinante novo chegando sem UTM numa página de edição específica). Ver comentário em #4487 no GitHub.
