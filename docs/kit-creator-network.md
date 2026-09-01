# Kit Creator Network — estado e decisões

> **Status: NO AR desde 01/09/2026** — perfil publicado, 3 criadores curados e a página de
> recomendações servindo na navegação de `diariabr.kit.com`. O setup inicial foi feito pelo
> editor em 28/08/2026 (https://app.kit.com/creator-network/setup); a sessão
> `/diaria-develop` 260901 completou o perfil, curou a lista e ligou a exibição.
> Issue guarda-chuva: **#6674**. Este doc é o registro vivo do canal — atualizar aqui quando
> a lista de criadores recomendados ou o estado do slot mudar.

O **Creator Network** da Kit é a rede de recomendação cruzada entre newsletters: outras
publicações recomendam a diar.ia.br no funil delas, e (opcionalmente) nós recomendamos
outras no nosso. É canal de aquisição **sem custo recorrente** — não gasta crédito de API
nem mídia paga —, o que o coloca no topo da ordem de preferência do projeto
(`CLAUDE.md` → "Zero custo recorrente").

---

## Decisões do editor (28/08/2026)

| # | Decisão | Valor |
|---|---|---|
| 1 | Opt-in na rede | **Sim** — feito na UI pelo editor |
| 2 | Exibir recomendações de terceiros no NOSSO funil | **Sim** |
| 3 | Curadoria dos criadores que recomendamos | **Manual, item a item** — o editor escolhe; não aceitamos a curadoria automática da Kit |
| 4 | Onde registrar o estado | Este doc |

A decisão 2 é um trade-off editorial genuíno (recomendar terceiros custa atenção do leitor
recém-inscrito) e foi levada ao editor em vez de assumida. A 3 é o que a torna aceitável:
reciprocidade sim, mas com a nossa marca só ao lado do que passou pelo mesmo critério
editorial das fontes — público BR, tema compatível, sem infoproduto/growth-hacking.

---

## Estado do canal

| Item | Estado | Última verificação |
|---|---|---|
| Perfil da publicação na rede | ✅ publicado (`profile.id 2671682`) | 01/09/2026 |
| Opt-in na rede | ✅ `recommendations_active: true` | 01/09/2026 |
| Criadores que RECOMENDAMOS | ✅ 3 curados (ver abaixo) | 01/09/2026 |
| Quem NOS recomenda | ⬜ ninguém ainda (Incoming zerado) | 01/09/2026 |
| Slot de exibição no nosso funil | ✅ ligado — **cobre só parte do funil**, ver ressalva | 01/09/2026 |
| Atribuição de origem nos assinantes novos | ⬜ não verificado | — |

---

### ⚠️ Ressalva técnica: o nosso cadastro não passa pelo formulário nativo da Kit

> **Parcialmente resolvida em 01/09/2026** — ver "Onde está exibido" abaixo. O
> `/subscribe` do site *passa* pela página hospedada; os 3 workers, não. A ressalva
> original segue valendo para eles, e por isso fica registrada na íntegra.

Os 3 workers de assinatura cadastram via `POST /v4/subscribers` (#6339), **não** pelo
formulário hospedado da Kit. Isso já é conhecido por outro motivo — é a razão de
`publishing.newsletter.subscriber_backend` continuar em `beehiiv`: a atribuição nativa
(`KitSubscriberAttribution`) só é populada por quem entra pelo formulário nativo
(#6425 Parte A).

Consequência para este canal: a tela "recommended by" da Kit é parte do fluxo do
formulário/landing hospedado. Onde o nosso cadastro não passa por lá, ligar a exibição
na conta não produz efeito no funil real. Dois desdobramentos, e em 01/09 o segundo se
confirmou parcialmente:

- **Se a exibição exigir o formulário nativo** — a decisão 2 fica pendente de uma mudança
  de funil (rotear parte do cadastro pelo form da Kit), que é decisão à parte e não estava
  no escopo da pergunta feita ao editor. **É o caso dos 3 workers.**
- **Se houver snippet/embed independente** — dá pra montar no nosso próprio pós-inscrição
  sem tocar no fluxo de cadastro. **Não foi necessário para o `/subscribe`**, que já
  aterrissa na página hospedada.

### ⚠️ O backend de ENVIO está na Beehiiv, não na Kit

Desde 28/08/2026 o envio da diária voltou pra Beehiiv por incidente de entregabilidade no
Gmail (`platform.config.json` → `publishing.newsletter.backend_note`). Isso **não** bloqueia
o Creator Network — a rede opera sobre o perfil/formulários da publicação na Kit, não sobre
de onde a edição é disparada —, mas significa que assinante captado pela rede entra numa
conta que hoje não é a que envia. A rampa `kit_diaria` (`audience_tag: rampa-kit`) é o
mecanismo que move gente pro envio via Kit; assinante novo vindo da rede precisa cair num
dos dois lados de forma explícita, nunca em nenhum.

---

## O que foi feito em 01/09/2026

Sessão `/diaria-develop` 260901, máquina `Neo` (Chrome logado).

### Perfil

| campo | valor |
|---|---|
| `profile.id` | `2671682` |
| perfil público | `https://diariabr.kit.com/profile` |
| página de recomendações | `https://diariabr.kit.com/profile/recommendations` |
| Creator type | Journalist, Educator — *a UI confirmou a remoção de "Blogger", mas uma leitura posterior da API ainda devolveu os 3; ver Pendências* |
| Topics | Artificial Intelligence, Science, Technology |
| Location | Brasília, Distrito Federal, BR |
| Contato | `oi@news.diar.ia.br`, visibilidade `upon_request` |

**Bio** (246 chars; o campo aceita 100–300), em português:

> Newsletter diária brasileira sobre inteligência artificial: 5 minutos diários pra se
> manter atualizado e usar melhor as IAs. Curadoria em português das notícias, lançamentos
> e ferramentas que importam, para quem trabalha com tecnologia no Brasil.

A bio auto-gerada pela Kit era um template em inglês ("I'm a blogger, journalist, and
educator who loves to talk about...") e foi substituída. O **avatar** foi rasterizado do
favicon SVG do apex em PNG 1000×1000 — a Kit **exige** foto de perfil pra concluir o wizard,
o passo trava sem ela. "News & Politics" foi deliberadamente NÃO marcado nos topics: o filtro
casa quem nos recomenda, e traria correspondência política fora do nosso eixo.

### O que a decisão 3 (curadoria manual) exigiu desligar

A Kit sai do wizard empurrando o oposto da decisão 3, em dois lugares:

- **`enable_on_new_forms` vinha `true`** — auto-pilot: todo formulário/landing page novo
  passaria a exibir recomendações sem decisão nossa. Virou **`false`**.
- **5 sugestões automáticas** (The Rocket Report, Orbital Momentum, Deni Husni Fahri Rizal,
  Market Flux, Teachix — inglês, fora de tema) com um botão "Recommend all" de um clique.
  **Todas recusadas.**

`paid_recommendations_enabled: false`, `paid_recommendations_auto_pilot: false` (recomendação
paga é outro produto, fora do escopo desta decisão). `blocked_creators: []`.

### Quem recomendamos

Critério aplicado sobre a decisão 3: português, tema adjacente, e **não substituto direto** —
newsletter que entrega a mesma coisa que a diar.ia.br entrega não vai pra frente de um leitor
que acabou de se inscrever na nossa.

| newsletter | por quê |
|---|---|
| **Automação Sem Fronteiras** | IA aplicada a dinheiro, negócios e produtividade. Aprofunda o "usar melhor as IAs" sem repetir a curadoria de notícias. |
| **Yanz** | Engenheiro de software; IA, dev e build-in-public. Sobrepõe em formato, mas o público é mais estreito (devs). |
| **Productfy** | Ciência por trás de produtos digitais. Sem sobreposição de formato nem de tema. |

**Recusado: `O Corre da IA`** — "Todos os dias, filtramos as principais notícias de
inteligência artificial no mundo (...) Leitura de poucos minutos, todo santo dia." É o mesmo
produto. A rede é recíproca e recomendar mutuamente faz as duas listas crescerem (a Kit
anuncia ~2×), mas entregar um substituto do mesmo formato ao leitor recém-inscrito foi
considerado custo maior que o ganho.

Os 3 foram achados pelo Discover **com o filtro de idioma em "Portuguese"** — sem o filtro,
o Discover devolvia só resultado em inglês.

### Onde está exibido — e o que isso NÃO cobre

O toggle é **Newsletter site → Pages → Recommendations → `Show Recommendations`**, que nasce
**off**. Ligado + `Publish`. Verificado sem autenticação depois: `https://diariabr.kit.com`
tem "Recommendations" na navegação, apontando pra `/profile/recommendations`, e essa página
serve **exatamente os 3 curados** — zero do pool Smart (nenhum Rocket Report, Market Flux,
Teachix ou Orbital) e zero de O Corre da IA. O aviso do builder ("We will use Smart
Recommendations to show the most relevant creators to your readers") é copy de estado vazio,
não o comportamento com curadoria presente; foi conferido **antes** de publicar, porque
publicar o pool automático seria o oposto da decisão 3.

**A ressalva técnica acima continua valendo, e é o que limita o alcance disto.** A página que
ganhou as recomendações é a hospedada da Kit — a mesma pra onde `/subscribe` redireciona
(`diar-ia-br.kit.com` → 301 → `diariabr.kit.com`), e que recebe cadastro real com atribuição
própria (`ATRIBUICAO_FONTE_KIT_NATIVO_FORM = "kit-nativo-form"`,
`scripts/lib/kit-attribution.ts`). Mas os **3 workers continuam cadastrando via
`POST /v4/subscribers`** (#6339) e **nunca passam por ela**:

| caminho de cadastro | vê as recomendações? |
|---|---|
| `/subscribe` no site → página hospedada da Kit | **sim** |
| workers (`arquivo.`, `livros.`, `cursos.`) via API | **não** |

A decisão 2 está implementada **para uma fatia do funil, não para ele inteiro**. Levar as
recomendações ao resto exigiria rotear mais cadastro pelo form nativo — mudança de funil,
decisão à parte, fora do escopo do que foi perguntado ao editor.

### `enabled_forms_count` continua 0 — e isso não significa "ninguém vê"

O painel `app.kit.com/forms` está em empty-state e o modal "Select where to show
recommendations" abre com tabela vazia: os dois contam **formulários e landing pages** e
ignoram o Newsletter site. As 3 entradas que `list_forms` devolve são geradas pelo sistema:

| id | nome | criado | assinantes | o que é |
|---|---|---|---|---|
| 9870650 | Creator Network | 01/09/2026 | 0 | criado pelo próprio wizard nesta sessão |
| 9848182 | Clare form | 26/08/2026 | 0 | arquivado |
| 9839463 | Newsletter site | 24/08/2026 | 20 | gerado pelo sistema; `/forms/9839463/edit` dá **404** |

### Correção de rota registrada

Uma leitura intermediária desta sessão concluiu que nada podia ir ao ar porque "o apex é
servido pela Beehiiv" e que o destravamento viria com a **#467**. As duas coisas são falsas:
a **#467 está CLOSED desde 28/08/2026** e seu título é *"cutover do apex diar.ia.br → Worker
próprio (Kit fica só com o e-mail)"* — resolução oposta a um cutover pra Kit. O erro veio de
apoiar-se numa memória de 12/08 (pré-cutover) sem conferir contra `docs/apex-cutover-rollback.md`
e `docs/apex-cutover-status-5125.md`, já no repo. Fica registrado porque o modo de falha é o
`guard-defasado-concorda-com-sujeito-defasado`: checar HEAD antes de tratar como fato.

---

## Como medir

Sem atribuição, o canal fica invisível na contabilidade de CAC/leitor
(`scripts/lib/cac.ts`, `scripts/lib/leitor.ts`). A verificar via API/MCP `kit`:

1. Se o assinante criado pela rede carrega origem identificável (`attribution`, tag, ou
   campo equivalente) — e qual o valor exato.
2. Se sim, incluir o canal na agregação por UTM/origem já consumida pelo Studio
   (`scripts/count-subscriptions-by-utm.ts` → `studio-ui/studio-utms.ts`).

Enquanto (1) não for respondido, qualquer número atribuído à rede é estimativa, não medição —
tratar como tal em relatório.

**Fonte disponível hoje, sem depender de (1):** a própria aba Recommendations
(`app.kit.com/creator-network`) tem painel partido em **Incoming** (quem nos recomendou →
quantos assinantes vieram) e **Outgoing** (quem recomendamos → quantos saíram), com
`Creators`, `Views`, `Subscribers` e `Conversion rate`. Baseline em 01/09/2026: **tudo zero
nos dois lados** — esperado, o perfil nasceu no dia. Recomendação da rede **não** passa por
`utm_source`, então o canal segue invisível no relatório que cruza UTMs; este painel é lido
à mão até (1) ser respondido.

---

## Pendências

- [ ] Responder (1) acima: a API/MCP `kit` expõe origem `creator_network` por assinante?
- [ ] Medir o painel Outgoing daqui a algumas semanas — a página converte, ou é só um item
      de navegação que ninguém clica?
- [ ] Decidir se vale rotear mais cadastro pelo form nativo, pra que a decisão 2 alcance o
      funil inteiro e não só `/subscribe` (mudança de funil, decisão à parte).
- [ ] Reavaliar `O Corre da IA` se/quando a reciprocidade da rede mostrar ganho medido — a
      recusa é decisão editorial, não permanente.
- [ ] `creator_types_value` devolveu `["Blogger","Journalist","Educator"]` numa leitura da
      API posterior à remoção de "Blogger" pela UI (que respondeu "Settings successfully
      updated"). Reconferir; pode ser cache de leitura.

