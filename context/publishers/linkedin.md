# Playbook: LinkedIn (Stage 6 — social)

Roteiro semântico para o agente `publish-social` operar o composer do LinkedIn via Claude in Chrome. Documento vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://www.linkedin.com/`
- Pré-condição: usuário já logado no Chrome.
- Post sempre como **página Diar.ia** (ID: 110742958) — nunca como perfil pessoal (ver Passo 3).

## Objetivo

Para cada destaque (d1/d2/d3), criar um post com texto + imagem. **Tentar salvar como rascunho primeiro**; se a UI não oferecer rascunho no momento OU se houver overwrite detectado, agendar conforme `publishing.social.fallback_schedule.linkedin`.

## Fluxo (por post)

### 1. Abrir composer **fresh** (#266 — crítico)

LinkedIn reusa o composer entre invocações e oferece "Continue your draft" que faz o agent EDITAR um draft existente em vez de criar um novo. Resultado: 3 posts viraram 1 só draft (data loss reportada como success). Cada post precisa de composer isolado.

- Navegar para `https://www.linkedin.com/feed/` (re-navegar **sempre**, mesmo entre iterações).
- Se cair em login, abortar com `"LinkedIn login expirado"`.
- Clicar em **Start a post** (no topo do feed).
- **Se aparecer prompt "Continue your draft"**: clicar em **Discard** / **Start new** / fechar overlay e clicar Start a post de novo. **NUNCA** clicar Continue — anexa conteúdo novo ao draft anterior.
- Modal de composer abre vazio.
- **Validar via `javascript_tool`**: o `<div contenteditable>` deve ter `textContent.trim() === ""`. Se não estiver vazio, fechar e reabrir.

### 2. Capturar baseline draft count (uma vez por sessão, antes do d1)

Antes de criar o primeiro post (d1), registrar quantos drafts já existem na conta — usado pra validar unicidade de cada save (passo 6).

<!-- Se count sempre retornar 0, verificar a estrutura HTML atual da página de drafts e atualizar os seletores aqui. -->

```javascript
// Via javascript_tool em https://www.linkedin.com/in/me/recent-activity/drafts/
// Tentativa 1: seletores específicos de draft
let count = document.querySelectorAll('[data-test-id*="draft"], [data-urn*="draft"]').length;
// Fallback: seletor genérico de itens de lista (se seletores específicos retornarem 0)
if (count === 0) {
  count = document.querySelectorAll('.scaffold-finite-scroll__content > li').length;
}
return {
  count,
  warn: count === 0 ? 'Seletores de draft não encontraram nada — possível mudança de UI' : null
};
// O agente lê: const baseline = result.count; if (result.warn) registrar no output
```

O agente deve:
1. Ler `result.count` como `baseline_draft_count`.
2. Se `result.warn !== null`, incluir `warn: result.warn` no JSON de output (não bloquear).

Após cada save subsequente, recontar com a mesma lógica de fallback — count deve incrementar de exatamente +1 por iteração. Se não incrementar, save sobrescreveu draft existente → falha de dados.

**Se nenhum seletor funcionar após 2 tentativas**, continuar com `baseline = 0` — nunca bloquear o pipeline por conta de seletor frágil.

### 3. Escolher autor (uma vez por sessão) — OBRIGATÓRIO

O composer abre por padrão no contexto do perfil pessoal. É obrigatório trocar para a página Diar.ia (configurada em `publishing.social.linkedin.company_page_name`) antes de postar.

- Localizar o dropdown de autor (avatar/nome no topo do composer).
- Clicar e selecionar **Diar.ia** (página da empresa, ID: 110742958).
- **Verificar troca via `javascript_tool`** — não confiar só no visual. A verificação tem que olhar o seletor de autor ativo, não o `textContent` inteiro do dialog (a string "Diar.ia" também aparece nas opções do dropdown e em sugestões, gerando falso positivo):
  ```javascript
  // Tentativa em ordem: aria-label do botão de autor → data-test-id → fallback.
  const composer = document.querySelector('[role="dialog"]') || document.body;
  const authorBtn =
    composer.querySelector('[aria-label*="author" i]') ||
    composer.querySelector('[data-test-id*="actor" i]') ||
    composer.querySelector('button[id*="post-as"]') ||
    composer.querySelector('header [role="button"]');
  const authorText = (authorBtn?.textContent || authorBtn?.getAttribute('aria-label') || '').trim();
  // Match pelo nome configurado em platform.config.json → company_page_name.
  return {
    has_company_name: authorText.includes('Diar.ia'),
    author_text: authorText.slice(0, 100),
    selector_found: !!authorBtn,
  };
  ```
  Interpretação:
  - `has_company_name: true` → tudo certo, prosseguir.
  - `has_company_name: false` + `selector_found: true` → autor ainda é perfil pessoal, retry.
  - `selector_found: false` → seletor de autor mudou (UI shift), retry mas registrar warn no output.
