# Playbook: apoia.se (post de anúncio do Artigo Especial)

Roteiro semântico para o TOP-LEVEL (nunca um subagente — só o top-level tem
`mcp__claude-in-chrome__*`) operar o painel de posts da campanha apoia.se via
Claude in Chrome, no Passo 3 da skill `/diaria-artigo-especial` (#5979).
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
validada ao vivo. A 1ª execução real do Passo 3 da skill precisa do editor
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
- O post do Passo 3 é uma **chamada restrita a apoiadores R$10+** (decisão
  do editor revista ao vivo em 23/08/2026, 1ª execução da skill — substitui
  o "teaser público reaproveitando `leadParagraphs`" que esta seção
  documentava antes, issue #5979): título + 2 parágrafos curtos de chamada
  (não recorte do artigo — o mecanismo fica no artigo, é o que faz a pessoa
  clicar) + link pra `especial.diar.ia.br/{ano}/{slug}/`. Não é o texto
  integral do artigo, nem o conteúdo do paywall `artigo.diar.ia.br`
  (`workers/artigo-mensal`, canal separado).
- **Visibilidade: restrita ao nível R$10+.** `data/snippets/artigo-especial-apoiadores.md`
  vende o Artigo Especial como benefício desse tier — post público entregaria
  o benefício a quem não paga no mesmo instante em que entrega a quem paga.
  A restrição vale pro POST; o artigo em si continua público na URL, então
  isto é coerência de canal, não paywall. **Achar o controle de visibilidade
  é parte do mapeamento pendente (item 3 abaixo)** — o nome do controle e os
  valores que a plataforma oferece (só-apoiadores? por nível? por
  recompensa?) não estão confirmados. Se a apoia.se NÃO permitir restringir
  por nível (só público vs. todos-os-apoiadores), publicar como
  todos-os-apoiadores e registrar aqui a limitação — nunca cair pra público
  em silêncio.

## Fluxo REAL, mapeado ao vivo em 23/08/2026 (1ª execução, editor presente)

Painel confirmado. As hipóteses da seção "O que falta mapear" abaixo estão
resolvidas — mantidas só como histórico até a próxima revisão deste arquivo.

1. **Não existe painel separado.** O criador logado opera a partir da própria
   página pública `apoia.se/diaria`, que ganha abas extras: `Sobre`,
   `Posts no Mural (N)`, `Rascunhos`, `Apoiadores(as)`. Nenhuma URL de
   dashboard/admin envolvida.
2. **As abas NÃO respondem a clique por coordenada** (o clique registra e
   nada muda). Usar `find` + clique por `ref` — foi o que funcionou.
3. **Criar post:** aba `Posts no Mural` → botão vermelho `Criar nova
   postagem` (topo direito da lista).
4. **Campos do editor** (`/diaria/contents/edit/{slug-id}` no caso de edição):
   - Imagem de capa (upload, opcional).
   - `Link externo do conteúdo (se houver)` — input `type="url"`. É AQUI que
     a URL do artigo vai; a plataforma renderiza `Link externo: {url}` como
     bloco próprio no fim do post. **Não repetir a URL no corpo** — duplica.
   - `Escreva sua postagem abaixo` — editor rich text estilo Quill (toolbar
     Normal/B/I/U/listas/link/vídeo/imagem). `ctrl+a` com o cursor dentro do
     editor seleciona SÓ o conteúdo dele (verificado por screenshot antes de
     digitar: o campo de URL e o resto do formulário ficam intactos), então
     clicar no corpo → `ctrl+a` → digitar por cima é seguro. Quebras de
     linha duplas viram parágrafos corretamente.
   - `Quem pode ver?` — **combobox nativo** (`option`/`value`), 6 valores:
     `Todo mundo` (`public`), `Somente apoiadores` (`all-supporters`),
     `Somente apoiadores com R$ 5 ou +` (`5`), `R$ 10 ou +` (`10`),
     `R$ 25 ou +` (`25`), `R$ 50 ou +` (`50`). **A plataforma corta por
     VALOR, então a decisão "restrito a R$10+" é executável literalmente** —
     escolher `10`. Sendo `<select>` nativo, dá pra setar via `form_input`.
5. **Salvar:** botão `Salvar alterações` (submit). **`Deletar postagem` fica
   imediatamente ao lado** — clicar SEMPRE por `ref` (via `find`), nunca por
   coordenada.
6. **URL estável do post:** `apoia.se/diaria/contents/view/{Titulo-slug}-{id}`
   (ex: `.../Artigo-especial-de-agosto-0QCFIXKq3`). É essa que vai em
   `--url` pro `mark-artigo-especial-channel.ts`. A edição preserva a URL e
   o carimbo de publicação original.
7. **Publicação é imediata** (não há agendamento). A aba `Rascunhos` existe
   como estado separado, mas o fluxo normal do botão publica direto.

### ARMADILHA: o editor às vezes já publicou o post à mão

Achado ao vivo na 1ª execução: existia um post `Artigo especial de agosto`
publicado manualmente horas antes, já no tier certo, com corpo fraco (só o
título do artigo + o `og:description`). O guard de idempotência da skill NÃO
viu, porque `published.json` só existe se a skill rodou. **Sempre abrir a aba
`Posts no Mural` e conferir se já há post do artigo do mês ANTES de criar um
novo** — senão a skill duplica o post pros mesmos apoiadores. Se existir,
o caminho é EDITAR aquele (preserva URL e timestamp), não criar outro.
Mesma classe do "publicação manual exige refresh-dedup" do `CLAUDE.md`.

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
   pra passar em `--url` pro `scripts/mark-artigo-especial-channel.ts`
   (canal `apoiase` — ver Passo 3 da skill, NUNCA escrever `published.json`
   à mão) — navegar de volta pra `apoia.se/diaria` (ou a aba de posts) e
   confirmar que o teaser aparece no topo, capturando a URL do post
   individual se a plataforma expõe uma (`apoia.se/diaria/posts/{id}` ou
   similar).

## Fluxo esperado (a preencher com os seletores reais)

### 1. Login + navegação ao painel
- Navegar para `https://apoia.se/diaria` (ou direto pro painel, se a URL do
  item 1 acima já estiver mapeada).
- Se cair em tela de login, abortar com `"apoia.se login expirado"`.

### 2. Abrir o composer de novo post
- **(placeholder — mapear seletor/rota real)**

### 3. Preencher o post
- Título (se aplicável): título do artigo.
- Corpo: a chamada + link, exatamente como gerado em
  `data/artigo-especial/{ano}-{slug}/apoiase.md` (Passo 1 da skill — já
  passado por humanizador + Clarice).
- Visibilidade: **restrita a apoiadores R$10+** (ver acima). Conferir o
  controle ANTES de publicar — publicar público por engano é irreversível.

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
