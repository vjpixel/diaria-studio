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

**Estado: fluxo mapeado ao vivo** (1ª execução 23/08/2026, revisado na 2ª
execução 30/09/2026, artigo o-jev, #9258). Os passos abaixo são a sequência
confirmada; se a UI mudar, atualizar este arquivo na mesma sessão.

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
  (`workers/retrospectiva`, canal separado).
- **Visibilidade: restrita ao nível R$10+.** `data/snippets/artigo-especial-apoiadores.md`
  vende o Artigo Especial como benefício desse tier — post público entregaria
  o benefício a quem não paga no mesmo instante em que entrega a quem paga.
  A restrição vale pro POST; o artigo em si continua público na URL, então
  isto é coerência de canal, não paywall. O controle é o
  `Quem pode ver?` (passo 4 abaixo), valor `10` — nunca cair pra público
  em silêncio.

## Fluxo REAL (mapeado em 23/08/2026, revisado em 30/09/2026)

1. **Não existe painel separado.** O criador logado opera a partir da própria
   página pública `apoia.se/diaria`, que ganha abas extras: `Sobre`,
   `Posts no Mural (N)`, `Rascunhos`, `Apoiadores(as)`. Nenhuma URL de
   dashboard/admin envolvida.
2. **Abrir a aba `Posts no Mural`: esperar a página terminar de carregar e
   clicar por COORDENADA no texto da aba** (30/09/2026). Logo após o
   carregamento a aba não responde a clique por `ref`, e navegar direto pra
   `/diaria/contents` redireciona pra home. Em 23/08 o inverso funcionou
   (`find` + `ref`; coordenada não respondia) — se um caminho não reagir,
   tentar o outro antes de desistir.
3. **Criar post:** aba `Posts no Mural` → botão vermelho `Criar nova
   postagem` (topo direito da lista) → leva a `/diaria/contents/create`.
4. **Campos do editor** (`/diaria/contents/create` para post novo;
   `/diaria/contents/edit/{slug-id}` no caso de edição):
   - **`Título da postagem` — obrigatório** (o form não envia sem ele). Usar
     o título do post gerado no Passo 1 da skill.
   - Imagem de capa (upload, opcional). **Claude in Chrome não anexa a
     imagem** (upload de arquivo bloqueado pela extensão) — fica para o
     editor, se ele quiser capa.
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
5. **Publicar:** em post NOVO o botão final é `Postar no Mural`; `Salvar
   alterações` é o botão da tela de EDIÇÃO de post existente. Na edição,
   **`Deletar postagem` fica imediatamente ao lado** — clicar SEMPRE por
   `ref` (via `find`), nunca por coordenada. O clique final é do editor
   (ação irreversível para terceiros, ver `CLAUDE.md` "Perguntar é exceção"
   critério 1) — o fluxo funciona com ele dando esse clique.
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

## Erros recuperáveis

- **Login expirado** → abortar, sinalizar ao editor (mesma disciplina do
  #738/#3938 — falha de acesso à plataforma não é "seguir sem verificar").
- **DOM não bate com o fluxo acima** → não adivinhar mais de 2-3
  tentativas; parar e pedir ao editor pra navegar manualmente até o
  composer, então continuar a automação a partir de onde ele parou —
  registrar o caminho novo neste arquivo antes de finalizar a sessão.