- **Retry até 3×** se a verificação falhar (#506):
  - Tentativa 1: clicar dropdown, esperar 1s, selecionar Diar.ia, verificar.
  - Tentativa 2: fechar composer, reabrir (Passo 1), repetir.
  - Tentativa 3: fechar composer, navegar pra `publishing.social.linkedin.company_page_url` (admin dashboard da página) e procurar o botão "Start a post" no header. Se não achar o botão, considerar tentativa falha.
- **Se as 3 tentativas falharem:** ABORTAR com erro `"linkedin_page_not_found: página Diar.ia não disponível no composer após 3 tentativas — verificar acesso à página"`. **NUNCA continuar como perfil pessoal** — `status: "failed"`, `reason: "linkedin_page_not_found"`. Posts seguintes do mesmo run também abortam (sem retry novo) porque a sessão claramente não tem acesso à página.

### 4. Inserir texto
- O composer usa `<div contenteditable>` (ProseMirror) — `form_input` não funciona aqui. Usar `javascript_tool` para injetar o texto:
  ```javascript
  const el = document.querySelector('.ql-editor') || document.querySelector('[contenteditable="true"]');
  el.focus();
  document.execCommand('insertText', false, "<texto do post>");
  ```
- Conteúdo: seção `## d{N}` dentro de `# LinkedIn` em `03-social.md`, com heading e comentários HTML removidos.
- Não adicionar nada — o conteúdo já vem pronto e revisado por Clarice.

### 5. Imagem via URL pública (Drive) — #48

**Mudança**: em vez de upload do arquivo local (que não funciona via `mcp__claude-in-chrome__upload_image`), **colar a URL pública** retornada pelo pre-flight do agent (`scripts/upload-images-public.ts`). LinkedIn auto-detecta e renderiza preview visual.

- No campo do composer, **appendar em linha separada no fim do texto** (depois de hashtags):
  ```
  (texto do post)

  (hashtags)

  https://drive.google.com/uc?id={file_id}&export=view
  ```
- LinkedIn detecta a URL em 1-2s e renderiza card de preview com a imagem inline.
- Se o preview não renderizar (rare — Drive a vezes demora), aguardar 5s e re-verificar.
- Se não renderizar mesmo assim, tentar URL alternativa: `https://drive.google.com/file/d/{file_id}/view` (HTML wrapper com og:image).
- **Não** clicar em ícone de Photo (📷) — upload local não funciona no Claude in Chrome.

**Trade-off vs upload nativo**:
- Preview do LinkedIn mostra card de link em vez de imagem fullscreen.
- Engagement **tipicamente menor** que native image (diferença concreta não medida — vale A/B se virar preocupação editorial).
- Mas é o único approach 100% automatizado sem custo recorrente (ver #48 pra análise completa).

### 6. Tentar salvar como rascunho **com validação de unicidade** (#266)
- LinkedIn salva drafts automaticamente quando você fecha o composer com conteúdo. Procurar o **X** (fechar) → modal pergunta "Save as draft?" → confirmar.
- **Após confirmar**, navegar imediatamente para `https://www.linkedin.com/in/me/recent-activity/drafts/` e:
  1. Recontar drafts via `javascript_tool` (mesma lógica de fallback do passo 2).
  2. Se `count == baseline + iteration_number`, draft NOVO foi criado ✅. Capturar URL do primeiro draft visível usando seletores com fallback:
     ```javascript
     let url = document.querySelector('a[href*="/feed/update/urn:li:fsd_share:"]')?.href;
     if (!url) url = document.querySelector('a[href*="/feed/update/"]')?.href;
     return { url: url ?? null, warn: !url ? 'URL do draft não encontrada' : null };
     // O agente lê: result.url como draft_url; se result.warn !== null, incluir no output
     ```
     O agente deve: ler `result.url` como `draft_url`; se `result.warn !== null`, incluir `warn: result.warn` no JSON de output.
  3. Se `count <= baseline + (iteration_number - 1)`, save **sobrescreveu** draft anterior. Marcar este post como `status: "failed"` com `reason: "linkedin_draft_overwrite_detected"`.
  4. Se 2 saves consecutivos detectarem overwrite, switch para schedule no próximo (passo 7) — drafts viraram inviáveis nessa sessão.
- Drafts ficam em **Posts** → **Drafts** (acessível pelo perfil/página).

### 7. Fallback: agendar
- Triggers:
  - Opção de rascunho não aparecer (UI mudou ou só disponível pra certos tipos de conta).
  - Validação do passo 6 detectou overwrite duas vezes consecutivas (drafts não estão funcionando nessa sessão).
- Schedule é mais robusto que draft pra automation — não tem o problema de overwrite single-instance.
- Voltar ao composer (não fechar).
- Clicar no ícone de **clock/Schedule** (🕐) ao lado do botão Post.
- Selecionar data = hoje + `publishing.social.fallback_schedule.linkedin.day_offset` dias.
- Selecionar hora = `publishing.social.fallback_schedule.linkedin.d{N}_time` (timezone = `publishing.social.timezone`).
- Confirmar **Schedule**.
- Capturar URL do post agendado navegando pra `publishing.social.linkedin.scheduled_posts_url` (página da empresa). Status = `"scheduled"`.

### 8. Validar e fechar — verificação em 2 etapas (#506)

A mensagem "Post scheduled" pode aparecer mesmo quando o post foi parar no contexto errado (perfil pessoal em vez da página). Fazer verificação ativa em 2 passos:

1. **Confirmação UI**: ler mensagem ("Post scheduled" ou "Draft saved").
2. **Verificação de contexto via navegação** — navegar pra `publishing.social.linkedin.scheduled_posts_url` (página da empresa, NÃO `linkedin.com/feed/scheduled-posts/` do perfil pessoal):
   - Para scheduled: ir pra `scheduled_posts_url` do config e via `javascript_tool` confirmar que o texto do post (primeiros 50 chars) aparece nessa página.
   - Para draft: ir pra Drafts da página da empresa (acessível via composer da página) e idem.
   - Se o texto **não** aparecer na página da empresa, o post foi pro lugar errado → marcar `status: "failed"` com `reason: "linkedin_published_to_wrong_context"`. NÃO incluir URL pessoal no output como se fosse sucesso.
- Capturar URL ou ID **único** (passo 6 garante unicidade pra drafts; scheduled posts são naturalmente únicos).
- Fechar modal/aba antes do próximo post — re-navegar para `/feed/` no início da próxima iteração (passo 1).

## Modo rascunho

**Suportado** (com ressalva). LinkedIn tem drafts mas a feature varia por tipo de conta (pessoal vs página) e tem limites (~ 100 drafts). Se não detectar a opção, cair no fallback.

## Modo agendamento (fallback)

**Suportado.** LinkedIn permite agendar posts pessoais e de página com até 3 meses de antecedência.

## Gotchas conhecidos

- Composer pode demorar 2–5s para abrir após clicar "Start a post" — esperar.
- Upload de imagem grande (>5MB) pode levar 30s+ — aguardar barra de progresso.
- LinkedIn às vezes sugere "Add a hashtag" — ignorar (já estão no texto).
- Modal de "Are you sure you want to leave?" ao fechar sem postar = boa indicação que o draft NÃO foi salvo. Confirmar "Save as draft" se aparecer.
- O ícone de schedule (clock) só aparece **depois** de adicionar conteúdo (texto + imagem).

## Validação de sucesso

- **Draft**: aparece na seção Drafts da **página Diar.ia** (acessível via composer da página). Drafts do perfil pessoal **não** contam — são sinal de erro no Passo 3.
- **Scheduled**: aparece em `publishing.social.linkedin.scheduled_posts_url` (página da empresa) com data/hora. Capturar a URL aqui — `linkedin.com/feed/scheduled-posts/` é do perfil pessoal e nunca deve ser registrada como sucesso (#504, #506).

## Erros recuperáveis

- **Login expirou** → abortar.
- **Upload falha** → tentar 2x.
- **Nem draft nem schedule funcionam** → abortar este post, registrar em `06-social-published.json` com `status: "failed"` e prosseguir para o próximo.

## Post pessoal standalone de D1 (`## post_pixel`) — #1690

Além dos textos genéricos (LinkedIn/Facebook/Instagram, #3991), o `03-social.md` traz um `## post_pixel`: um **post próprio no feed pessoal do vjpixel** sobre o D1 (gerado pelo `social-writer`, voz pessoal). Amplifica o destaque de topo via alcance orgânico do perfil pessoal.

**Publicação (manual via Claude in Chrome, sessão LinkedIn do Pixel logada):**

- Agendar/postar no **MESMO horário do D1 da página** (10:00 BRT) — os dois saem juntos.
- **⚠️ GUARD INVERTIDO (espelho do Passo 3):** o post da página exige `has_company_name===true` e aborta se cair no perfil pessoal. O `post_pixel` exige o **inverso** — confirmar que o composer está no **perfil pessoal (vjpixel)**, e abortar se cair na página Diar.ia:
  ```javascript
  const authorText = (authorBtn?.textContent || authorBtn?.getAttribute('aria-label') || '').trim();
  return {
    is_personal: !authorText.includes('Diar.ia'),   // perfil pessoal = NÃO é a página
    author_text: authorText.slice(0, 100),
    selector_found: !!authorBtn,
  };
  ```
  - `is_personal: true` → ok, postar como vjpixel.
  - `is_personal: false` (caiu na página Diar.ia) → trocar pro perfil pessoal e re-verificar; se não conseguir em 3×, **ABORTAR** com `reason: "linkedin_published_to_wrong_context"` — **NUNCA** postar o conteúdo pessoal na página.
- **Validação de sucesso:** o post aparece no feed/drafts do **perfil pessoal** (oposto do post da página). Registrar em `06-social-published.json` com `subtype: "post_pixel"`, `platform: "linkedin"`, `destaque: "d1"`, `status` resolvido via `resolveLinkedInState`.

Falha do `post_pixel` **não bloqueia** os posts da página — é amplificação opcional. Logar warn e seguir.

## Newsletter LinkedIn (artigo semanal, `/diaria-linkedin-semanal`, #4456)

**Diferente de tudo acima.** As seções 1-8 cobrem o **composer de post
comum** (Stage 6 social da diária, `03-social.md`, `## d{N}`/`## post_pixel`).
A newsletter semanal do LinkedIn é uma feature DIFERENTE do produto — um
**artigo de longa-forma** publicado dentro de uma newsletter nativa do
LinkedIn (perfil pessoal do editor), que dispara notificação + e-mail aos
assinantes da newsletter, fora do ranqueamento de feed. Sem API de
publicação — o output de `/diaria-linkedin-semanal`
(`data/weekly/{cycle}/ln-{cycle}.html`) é **sempre** colado à mão.

Achados operacionais de publicar a edição #1 à mão (comentários 260802 do
#4456):

### 1. Confira o destino no cabeçalho do editor (a regra antiga era mais dura do que a realidade)

**Corrigido em 260803, verificado ao vivo publicando a edição #1.** A versão
anterior deste playbook afirmava que entrar por `linkedin.com/article/new/`
cria um artigo **individual** e mata o convite automático pra rede. Isso
**não se confirmou**: o editor de artigo hoje traz um seletor "Publish to"
no próprio cabeçalho (clicando no nome do autor), com as opções
"Individual article" e o nome da newsletter, e ele já vem com a
**newsletter marcada** ao entrar por `/article/new/`.

O que continua valendo é a VERIFICAÇÃO, não o caminho:

1. Preferir `linkedin.com/newsletters/{urn}/` → **Write article** (caminho
   mais seguro, não depende do default do seletor).
2. **Antes de escrever qualquer coisa**, conferir o cabeçalho do editor: ele
   tem que mostrar o nome da newsletter abaixo do nome do autor. Se mostrar
   "Individual article", abrir o seletor e trocar.
3. Observado em 260803: uma aba que ficou aberta e recarregou sozinha voltou
   como "Individual article". O cabeçalho é o único sinal confiável — reler
   antes de publicar, não só ao abrir.

O URN da newsletter "IA na semana" (perfil pessoal do editor) é
`7489744978307473408`, ou seja
`linkedin.com/newsletters/ia-na-semana-7489744978307473408/`.

### 2. Texto de link nunca termina em domínio nu

O editor de artigo do LinkedIn auto-linka qualquer menção em texto ao
domínio `diar.ia.br` (mesmo fora de um link intencional). Quando o RÓTULO
de um link que você quis inserir termina exatamente no domínio nu (ex:
texto do link = `"assine em diar.ia.br"`), o editor **parte o link em
dois**: a parte que sobra clicável perde o `href` original (e portanto o
UTM) — a auto-linkagem "rouba" o fim do rótulo.

**Regra aplicada mecanicamente por `renderLinkedinWeeklyHtml`
(`scripts/lib/weekly-linkedin-render.ts`):** todo rótulo de link que este
módulo gera é um rótulo de AÇÃO, nunca o domínio — "Receba todo dia, é
grátis →" (CTA do meio, fecha o bloco Use Melhor) e "Assine grátis, é
rapidinho →" (CTA do fim). `endsInBareDomainLabel()` no mesmo módulo é o
guard determinístico — se algum dia um rótulo dinâmico (ex: título de
Use Melhor levantado literal) terminar coincidentemente em algo que
pareça domínio, o render emite warning em vez de deixar passar em
silêncio. Menções a "diar.ia.br" em PROSA (fora de um link intencional)
podem ficar — viram link automático sem UTM pra home, que é tráfego de
brinde e não atrapalha a medição dos CTAs.

### 3. Imagem de capa (#5536)

O LinkedIn Article Editor tem um campo nativo de cover image (ícone de
imagem no topo do editor, acima do título). `render-linkedin-weekly.ts`
(Passo 7 da skill) copia mecanicamente `04-d1-2x1.jpg` — a imagem 2:1 da
edição de origem da manchete #1 — pra `data/weekly/{cycle}/04-d1-2x1.jpg`;
não existe API pra subir essa imagem, então o upload continua **manual**,
igual ao resto do artigo:

1. Clicar no ícone de imagem de capa do editor (topo, acima do título).
2. Selecionar `data/weekly/{cycle}/04-d1-2x1.jpg` do disco.
3. Se `ln-{cycle}.json` (Passo 7 da skill) trouxe `coverImagePath: null`
   (edição de origem arquivada ou sem a imagem — fail-soft, não bloqueia o
   resto do artigo), publicar sem capa é aceitável — não há imagem
   alternativa determinística pra usar no lugar.

### Nota técnica: colagem programática no corpo (ProseMirror)

O corpo do artigo é um editor ProseMirror (mesma família de tecnologia do
composer de post comum, seção 4 acima, mas instância separada — específica
da página de artigo). Setar `innerHTML` diretamente **não registra** no
estado interno do editor (o próximo keystroke reverte/perde o conteúdo).
Colagem programática funciona via `ClipboardEvent` com `text/html` no
`DataTransfer`:

```javascript
// Via javascript_tool, com o foco já no <div contenteditable> do corpo.
const html = "<conteúdo de ln-{cycle}.html>";
const dt = new DataTransfer();
dt.setData("text/html", html);
const editorEl = document.querySelector('[contenteditable="true"]');
editorEl.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
```

Negrito, links, listas e divisores (`<hr>`) sobrevivem ao paste.
Transformações ESPERADAS na renderização do LinkedIn (não é bug, não
precisa de correção): `<h2>` vira `<h3>` visualmente; `<hr>` vira `<div>`
(o separador visual desaparece, mas o parágrafo seguinte começa numa nova
"seção" do editor). `renderLinkedinWeeklyHtml` usa `<h2>` pros títulos
numerados e `<hr/>` como separador de bloco de propósito — o objetivo é a
estrutura semântica sobreviver ao paste, não o tag literal.

#### Três armadilhas do paste, todas encontradas ao vivo em 260803

**a) Lista aninhada é ACHATADA, sem separador.** O editor não suporta
`<ul>` dentro de `<li>`: ele funde tudo num nível só e os itens internos
saem colados num bloco corrido, sem nada entre eles. Na edição #1 isso
produziu "Edição de 27/07 Anthropic lança o Claude Opus 5 EUA fiscalizam
GPT-5.6…", onde não dá pra ver onde um título acaba e o outro começa.
Correção aplicada em `renderLinkedinWeeklyHtml`: a seção "Edições da
semana" emite lista **plana**, com os destaques separados por `DESTAQUE_SEPARATOR`
(" · ") — separador em TEXTO, que sobrevive ao achatamento porque não é
estrutura.

**b) Link no ÚLTIMO nó colado perde a âncora.** Colar HTML que termina em
`<p><a …>…</a></p>` deixa o texto e descarta o `href`. Solução: colar com
um parágrafo vazio de sentinela no fim (`<p>&nbsp;</p>`), para que o link
nunca seja o último nó.

**c) Âncora que TERMINA em domínio nu tem o href sequestrado.** É a mesma
regra que `endsInBareDomainLabel` já guardava, mas com uma consequência
que não estava documentada: dá pra pré-linkar a menção em prosa a
`diar.ia.br` **e manter a UTM**, desde que a âncora se estenda além do
domínio. Testado nas duas formas em 260803:

    texto "diar.ia.br"                    -> href reescrito pra http://diar.ia.br, UTM perdida
    texto "diar.ia.br, newsletter de IA"  -> href preservado, UTM intacta (conclusão de 260803 — NÃO reproduzida em 260823, ver item (d) abaixo)

`linkifyWordmark` (mesmo módulo) faz isso automaticamente na primeira
menção da abertura, estendendo por até 3 palavras e validando com o
próprio guard; se não der pra estender, não linka em vez de emitir link
que se anuncia rastreado e não é.

**Cuidado ao inspecionar o resultado:** ler o DOM logo depois do paste
engana. Numa checagem 1,2s após o `ClipboardEvent` o href aparecia já
reescrito pelo auto-linkificador, e só depois o ProseMirror reassentava a
marca do paste. Conclusão errada foi tirada daí em 260803. Espere o
editor estabilizar (ou recarregue a página) antes de afirmar qualquer
coisa sobre o que sobreviveu.

**d) Âncora colada via `ClipboardEvent` cujo texto COMEÇA com "diar.ia.br"
é DIVIDIDA em duas, mesmo estendida além do domínio (achado 260823, 1ª
execução real do paste assistido via Claude in Chrome).** O item (c) acima
documentava, em 260803, "diar.ia.br, newsletter de IA" como caso seguro
(href preservado, UTM intacta) — **essa conclusão não se reproduziu em
260823**, apesar do teste desta rodada ter usado o mesmo tipo de paste via
`ClipboardEvent` que o "Cuidado ao inspecionar" acima já associa ao teste
original (esperei o editor estabilizar e confirmei via `javascript_tool`,
não só inspeção visual). **A causa exata da divergência entre as duas
sessões não foi isolada** — pode ser mudança de comportamento do editor do
LinkedIn desde 260803, uma diferença sutil na construção do HTML colado
não registrada na época, ou o teste original ter sido mal-verificado.
Tratar (d) como o comportamento **atual e confirmado**, e (c) como
histórico não confiável para este caso específico até alguém reproduzir
um dos dois de forma controlada. O que se observa agora: o
auto-linkificador do LinkedIn reconhece a substring "diar.ia.br" DENTRO do
texto da âncora colada e a separa num `<a>` próprio sem UTM
(`href="http://diar.ia.br/"`), deixando só o resto (", newsletter de IA")
na âncora original com a UTM. Resultado: 2 nós `<a>` adjacentes onde devia
haver 1, com o pedaço clicável mais provável (a marca em si) sem tracking.

