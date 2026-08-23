# Playbook: apoia.se (post de anúncio do Artigo Especial)

Roteiro semântico para o TOP-LEVEL (nunca um subagente — só o top-level tem
`mcp__claude-in-chrome__*`) operar o painel de posts da campanha apoia.se via
Claude in Chrome, no Passo 2 da skill `/diaria-artigo-especial` (#5979).
Documento vivo — atualize quando a UI mudar.

## Por que isto existe (e por que é diferente dos outros playbooks desta pasta)

A apoia.se **não tem API de publicação de post** — `scripts/lib/apoia-se.ts`
documenta a API pública inteira (1 único endpoint, consulta de status de
pagamento por e-mail: `GET /backers/charges/<email>`). Publicar um post de
atualização pra quem apoia a campanha só existe via UI, então — como
Beehiiv/LinkedIn/Facebook — é Claude in Chrome com o editor logado.

**Diferença real em relação a `linkedin.md`/`facebook.md`: o DOM do painel
apoia.se AINDA NÃO ESTÁ MAPEADO neste repo.** Nenhuma sessão anterior operou
esse painel via automação — os seletores/fluxo abaixo são a MELHOR HIPÓTESE
a partir do que se sabe publicamente da plataforma, não uma sequência
validada ao vivo. A 1ª execução real do Passo 2 da skill precisa do editor
presente (é por isso que a issue marca a skill inteira como `windows` →
Develop, não Overnight): quem rodar pela primeira vez deve **mapear o fluxo
real e substituir as seções abaixo** por passos confirmados, com seletores
concretos — mesmo padrão vivo que `linkedin.md`/`beehiiv-playbook.md` já
seguem para as respectivas plataformas.

## O que já se sabe (confirmado)

- URL pública da campanha (o que os apoiadores veem, e a URL que
  `scripts/lib/apoia-se.ts` referencia via `APOIA_SE_CAMPAIGN=diaria`):
  `https://apoia.se/diaria`.
- Pré-condição: o editor logado no Chrome com a conta de CRIADOR da campanha
  (não a de apoiador/leitor) — é essa conta que tem acesso ao painel de
  posts/atualizações.
- O post do Passo 2 é um **teaser público** (decisão do editor, 23/08/2026,
  issue #5979): título + 2-3 parágrafos de abertura (reaproveitados do
  artigo, `leadParagraphs` de `scripts/lib/artigo-especial-meta.ts`) + link
  pra `especial.diar.ia.br/{ano}/{slug}/`. Não é o texto integral do artigo,
  nem o conteúdo do paywall `artigo.diar.ia.br` (`workers/artigo-mensal`,
  canal separado). Visibilidade default: **público** — o teaser e o artigo
  são ambos públicos (só a flag `--apoiase-visibility backers`, se um dia
  for pedida, restringiria a apoiadores — não implementar antes do pedido).

## O que falta mapear (fazer na 1ª execução real, com o editor)

1. **Ponto de entrada do painel de criador.** Hipótese: `apoia.se` →
   login → algum link tipo "Painel"/"Dashboard"/"Minha campanha" no menu do
   usuário logado, levando a uma URL própria de gestão (padrão comum em
   plataformas de crowdfunding recorrente é algo como
   `apoia.se/dashboard/diaria` ou `apoia.se/admin`, mas **não confirmado**).
2. **Onde ficam os posts/atualizações.** Toda plataforma de assinatura tem
   uma seção "Posts"/"Atualizações"/"Novidades" (visível pros apoiadores na
   página da campanha, ex: uma aba "Posts" em `apoia.se/diaria`) com um botão
   de criar novo — localizar o botão/rota exata no painel de criador.
3. **Campos do editor de post**: título (se houver campo separado do corpo,
   diferente do LinkedIn/Facebook que não têm), corpo (rich text ou
   markdown?), visibilidade (público vs. só-apoiadores — confirmar o nome
   exato do controle e o valor default real da plataforma), anexo de
   imagem/capa (opcional — o teaser pode sair só com o link, que
   tipicamente gera preview automático de OpenGraph a partir de
   `especial.diar.ia.br/{ano}/{slug}/`, já que o Worker publica
   `og:image`/`og:title`/`og:description` — conferir se a apoia.se de fato
   faz esse unfurl).
4. **Botão de publicar** e como ele se comporta — publica na hora (mais
   provável, dado que não há sinal de agendamento documentado em nenhum
   lugar deste repo) ou oferece rascunho/agendamento como Beehiiv/LinkedIn?
   Se publicar na hora: **isto é AÇÃO IRREVERSÍVEL PARA TERCEIROS** (post
   visível pros apoiadores imediatamente) — o gate humano do Passo 1 da
   skill (que mostra os 3 textos antes de qualquer publicação) é quem cobre
   essa irreversibilidade, não um mecanismo de rascunho aqui.
5. **Como confirmar sucesso.** Precisa de uma URL estável do post publicado
   pra registrar em `data/artigo-especial/{ano}-{slug}/published.json`
   (canal `apoiase`, ver `scripts/lib/artigo-especial-state.ts`) — navegar
   de volta pra `apoia.se/diaria` (ou a aba de posts) e confirmar que o
   teaser aparece no topo, capturando a URL do post individual se a
   plataforma expõe uma (`apoia.se/diaria/posts/{id}` ou similar).

## Fluxo esperado (a preencher com os seletores reais)

### 1. Login + navegação ao painel
- Navegar para `https://apoia.se/diaria` (ou direto pro painel, se a URL do
  item 1 acima já estiver mapeada).
- Se cair em tela de login, abortar com `"apoia.se login expirado"`.

### 2. Abrir o composer de novo post
- **(placeholder — mapear seletor/rota real)**

### 3. Preencher o post
- Título (se aplicável): título do artigo.
- Corpo: os 2-3 parágrafos de abertura + link, exatamente como gerado em
  `data/artigo-especial/{ano}-{slug}/apoiase.md` (Passo 1 da skill — já
  passado por humanizador + Clarice).
- Visibilidade: público (default, ver acima).

### 4. Publicar
- **(placeholder — confirmar se existe rascunho/agendamento ou só
  publicação imediata)**

### 5. Verificar e capturar a URL
- **(placeholder — mapear onde a URL do post publicado aparece)**

## Erros recuperáveis

- **Login expirado** → abortar, sinalizar ao editor (mesma disciplina do
  #738/#3938 — falha de acesso à plataforma não é "seguir sem verificar").
- **DOM não bate com nenhuma das hipóteses acima** → não adivinhar mais de
  2-3 tentativas; parar e pedir ao editor pra navegar manualmente até o
  composer, então continuar a automação a partir de onde ele parou —
  registrar o caminho real neste arquivo antes de finalizar a sessão (é
  assim que este playbook deixa de ser "placeholder").

## Depois de mapear pela 1ª vez

Substitua cada `(placeholder — ...)` acima pela sequência real (mesmo nível
de detalhe de `linkedin.md`/`facebook.md`: seletores, texto de botões,
comportamento de fallback), e apague esta seção + "O que falta mapear" —
elas só existem enquanto o playbook estiver incompleto.