**Correção aplicada manualmente na 1ª publicação real (26w34, 260823):**
selecionar a frase inteira ("diar.ia.br, newsletter de IA") via teclado
(clicar antes de "Desde", `Home`, `Right` × N até o início da menção,
`shift+Right` × M até o fim — **nunca clicar diretamente sobre o link
colado**, um clique ali fez a página rolar/pular pra outro trecho, ver
'Perigo' abaixo), abrir **Add link** (ícone 🔗 da toolbar) com a seleção
ativa — o popup "Edit link" trata as 2 âncoras coladas como 1 campo de
texto editável — e sobrescrever o campo **Link** com a URL completa
(UTM inclusa) antes de **Apply**. Resultado vira 1 âncora só, correta.

**Perigo colateral encontrado na mesma sessão:** um `left_click` isolado
em cima do texto do link (antes de `shift+click` pra estender a seleção)
fez o layout pular — a 2ª coordenada do clique subsequente acabou
selecionando texto de OUTRO parágrafo, bem mais abaixo no artigo (perto
de "Por que isso importa" de uma manchete diferente). Nenhum conteúdo foi
efetivamente apagado nesse caso específico, mas o mesmo padrão de clique
sobre link colado, repetido em outro ponto da sequência, **apagou
silenciosamente** o parágrafo `<p><a>Quero receber a edição diária →</a></p>`
inteiro do bloco Use Melhor (causa exata não isolada — suspeita: o popup
"Edit link" ficou com uma seleção obsoleta de uma iteração anterior e a
operação de Apply substituiu o range errado). **Mitigação:** depois de qualquer correção de link via
clique+seleção, sempre rodar uma auditoria completa de `document.querySelectorAll('a')`
comparando a contagem e os textos contra o esperado (10 âncoras nesta
edição: 1 menção + 3 CTAs de assinatura + 1 item de Use Melhor + 5 links
de "Edições da semana") E conferir `editor.textContent.length` bate com o
tamanho logo após o paste original — foi assim que a perda do CTA do Use
Melhor foi pega e corrigida (reinserção manual via paste de 1 `<p><a>`
isolado, cursor posicionado com `Home`/`End`/`Enter`, nunca clique direto
sobre texto de link).

Publicação continua **manual por padrão** (colar via UI, revisar
visualmente, clicar Publish) — a automação acima é referência pra quem for
implementar o paste assistido via Claude in Chrome no futuro; não é
executada por `/diaria-linkedin-semanal` nesta versão (a skill entrega o
artefato e as instruções, ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`
Passo 6). Em 260803 o paste assistido foi executado à mão numa sessão com o
editor presente, e os achados (a)-(c) vieram dessa rodada; o achado (d)
veio da 1ª execução real do fluxo completo por um agente via Claude in
Chrome, 260823 (ciclo `26w34`, artigo agendado pra publicar 260824) — a
mesma sessão que confirmou o agendamento funciona de ponta a ponta (ver §4
abaixo).

### 4. O LinkedIn AGENDA artigo de newsletter (a regra antiga dizia que não)

**Corrigido em 260803.** `.claude/skills/diaria-linkedin-semanal/SKILL.md`
afirmava que "o LinkedIn não tem API de agendamento de newsletter" e
concluía daí que não havia gate de agendamento. A premissa da API segue
verdadeira, mas a conclusão operacional estava errada: **a UI agenda**. O
diálogo que abre no **Next** traz um ícone de relógio ao lado do botão
Publish, e o artigo agendado aparece em
`linkedin.com/article/manage/scheduled/`.

**Consequências práticas, aprendidas no susto:**

- **Agende, não publique na hora.** Na edição #1 o artigo saiu à 1h30 da
  manhã porque a data estava certa e ninguém olhou a HORA. O envio canônico
  da diária é 06:00 BRT; o artigo semanal deve seguir a mesma lógica de
  horário comercial. O custo maior nem é o e-mail (que atinge poucos
  assinantes no começo) e sim o **post de feed**, que nasce sem engajamento
  inicial e fica com o alcance suprimido de forma permanente.
- **Artigo agendado SAI da lista de rascunhos.** Ao agendar, a URL
  `/article/edit/{id}/` passa a redirecionar pra `/article/new/`, exatamente
  como faria com um ID inválido. Isso parece perda de trabalho e não é —
  confira `Manage` → **Scheduled** antes de concluir qualquer coisa. Em
  260803 essa leitura errada gerou um rascunho duplicado.
- O diálogo de publicação tem um campo de texto ("Tell your network what
  this edition of your newsletter is about…") que vira o **post de feed**.
  É peça editorial separada do corpo do artigo. Em post do LinkedIn **não
  existe âncora em texto**: link é a URL escrita por extenso, que a
  plataforma auto-linka.
