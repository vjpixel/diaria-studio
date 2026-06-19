# Playbook: Beehiiv (Etapa 5 — newsletter daily)

Playbook semântico+operacional pra criar a newsletter Diar.ia no Beehiiv como **rascunho** usando o template configurado, e enviar um email de teste. Não publica nem agenda — o editor revisa e dispara manualmente do dashboard.

## TLDR (#1327)

Beehiiv newsletter = 1 comando + 1 paste JS:

1. `npx tsx scripts/upload-html-public.ts --edition AAMMDD` — sobe HTML pro Worker. **A URL retornada contém hash do conteúdo** (#1494) — ex: `draft.diaria.workers.dev/260527-3415df`. Usar essa URL (não montar manualmente).
2. Single `javascript_tool` no Chrome (fetch + `editor.commands.insertContent({type:'text', text:html})`) — ver §5.2 Fase 3.

Resto: Title + Subtitle + cover via Chrome MCP (3-4 calls visuais), depois Send test email.

**Total ~7-8 passos, ~5K tokens.** Nunca 15+. O caminho chunked legacy (apêndice) existe só como fallback automático se o Worker falhar — não usar como default mesmo se parecer "mais simples".

**Histórico do arquivo**: este arquivo era `.claude/agents/publish-newsletter.md` até #1114 (2026-05-12). Movido pra `context/publishers/` pra refletir o que ele é de fato: um **playbook lido pelo top-level Claude Code**, não um subagent dispatchável. Razão técnica original em #1054: `mcp__claude-in-chrome__javascript_tool` é restrito ao top-level — subagentes não conseguem chamá-la. E como o paste-into-htmlSnippet exige JS direto no DOM, nenhum subagent completaria o passo 5.

**Fluxo correto** (invocado por `/diaria-5-publicacao`, orchestrator-stage-5):
- Top-level Claude Code lê este arquivo como playbook
- Executa Bash, Read, Write, Chrome MCP tools direto
- **Não tente dispatchar via `Agent({ subagent_type: "publish-newsletter" })`** — o tipo não existe mais e javascript_tool falharia em qualquer subagent

Tools disponíveis no top-level: Bash, Read, Write, todas as `mcp__claude-in-chrome__*` (incluindo `javascript_tool`).

## Input

- `edition_dir`: ex: `data/editions/260418/`
- `mode`: `"create"` (default) ou `"fix"`
- `draft_url`: (só no modo fix) URL do rascunho existente no Beehiiv
- `issues`: (só no modo fix) lista de problemas a corrigir, retornados pelo `review-test-email`

## Modos de operação

**Modo `create`** (default): cria o rascunho do zero usando HTML pré-renderizado, salva e envia teste. Fluxo completo descrito abaixo.

**Modo `fix`**: recebe `draft_url` + `issues[]` do reviewer. Verifica se o source MD mudou desde o último paste; se sim, re-renderiza e substitui o HTML completo; se não, aplica patches incrementais.

**Passo fix-0 — Detectar modificação do source (#725 bug #8):**

```bash
node -e "
  const fs=require('fs');
  const pub=JSON.parse(fs.readFileSync('{edition_dir}/05-published.json','utf8'));
  const lastPaste=new Date(pub.test_email_sent_at??'1970-01-01').getTime();
  const mtime=fs.statSync('{edition_dir}/02-reviewed.md').mtimeMs;
  process.exit(mtime>lastPaste?1:0);
"
```

- **Exit 1** (mtime > last_paste) → source editado após o último paste → **re-renderizar + re-paste completo** (Passo fix-1).
- **Exit 0** → sem modificação → **patches incrementais** (Passo fix-2).

**Passo fix-1 — Re-render completo (source mudou):**

Repetir os passos 1.1–5.2 do modo create na íntegra (extract-destaques, upload-images-public newsletter, render-newsletter-html, substitute-image-urls, colar HTML no bloco Custom HTML do draft existente `draft_url`). Navegar para `draft_url` em vez de criar novo post. Após o re-paste, ir para Passo fix-3.

**Passo fix-2 — Patches incrementais (source não mudou):**

1. Navegar para `draft_url`.
2. Para cada issue em `issues[]`, interpretar a descrição e aplicar a correção no editor Beehiiv.
3. Ir para Passo fix-3.

**Passo fix-3 — Salvar e reenviar:**

1. Salvar o rascunho.
2. Reenviar email de teste (mesmo fluxo do passo 7 no modo create).
3. Gravar `05-published.json` atualizado — incrementar `fix_attempts`, **atualizar `test_email_sent_at`** com o novo timestamp (necessário pra próxima iteração detectar corretamente mudanças subsequentes).

Se alguma issue não puder ser corrigida automaticamente, registrar em `unfixable_issues[]` no output.

## Pré-requisitos

- Etapa 3 completa (`01-eia.md`, `01-eia-A.jpg`, `01-eia-B.jpg`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg` existem; `04-d3-1x1.jpg` e `04-d3-2x1.jpg` são obrigatórios somente para edições com 3 destaques — ausência é correta em edições 2-destaque (#2352); edições antigas têm `01-eia-real.jpg`/`01-eia-ia.jpg` em vez dos A/B — readers detectam automaticamente).
- Chrome com Claude in Chrome ativo, logado em Beehiiv (ver `docs/browser-publish-setup.md`).

### Preflight de visibilidade da aba (#2015, #2075)

**Antes de QUALQUER passo que dependa de clique real** (`computer`) — criar post
do template, send test email, clicar Schedule — verificar via `javascript_tool`:
`document.visibilityState`.

**Se `"hidden"` (janela aparentemente minimizada/coberta):** NÃO haltar imediatamente.
`visibilityState` pode ser stale (incidente 260611: retornou `"hidden"` com a janela
na frente, cliques reais funcionaram normalmente). Antes do halt, tentar um
**screenshot-probe** para distinguir stale de frozen:

1. **Esconder `img/iframe/video` via `javascript_tool`** para reduzir carga CDP antes do
   screenshot (workaround pra páginas pesadas — previne timeout falso positivo):
   ```js
   document.querySelectorAll('img,iframe,video').forEach(el => el.style.visibility='hidden');
   ```
2. Chamar `mcp__claude-in-chrome__computer` com `action: "screenshot"`.
3. **Restaurar** os elementos escondidos:
   ```js
   document.querySelectorAll('img,iframe,video').forEach(el => el.style.visibility='');
   ```
4. **Se o screenshot retornar a página renderizada em ≤ 10s** → `visibilityState` é
   stale; a aba está visível. Prosseguir com os cliques normalmente — NÃO haltar.
5. **Se o screenshot demorar > 10s ou falhar com timeout/CDP error** → frozen real.
   Renderizar halt banner e aguardar:
   ```bash
   npx tsx scripts/render-halt-banner.ts \
     --stage "4" \
     --reason "aba Beehiiv oculta (visibilityState=hidden + screenshot timeout)" \
     --action "traga a janela do Chrome pra frente e responda 'retry'"
   ```
   Aguardar resposta explícita do editor antes de qualquer ação adicional.

**Decisão resumida:**
- `visibilityState === "visible"` → prosseguir diretamente.
- `visibilityState === "hidden"` + screenshot OK (≤ 10s) → stale; prosseguir (#2075).
- `visibilityState === "hidden"` + screenshot timeout/falha → frozen real; halt banner.

Sintomas do frozen real (incidente 260610, ~10 min de debug): cliques via `computer`
chegam como no-op (zero pointerdown/click na página) e screenshots dão timeout
no CDP ("renderer may be frozen").

### Config 1x da publicação — rodapé branco (#1944)

O **rodapé que a Beehiiv anexa** ao e-mail (endereço, unsubscribe, "powered by
beehiiv") **não** vem do HTML que colamos — é estilizado pelo tema de e-mail da
publicação. Pra casar com o corpo branco (#1943/#1945), setar o fundo do rodapé
para **branco** uma vez no dashboard:

> Beehiiv → **Settings → Publication → Email** (ou **Design/Branding**) →
> seção do **Footer** → cor de fundo = **#FFFFFF**.

É config global (aplica a todas as edições). Não há endpoint na API/MCP pra
isso — ação manual do editor, uma vez. Conferir no test email da próxima edição.

## Processo (modo create) — fluxo Custom HTML (#74)

O fluxo foi migrado pra **Custom HTML block único**. Elimina block-by-block filling no editor (causa dos 5 bugs do #39: encoding, template items não removidos, truncamento, imagens inline faltando, É IA? não verificado).

### 0. Lint pre-flight — intentional_error (#754)

Antes de qualquer pré-render, validar que o editor declarou o erro
intencional do mês no frontmatter de `02-reviewed.md`. Convenção
editorial: cada edição tem 1 erro proposital pros assinantes (concurso
mensal). Sem declaração, lints downstream não distinguem erro intencional
de erro real, e o concurso mensal precisa garimpo manual.

```bash
npx tsx scripts/lint-newsletter-md.ts --check intentional-error-flagged \
  --md {edition_dir}/02-reviewed.md
```

Exit codes:
- `0`: frontmatter declarado e válido — prosseguir.
- `1`: declaração ausente ou incompleta — **abortar** com:
    ```json
    { "error": "intentional_error_missing", "details": "Editor não declarou intentional_error em 02-reviewed.md. Edite o arquivo (+ Drive sync) e adicione frontmatter conforme exemplo no stderr do lint." }
    ```
    Editor precisa editar o arquivo (instruções claras no stderr) e re-rodar `/diaria-5-publicacao`.
- `2`: erro de uso (path inválido) — abortar com `{ "error": "lint_cli_failed" }`.

Esse lint roda ANTES de criar o draft no Beehiiv pra garantir que erros
intencionais ficam registrados — mantém a auditoria do concurso possível.

#### 0.1 Sync frontmatter → intentional-errors.jsonl

Após o lint passar, sincronizar o frontmatter pra `data/intentional-errors.jsonl`
(usado pelo `lint-test-email.ts` no `review-test-email`). Idempotente — só
adiciona entry se a edição ainda não tem source `frontmatter_02_reviewed`.

```bash
npx tsx scripts/sync-intentional-error.ts \
  --md {edition_dir}/02-reviewed.md \
  --edition {AAMMDD} \
  --jsonl data/intentional-errors.jsonl
```

Stdout: `{ "added": true|false, "edition": "{AAMMDD}" }`. Falha (`exit != 0`)
não bloqueia — o lint do passo 0 já garantiu o frontmatter; falha aqui é
issue de I/O. Logar warning e prosseguir.

### 1. Pré-render — rodar ANTES de abrir o browser

**Este passo é crítico.** Gera HTML completo + sobe imagens pro Cloudflare Worker KV ANTES de qualquer interação com o browser.

> **#1119 (2026-05-11)**: Imagens pra newsletter daily agora vão pro Cloudflare Worker KV (`/img/{key}`), não pro Drive. Razão: Drive `uc?id=...` retorna HTML wrapper na 1ª request + throttle agressivo + sem Cache-Control. Cloudflare entrega JPEG direto, com `Cache-Control: public, max-age=31536000, immutable`. LinkedIn/Facebook seguem com Drive (mode `social`) — OG preview funciona melhor lá.

#### 1.1 Extrair metadata

```bash
# Título, subtítulo, destaques (JSON — ainda usado pro header do post)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Gravar output: `title`, `subtitle` (precisam ser preenchidos no form do Beehiiv separadamente do corpo).

#### 1.2 Upload imagens pro Cloudflare Worker KV (mode newsletter)

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter
```

Faz upload de 5 imagens pro Worker KV (default `--target cloudflare` quando `--mode newsletter`):
- `04-d1-2x1.jpg` (cover, também usada inline no D1)
- `04-d2-1x1.jpg` (inline D2); `04-d3-1x1.jpg` (inline D3, somente em edições 3-destaque — #2352)
- `01-eia-A.jpg`, `01-eia-B.jpg` (É IA? — random A/B; mapping em `01-eia.md` frontmatter; edições antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`, detectadas em runtime)

KV keys: `img-{AAMMDD}-{filename}` (ex: `img-260512-04-d1-2x1.jpg`). URLs servidas por `https://poll.diaria.workers.dev/img/{key}` com `Content-Type: image/jpeg` + `Cache-Control: public, max-age=31536000, immutable`.

Output: `{edition_dir}/06-public-images.json` com mapping `{ cover, d2, d3, eia_a, eia_b: { url, file_id, filename, target: "cloudflare" } }` (edições antigas: `eia_real`/`eia_ia` no lugar de `eia_a`/`eia_b`).

Resume-aware: re-execução pula imagens já no cache, **respeitando target**. Se cache tem entries `target=drive` mas o run pede `target=cloudflare`, faz re-upload.

**Escape hatch**: passar `--target drive` força Drive (ex: pra debug ou edições antigas que dependiam de URLs Drive específicas).

**Credenciais Cloudflare**: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` no `.env`. Namespace ID lido de `platform.config.json → poll.kv_namespace_id`.

#### 1.3 Render HTML + substituir URLs

**Modo single-file (atual — #1054 validation):** newsletter inteira (16KB) cabe num único `node-htmlSnippet` do template HTML do Beehiiv. Merge tags `{{poll_a_url}}/{{poll_b_url}}` são preservadas pelo htmlSnippet (raw HTML por design — não normaliza hrefs). Mesmo arquivo serve agent automation + paste manual via `prep-manual-publish.ts`:

```bash
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out {edition_dir}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts \
  --html {edition_dir}/_internal/newsletter-draft.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html \
  --reviewed-md {edition_dir}/02-reviewed.md
```

**Exit codes de `substitute-image-urls.ts` (#2316):**

| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Sucesso — todas as placeholders substituídas | Continuar |
| `1` | Erro de args (uso incorreto da CLI) | Verificar comando; abortar |
| `2` | Placeholders não resolvidas — `unresolved[]` não vazio | Abortar — verificar `06-public-images.json` e fluxo de upload |
| `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | **Não é fatal.** Re-rodar `render-newsletter-html.ts` (passo acima) e então re-rodar `substitute-image-urls.ts` |

> **Exit 3 (#2316, #2335):** o `render-newsletter-html.ts` não rodou (ou falhou silenciosamente) após a última edição de `02-reviewed.md`. O stderr já inclui o comando exato de re-render. Mensagem: `[substitute-image-urls] ERRO: HTML de input está desatualizado — mtime(...)`. Ação: re-renderizar e re-substituir. **Nunca tratar exit 3 como erro fatal irrecuperável** — é uma instrução de re-render, não uma falha de pipeline.

Se substituição reportar `unresolved: []` não vazio (exit 2), abortar — uma imagem não tem placeholder correspondente (verificar 06-public-images.json e fluxo de upload).

**Modo `--split` (legacy, NÃO usar pelo agent)**: o renderer ainda suporta `--split` que gera `newsletter-body.html` + `newsletter-eia.html` separados. Era pra resolver merge tags via insertContent que não funcionava. #1054 validou que paste-into-htmlSnippet preserva merge tags em arquivo único — `--split` fica obsoleto pro agent flow, mantido só pra eventual debug.

#### 1.4 Setar gabarito É IA? no Worker (#1526)

Garantir que o poll Worker já sabe a resposta correta **antes** do test email — editor testa o É IA? assim que o HTML vai pro Beehiiv. Sem isso, `correct:{edition}` fica vazio e o Worker não mostra resultado, ou pior, um valor stale de uma run anterior causa inversão.

`close-poll.ts` é idempotente — re-rodar após publicação só atualiza scores de votos novos.

```bash
npx tsx scripts/close-poll.ts --edition {AAMMDD}
```

Falha (exit != 0) = **warning, não bloqueia** o paste no Beehiiv. Poll sem gabarito ainda aceita votos; scores são reconciliados quando `close-poll` rodar pós-publicação. Mas logar warn explícito pro editor saber que o teste do É IA? não vai mostrar resultado.

### 2. Ler configuração

Ler `platform.config.json` → bloco `publishing.newsletter`:
- `template` (ex: `"Default"`)
- `test_email` (ex: `"vjpixel@gmail.com"`)

### 3. Abrir Beehiiv e criar post

1. **Navegar** para `https://app.beehiiv.com/`.
2. **Detectar login**: ler página. Se aparecer formulário de login ou "Sign in", abortar com:
   ```json
   { "error": "beehiiv_login_expired", "details": "Formulário de login detectado em app.beehiiv.com" }
   ```
3. **Selecionar workspace Diar.ia** se houver seletor.
4. **Criar new post**: clicar em **Posts** → **New post**.
5. **Selecionar template**: encontrar template com nome exato `template`. Se não encontrar, abortar.

### 4. Preencher cabeçalho

- **Title** = `title` (do JSON extraído no passo 1)
- **Subtitle** = `subtitle` (se houver campo)
- **Cover image** = upload de `{edition_dir}/04-d1-2x1.jpg` (1600×800) — ver §4b.

#### 4a. Setar Title/Subtitle (helper atômico #1423)

**⚠️ NUNCA chamar `execCommand('insertText')` direto pra setar Title/Subtitle.** Em 260520 isso produziu title duplicado silenciosamente (race entre `select()` e `insertText()`). Use sempre o helper `buildSetFieldJs` que faz a sequência atômica `focus → select → delete → insertText → blur`:

```typescript
import { buildSetFieldJs, isFieldVerified } from "scripts/lib/beehiiv-set-field.ts";
// Dispatch via javascript_tool:
mcp__claude-in-chrome__javascript_tool({ code: buildSetFieldJs("post-title", newTitle) });
// Aguardar autosave (5-8s) + verify via API:
sleep(8_000);
const post = await mcp__claude_ai_Beehiiv__get_post({ post_id });
if (!isFieldVerified(post.title, newTitle)) {
  // Retry 1× — autosave latency #1198 pode pegar valor stale brevemente
  mcp__claude-in-chrome__javascript_tool({ code: buildSetFieldJs("post-title", newTitle) });
}
```

**⚠️ Title autosave latency** (#1198, 2026-05-12): inputs Title/Subtitle do Beehiiv não persistem no backend imediatamente — UI e `document.title` atualizam, mas `GET /posts/{id}` via API pode retornar `"New post"` por minutos. O `isFieldVerified` cobre isso. Sem esse guard, Audience/Review steps usam título errado e o Subject line default herda `"New post"`.

#### 4a-bis. Setar slug SEO acent-correto (#1989)

Se não setado, a Beehiiv auto-deriva o slug do título e **mangla acentos PT-BR** (`automação` → `automa-o`, `pânico` → `p-nico`) — slug quebrado prejudica SEO/UX/compartilhamento. Computar o slug acent-correto e setá-lo em **Settings → SEO/URL slug** do post:

```typescript
import { seoSlug, seoMetaDescription } from "scripts/lib/slug.ts";
const slug = seoSlug(title);             // ex: "empregos-e-automacao-panico-vs-dados"
const metaDesc = seoMetaDescription(title, subtitle); // ≤155ch
// Setar o campo de slug do post nas configurações (Beehiiv: post settings → SEO).
```

(Opcional mas recomendado; o campo de slug fica em post settings. Medição do impacto via `scripts/seo-pull.ts` — GSC, ver #1896/#1989.)

#### 4b. Aplicar a cover image — DataTransfer (#1801 / #1500)

Beehiiv `file_upload` MCP retorna "Not allowed" no input hidden do editor. **Método primário — `buildCoverDataTransferJs` (#1500) — SEMPRE o primeiro, inclusive em replace (#2341).** DataTransfer no `input[type=file]` do editor + `.click()` na img recém-subida, que aplica **automático** (sem botão Insert) — porque o upload veio do próprio input do editor (user-activation context). Validado ao vivo 260602/260604. **Funciona para cover nova E para replace** — não requer remover a cover existente antes de tentar #1500.

URL canônica da cover (publicada via Cloudflare Worker KV pelo `upload-images-public.ts --mode newsletter`):

```
https://poll.diaria.workers.dev/img/img-{AAMMDD}-04-d1-2x1.jpg
```

Se houver sufixo de versão em `06-public-images.json` (md5 diff #1418), use a URL exata do cache.

**Fluxo correto (#2341 — #1500 primeiro, 2-step replace só como fallback):**

```typescript
import {
  buildCoverDataTransferJs,
  buildCoverReplaceStep1_RemoveExistingJs,
  buildCoverReplaceStep2_UploadJs,
  classifyCoverVerify,
} from "scripts/lib/beehiiv-cover-upload.ts";

// INVARIANTE (#2341): SEMPRE tentar buildCoverDataTransferJs PRIMEIRO —
// funciona pra cover nova E pra replace. Só cair no 2-step remove se #1500
// retornar applied:false (input[type=file] ausente). NUNCA escrever
// cover_status:stale_pending_manual ou cover_replace_failed sem ter chamado
// buildCoverDataTransferJs e recebido applied:false.
let cover = { applied: false, reason: "não tentado" };
for (let attempt = 1; attempt <= 3; attempt++) {
  // Tentativa primária: DataTransfer (#1500) — funciona com ou sem cover existente
  const r = await mcp__claude-in-chrome__javascript_tool({
    code: buildCoverDataTransferJs(imageUrl)
  });
  // NOTA (#2341): javascript_tool pode retornar {} para fns async longas —
  // {} NÃO significa falha. Verificar estado via get_post ou DOM re-scan.
  cover = classifyCoverVerify(r);
  if (cover.applied) break;

  // Fallback: 2-step replace (#2283) — só quando #1500 retornou applied:false
  // (ex: input[type=file] ausente na DOM após Add thumbnail não funcionar)
  const detectJs = `(() => ({
    hasCover: !!Array.from(document.querySelectorAll('img'))
      .find(i => i.offsetParent !== null && /beehiiv-images-production.*uploads/i.test(i.src))
  }))()`;
  const detect = await mcp__claude-in-chrome__javascript_tool({ code: detectJs });

  if (detect?.hasCover) {
    // Etapa 1: remover cover existente (<5s total, seguro pro CDP) (#2283)
    const step1 = await mcp__claude-in-chrome__javascript_tool({
      code: buildCoverReplaceStep1_RemoveExistingJs()
    });
    if (step1?.error) {
      log_warn(`Cover remove step1 falhou: ${step1.error}`);
      continue;
    }
    // Aguardar fora do javascript_tool — remoção React é async
    await computer.wait({ seconds: 2 });

    // Etapa 2: upload via DataTransfer após remoção (<15s total)
    const step2 = await mcp__claude-in-chrome__javascript_tool({
      code: buildCoverReplaceStep2_UploadJs(imageUrl, "04-d1-2x1.jpg", step1.existingSrc ?? "")
    });
    cover = classifyCoverVerify(step2);
  } else {
    // Sem cover existente + #1500 retornou applied:false = input[type=file] ausente.
    // Recuperação: clicar "Add thumbnail" para expor o input antes de re-tentar #1500.
    // Se após 3 tentativas ainda applied:false, não há fallback 2-step (o 2-step exige
    // cover existente para remover). Emitir aviso e deixar cover_status:stale_pending_manual.
    log_warn(`Cover tentativa ${attempt}/3: #1500 retornou applied:false, sem cover existente pra remover. Reason: ${cover.reason}. Tentando clicar "Add thumbnail" para expor input[type=file]...`);
    // Clicar o botão "Add thumbnail" (expõe input[type=file] que estava oculto)
    await computer.left_click_text("Add thumbnail");
    await computer.wait({ seconds: 1 });
    // A próxima iteração do loop vai re-tentar buildCoverDataTransferJs com o input exposto
  }

  if (cover.applied) break;
  if (attempt < 3) {
    log_warn(`Cover tentativa ${attempt}/3 falhou: ${cover.reason}. Retry em ${attempt * 5}s...`);
    await computer.wait({ seconds: attempt * 5 });
  }
}
```

**Verificação via API após apply (#2341):** `mcp__claude_ai_Beehiiv__get_post` expõe `thumbnail_url` (campo presente no schema — READ, não plan-gated). Após `applied: true` via DOM, verificar que `thumbnail_url` mudou vs. valor anterior — o asset id muda em cada replace. Isso confirma que a cover foi realmente persistida no backend, não só na DOM. Exemplo:

```typescript
const postBefore = await mcp__claude_ai_Beehiiv__get_post({ post_id });
// ... apply cover ...
const postAfter = await mcp__claude_ai_Beehiiv__get_post({ post_id });
const coverChanged = postAfter.thumbnail_url !== postBefore.thumbnail_url;
```

> **⚠️ #1705 (atualizado em #2340):** o campo `thumbnail_image_url` existe no schema do MCP (`edit_post`/`save_post`), mas está **gated por plano pago do Beehiiv** (plano atual = Launch/free). Por enquanto, o único caminho viável para SETAR a cover é Chrome/#1500. O campo `thumbnail_url` de `get_post` (READ-only) **está disponível** e muda quando a cover é substituída — útil para verificação pós-apply. Ver #2340 para a decisão de upgrade de plano.

**Regra (não declarar done silenciosamente):** **NUNCA** declare "capa aplicada" sem `classifyCoverVerify` retornar `applied: true`. E, simetricamente, **NUNCA** escreva `cover_status: stale_pending_manual` ou `cover_replace_failed` sem ter chamado `buildCoverDataTransferJs` (#1500) e recebido `applied: false` em resposta — ter chamado #1500 e obtido `applied: false` é pré-condição para declarar falha, não consequência. Se após 3 tentativas `applied: false`, **SEMPRE** emita no gate e no resumo final:

```
⚠️ Cover NÃO confirmada (${cover.reason}) — suba manualmente no Beehiiv
   (Add thumbnail → arrastar/escolher 04-d1-2x1.jpg).
```

Falha de cover **não bloqueia** teste de email nem publicação — Beehiiv usa fallback da publication. Mas thumb correto melhora OG previews em LinkedIn/Twitter shares.

**⚠️ DEPRECATED (#1705) — NÃO usar como primário:** o fluxo legado "Use from library → **Upload from URL**" (`buildCoverUploadJs` + `buildCoverApplyLocateJs`) sobe a imagem pro media library mas **não aplica** como thumbnail na UI atual (clicar o card abre preview, não aplica). Em 260604 falhou em 4 tentativas; o DataTransfer aplicou de primeira. Mantido no helper só como fallback histórico.

**⚠️ DEPRECATED (#2283) — `buildCoverReplaceJs` legado:** combina remoção + upload num único call e causa CDP timeout (45s) quando há cover existente. Usar `buildCoverDataTransferJs` (#1500) como primário (cover nova e replace); só usar `buildCoverReplaceStep1_RemoveExistingJs` + `buildCoverReplaceStep2_UploadJs` separados como fallback quando #1500 retornar `applied:false`.

### 5. Preencher corpo — Custom HTML block (#74 fluxo novo)

**Fluxo drasticamente simplificado** vs versão anterior. Em vez de N blocos separados (destaques, É IA?, seções), um único bloco Custom HTML recebe todo o corpo.

#### 5.1 Usar template "HTML" (não "Default") — #1054 finding

**⚠️ INSTRUÇÃO CRÍTICA (#1054 smoke test 2026-05-10)**: TipTap renderiza em React state — `mcp__claude-in-chrome__find` e `mcp__claude-in-chrome__read_page` **NÃO conseguem ver** elementos do editor (`.node-htmlSnippet`, `.tiptap.ProseMirror`, etc). Use **`mcp__claude-in-chrome__javascript_tool`** com `document.querySelector(...)` direto — aí enxerga tudo. Tools de accessibility só servem pra elementos React-renderizados padrão (Title, Subtitle inputs).

**Template "HTML"** (já existe na template-library) cria post com `node-htmlSnippet` pré-instantiado e vazio, pronto pra receber HTML. Template "Default" NÃO tem htmlSnippet — não usar.

Fluxo (TODOS via `javascript_tool`, não `find`/`read_page`):
1. Navegar pra `https://app.beehiiv.com/posts/template-library?tab=my_templates`
2. Aguardar load (~3s) via `wait` ou `setTimeout` no JS
3. **Criar o post via CLIQUE REAL (#1764)** — ⚠️ NÃO usar `.click()` sintético (`buildHtmlTemplateClickJs` está @deprecated): o React gateia a criação por user-activation, então `.click()` via JS **não cria o post** (abre o menu de contexto, fica em /template-library). O fluxo correto é ⋮ → "Use template" com `computer.left_click` real:
   1. Dispatch `buildHtmlTemplateMenuLocateJs()` (de `scripts/lib/beehiiv-template-click.ts`) → localiza o botão **⋮** do card "HTML" e devolve `{ found, rect, innerWidth }`.
   2. Converter o rect pro espaço do screenshot com `resolveClickPoint(locate, screenshotWidth)` (de `scripts/lib/beehiiv-real-click.ts`) — **gotcha #1764**: o screenshot pode vir em largura diferente do viewport (ex.: 1568px vs 1910px), e `computer` clica no espaço do screenshot; o helper faz `factor = screenshotWidth / innerWidth` e devolve `{x, y}` já convertidos.
   3. `computer.left_click` no `{x, y}` → abre o dropdown (Use template ›, Edit, Preview…).
   4. Dispatch `buildUseTemplateItemLocateJs()` → localiza o item **"Use template"**; `resolveClickPoint` + `computer.left_click` real nele → cria o post + navega pra `/posts/{novo-uuid}/edit` com htmlSnippet pronto.
4. Aguardar editor carregar (~3-5s) — URL muda pra `/posts/{uuid}/edit`
5. **Via `javascript_tool`**: validar URL + DOM. URL **deve** matchar `/posts/{uuid}/edit` (post real), NÃO `/templates/posts/{uuid}/edit` (template rogue). Helper `validateTemplateClickUrl()` em `scripts/lib/beehiiv-template-click.ts` faz essa distinção:
   ```js
   ({
     hasHtmlSnippet: !!document.querySelector('.node-htmlSnippet'),
     hasProseMirror: !!document.querySelector('.tiptap.ProseMirror'),
     url: location.href,
   });
   ```
   Esperar `hasHtmlSnippet: true` + `hasProseMirror: true` + `url` matchando `/posts/{uuid}/edit`. Se `url` matcha `/templates/posts/{uuid}/edit` → template rogue — navegar back, retry passo 3 (max 3 vezes). Se ainda falhar, halt com instrução pro editor deletar template manualmente.

Se o template "HTML" não estiver na library (heading "HTML" não encontrada), abortar com `{ "error": "html_template_missing", "remediation": "Editor precisa criar template chamado exatamente 'HTML' contendo apenas um node-htmlSnippet vazio em https://app.beehiiv.com/posts/template-library" }`.

#### 5.2 Colar HTML — paste híbrido (#1046, validado em #1054)

**Status técnico** (2026-05-10): caminho deterministic validado live; falta apenas otimização de tokens via Cloudflare Worker host (decisão pendente em #1054).

**Pré-requisitos**:
- Post criado a partir do template "HTML" (passo 5.1) com `node-htmlSnippet` vazio pré-instantiado.
- `_internal/newsletter-final.html` (gerado em 1.3) com URLs Drive substituídas. Modo `--split` é compatível: `newsletter-body.html` + `newsletter-eia.html` podem ser pasted sequencialmente.

**Insight crítico (#1054 validação live, 2026-05-10)**: pastando dentro do `node-htmlSnippet` (não no editor principal), TipTap **NÃO normaliza** os links — merge tags `{{poll_a_url}}/{{poll_b_url}}` sobrevivem porque o htmlSnippet é raw HTML por design. Validação concreta:

```
Test: ClipboardEvent paste com '<a href="{{poll_a_url}}">Votar A</a>' inside htmlSnippet
Result: has_poll_a_url_in_text: true ✅
        has_poll_a_url_in_html: true ✅
        has_poll_a_url_in_editor: true ✅
```

Isso elimina necessidade do split body/È IA? do #1046 — newsletter completa (~16KB) cabe num único htmlSnippet, todas as merge tags preservadas.

**Fase 1 — Validar acesso ao TipTap editor + htmlSnippet existem:**

⚠️ **Nota arquitetural (#1054 validação E2E, 2026-05-10)**: o paste real precisa atualizar **ProseMirror state** (não só DOM). `document.execCommand('insertText')` modifica DOM mas Beehiiv autosave serializa do `editor.state.doc`, então conteúdo via execCommand **não persiste após reload**. Validação concreta: paste de 16KB via execCommand → DOM tinha 16K → reload → só 78 chars persistiram.

A path correta é via TipTap commands API. O editor TipTap está acessível diretamente via `document.querySelector('.tiptap.ProseMirror').editor` (NÃO `window.editor` — esse não existe).

```js
const pm = document.querySelector('.tiptap.ProseMirror');
const editor = pm?.editor;
const node = document.querySelector('.node-htmlSnippet');
({
  hasEditor: !!editor,
  hasCommands: !!editor?.commands,
  hasNode: !!node,
  isEmpty: node?.classList.contains('is-empty'),
});
```

Esperar `hasEditor: true`, `hasCommands: true`, `hasNode: true`, `isEmpty: true`. Se editor for undefined, esperar 1-2s e retentar (TipTap pode estar inicializando).

**⚠️ #2283 — Template pode carregar conteúdo da edição ANTERIOR (`isEmpty: false`).** O template "HTML" salvou o htmlSnippet da última run se o draft anterior não foi limpado antes de salvar. Se `isEmpty: false`, **NÃO prosseguir pro paste** sem antes limpar o snippet:

```typescript
import { buildSnippetClearJs } from "scripts/lib/beehiiv-cover-upload.ts";

// Fase 1b — limpar snippet stale se não vazio
if (!isEmpty) {
  const clearResult = await mcp__claude-in-chrome__javascript_tool({ code: buildSnippetClearJs() });
  // clearResult: { isEmpty, cleared, bytesCleared?, docSizeAfter, error? }
  if (clearResult?.error) {
    log_warn(`Snippet clear falhou: ${clearResult.error} — paste pode sobrepor conteúdo stale`);
  } else if (clearResult?.cleared) {
    log_info(`Snippet limpo: ${clearResult.bytesCleared} bytes removidos. Prosseguindo com paste.`);
  }
  // Aguardar autosave da limpeza (fora do javascript_tool — não desperdiça orçamento CDP)
  // computer.wait({ seconds: 3 });
}
```

Também resetar **Subtitle** se vier com valor da edição anterior (verificar se o campo tem valor diferente do `subtitle` extraído no passo 1 e sobrescrever via `buildSetFieldJs`). A Cover stale é tratada pelo fluxo §4b (replace em 2 etapas).

**Raiz do problema (#2283):** o template "HTML" do Beehiiv persiste o htmlSnippet entre usos — salvar o template enquanto com conteúdo carrega esse conteúdo na próxima criação de post. **Mitigação permanente:** nunca salvar o template "HTML" enquanto o snippet tem conteúdo (editor deve limpar manualmente antes de "Save as template" se precisar atualizar o template).

**Fase 2 — Upload HTML pro Cloudflare Worker (#1178)** — **ÚNICO caminho recomendado em runtime (#1327).**

Em vez de chunkar + pushar via `javascript_tool` (consome ~80K tokens por edição), hospedar o HTML no Worker existente (`draft.diaria.workers.dev/{edition}`). Browser fetcha direto. Custo total ~5K tokens.

```bash
npx tsx scripts/upload-html-public.ts --edition {AAMMDD}
```

Stdout (JSON) — **`url` é versionada com hash do conteúdo (#1494, #1511)**:
```json
{
  "edition": "260514",
  "url": "https://draft.diaria.workers.dev/260514-a3b2c1",
  "bytes": 28341,
  "ttl_seconds": 43200
}
```

**INVARIANTE (#1511):** o orchestrator DEVE capturar `url` do JSON stdout e usar essa URL exata no `fetch()` da Fase 3. Nunca montar `DRAFT_WORKER_BASE + '/' + edition` manualmente — o hash muda a cada upload e a URL sem hash retorna 404.

Pré-requisitos:
- `ADMIN_SECRET` (ou `POLL_ADMIN_SECRET`) no env — Worker valida HMAC do PUT.
- `_internal/newsletter-final.html` (gerado em 1.3).

TTL 12h no KV — cobre paste do dia + retries no mesmo turno. Re-rodar sobrescreve sem duplicar. Janela curta reduz risco de leak do gabarito É IA? se alguém chutar `/html/{próxima-edition}` antes do envio.

**Revisão online antes do paste**: a URL retornada (`url` no JSON) renderiza o HTML cru no browser. Use pra revisar o conteúdo final no celular/desktop antes de colar no Beehiiv — botões A/B do poll funcionam, imagens carregam. **Não substitui o test email do Beehiiv** (CSS específico do email client não está aplicado), mas é suficiente pra revisão de conteúdo. Apresentar a URL ao editor explicitamente: "Newsletter pronta pra revisão: {url} — confirme paste no Beehiiv?".

**Fallback automático Worker→chunked**: se `upload-html-public.ts` falhar (exit code não-zero — Worker 5xx, network, ADMIN_SECRET ausente, etc.), cair direto pra apêndice "Fallback chunked (legacy)" no fim do arquivo — sem perguntar. Log do erro vai pra `data/run-log.jsonl`. Caso comum: Worker em manutenção; chunked sempre funciona offline-after-chunk. **Mas se Worker estiver up, NUNCA proponha o caminho chunked como primeira opção em runtime — é 16× mais caro em tokens.**

**Fase 3 — Fetch + paste via TipTap `editor.commands.insertContent` (#1178)**:

Browser baixa HTML direto do Worker e cola no editor TipTap. Single javascript_tool call (~5K tokens vs ~80K do chunked flow).

```js
// (1 chamada javascript_tool — fetch + decode + insertContent)
// IMPORTANTE: usar a URL versionada retornada por upload-html-public.ts (#1511)
// NÃO usar 'https://draft.diaria.workers.dev/{edition}' sem hash — retorna 404
(async () => {
  const res = await fetch('{DRAFT_PREVIEW_URL}'); // ex: https://draft.diaria.workers.dev/260514-a3b2c1
  if (!res.ok) return { error: `fetch ${res.status}` };
  const html = await res.text();

  const pm = document.querySelector('.tiptap.ProseMirror');
  const editor = pm?.editor;
  if (!editor) return { error: 'no editor' };

  let htmlSnippetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'htmlSnippet') {
      htmlSnippetPos = pos;
      return false;
    }
  });
  if (htmlSnippetPos === null) return { error: 'no htmlSnippet' };

  const tr = editor.state.tr;
  const $pos = editor.state.doc.resolve(htmlSnippetPos + 1);
  tr.setSelection(editor.state.selection.constructor.near($pos));
  editor.view.dispatch(tr);

  const ok = editor.commands.insertContent({ type: 'text', text: html });
  return { inserted: ok, htmlBytes: html.length, docSize: editor.state.doc.content.size };
})()
```

**Aguardar autosave e verificar persistência antes de navegar (#2375)**: após `insertContent`, **NÃO navegar imediatamente para `?step=review` ou qualquer outra URL**. O TipTap autosalva via `onChange` após debounce — se `navigate()` ocorre antes do debounce/fetch de autosave completar, o servidor não tem o conteúdo atualizado e o test email é enviado do conteúdo anterior, causando fix-loops desnecessários (incidente 260619: 4 iterações + 2 sem email = ~90min no Stage 5).

**Passo obrigatório antes de qualquer navigate pós-insertContent:**

1. Aguardar debounce do autosave (2s fora do `javascript_tool`):
   ```
   computer.wait({ seconds: 2 })
   ```

2. Verificar via JS que o conteúdo esperado está no editor (varredura direcionada #1766 — NÃO getJSON):
   ```js
   // Verificar que o conteúdo foi inserido corretamente no ProseMirror state
   const editor = document.querySelector('.tiptap.ProseMirror')?.editor;
   let hasPollA = false;
   editor?.state.doc.descendants((n) => {
     if (n.isText && n.text?.includes('{{poll_a_url}}')) hasPollA = true;
   });
   ({ hasPollA, docSize: editor?.state.doc.content.size });
   ```
   Se `hasPollA: false` ou `docSize` for muito pequeno, o insertContent não persistiu — **não prosseguir** antes de re-paste.

3. Forçar flush do autosave via blur do editor:
   ```js
   document.querySelector('.tiptap.ProseMirror')?.blur();
   ```
   Aguardar mais 1.5s (fora do `javascript_tool`) para o autosave terminar o fetch ao servidor:
   ```
   computer.wait({ seconds: 1.5 })
   ```

4. **Somente após os passos 1–3** navegar para `?step=review` ou salvar o draft.

**Resumo**: debounce (2s) → JS verify → blur → flush wait (1.5s) → navigate. Total ~3.5s garantidos pós-insertContent antes de qualquer navigate. Validação opcional via reload + ler `editor.state.doc.content.size` (NÃO `getJSON()` — #1766): deve manter `docSize` constante.

⚠️ **Crítico (#1054 validação E2E, 2026-05-10)**: o ÚNICO método validado que persiste após autosave + reload é `editor.commands.insertContent({ type: 'text', text: html })`. Métodos descartados:

- ❌ `ClipboardEvent` synthetic dispatch — `defaultPrevented: false`, content nem entra no DOM
- ❌ `document.execCommand('insertText', false, html)` — atualiza DOM (codeLen=16K) mas NÃO atualiza ProseMirror state. Autosave captura state → reload mostra apenas 78 chars (estado pré-paste)
- ❌ `editor.commands.insertContent(htmlString)` — TipTap parseia como HTML, falha em `RangeError: Invalid content for node tableCell` por causa do schema

A solução validada: passar como **text node literal** (`{ type: 'text', text: ... }`) — TipTap não parseia, htmlSnippet armazena raw HTML como texto puro.

Detalhes do caminho chunked-base64 (fallback legacy) estão no apêndice no fim deste arquivo.

**`window.editor` global NÃO existe no Beehiiv** (`window.editor`, `window.tiptapEditor`, `window.__tiptapEditor` todos undefined). O editor TipTap está acessível diretamente em `document.querySelector('.tiptap.ProseMirror').editor` — esse path foi validado em E2E #1054.

**Não usar `--split` mode**: o split body/eia.html foi proposto em #1046 quando achávamos que merge tags morriam. Validação live em #1054 mostrou que paste-into-htmlSnippet preserva merge tags — então `newsletter-final.html` único é a forma correta. Modo `--split` continua existindo no renderer pra fluxo legado, mas o agent novo usa o single-file.

#### 5.3 Pós-paste — verificação dos merge tags via ProseMirror state

> **#1766 — NUNCA usar `editor.getJSON()` / `JSON.stringify(doc)` pra verificar.**
> Serializar o doc ProseMirror inteiro (htmlSnippet ~30KB colado como text node)
> estoura o limite de **45s do CDP `Runtime.evaluate`** → `CDP sendCommand timed
> out, renderer may be frozen` (assusta e leva a re-paste desnecessário). Caso
> real 260603: 2 verificações via getJSON deram timeout. Use **varredura
> direcionada** com `doc.descendants` procurando só as strings-alvo nos text
> nodes — retorna em <1s, não serializa nada.

```js
// Varredura direcionada (#1766) — NÃO serializa o doc inteiro.
const editor = document.querySelector('.tiptap.ProseMirror')?.editor;
const found = { hasA: false, hasB: false };
editor.state.doc.descendants((n) => {
  if (n.isText && n.text) {
    if (n.text.includes('{{poll_a_url}}')) found.hasA = true;
    if (n.text.includes('{{poll_b_url}}')) found.hasB = true;
  }
});
({ ...found, docSize: editor.state.doc.content.size });
```

Se `hasA` ou `hasB` for `false`, registrar em `unfixed_issues[]` com `reason: "merge_tag_stripped_{a|b}"`. Editor pode adicionar manualmente via UI.

**#1766 — wait fora do `javascript_tool`.** NÃO colocar `await new Promise(r=>setTimeout(r,8000))` DENTRO de uma chamada `javascript_tool` — o wait conta pro orçamento dos 45s do CDP. Faça o wait via `computer.wait` (ou esperar entre chamadas MCP) e mantenha cada `javascript_tool` curto e numa chamada separada.

**Salvar o bloco**: Beehiiv auto-saves após ~5s do último input. **Antes de navegar para `?step=review` ou salvar o draft, executar OBRIGATORIAMENTE o "Passo obrigatório antes de qualquer navigate pós-insertContent" da §5.2 Fase 3 (#2375)** — debounce 2s → JS verify (`doc.descendants`) → `blur()` → flush 1.5s. O blur força o flush do autosave ao servidor; pular o blur torna o wait de tempo fixo insuficiente em conexões lentas. Validação opcional adicional: reload da page e re-checar via a varredura `descendants` acima — `docSize` e markers críticos devem permanecer iguais. Se docSize voltar pro valor pré-paste, autosave não capturou — investigar (timing, transação rolled back, schema rejection).

**⚠️ #2283 — CDP timeout no editor trava o autosave.** Se qualquer `javascript_tool` retornar `CDP Runtime.evaluate timed out after 45000ms` (ou equivalente) **enquanto o editor está aberto**, o autosave do Beehiiv pode congelar: `updated_at` fica fixo e campos setados **após** o timeout (Subtitle, Subject) param de persistir mesmo com retry. Sintomas:

- `updated_at` constante após edições subsequentes.
- Subtítulo não persiste via nenhum método (execCommand, native setter, teclado real).
- Body + título (setados ANTES do timeout) persistem normalmente.

**Procedimento obrigatório após qualquer CDP timeout no editor:**

1. **Registrar** o timeout em `unfixed_issues[]` com `reason: "cdp_timeout_{step}"` e o valor `docSize` no momento.
2. **Reload da página** (`navigate` pra mesma URL do draft): forçar re-inicialização do renderer.
3. **Re-verificar persistência** via varredura `doc.descendants` (merge tags + docSize). Se docSize voltou ao pré-paste, o autosave não capturou — re-paste obrigatório.
4. **Re-setar campos afetados** (Subtitle, Subject) via keyboard real (`computer` click + type) pós-reload, e confirmar persistência via `get_post` antes de prosseguir.
5. **NUNCA tentar re-setar campos sem reload** — o renderer frozen não aceita writes, mesmo que a UI pareça responsiva.

**Raiz do problema (#2283):** o timeout do CDP congela o renderer do Beehiiv e o IPC do autosave. Reload restaura o IPC. Prevenção permanente: nunca combinar operações longas (fetch de blob + sleeps) num único `javascript_tool` — ver §4b cover replace em 2 etapas e `#1766`.

#### 5.4 Verificação pós-paste — preview

- Beehiiv não renderiza preview do htmlSnippet **dentro do editor** (htmlSnippet é raw HTML armazenado como texto, não preview visual). A verificação visual completa só acontece via "Email preview" / "Web preview" do Beehiiv ou via test email recebido (passo 7).
- **Verificação programática suficiente**: o passo 5.3 já validou via varredura `doc.descendants` (#1766) que merge tags + image URLs estão preservados na ProseMirror state. Se passou, o conteúdo está correto e o preview do email vai renderizar.
- **Validação visual opcional**: editor pode clicar em "Preview" no Beehiiv após o agent completar; URLs de imagens vêm do Cloudflare Worker KV (#1119), disponibilidade quase imediata (KV é eventually consistent, ~1-2s). Se imagem aparecer quebrada no preview, verificar (a) que upload retornou 2xx, (b) que GET na URL retorna JPEG válido (`curl -so /tmp/test.jpg <url> && file /tmp/test.jpg`), (c) re-upload via `upload-images-public.ts --mode newsletter --no-cache` se necessário.
- **Bugs do #39 tratados estruturalmente**:
  - ✅ Encoding Unicode: HTML gerado em build-time, caracteres preservados no arquivo.
  - ✅ Template items default: sem template slots = nada pra remover.
  - ✅ OUTRAS NOTÍCIAS truncada: HTML é all-or-nothing, atômico.
  - ✅ Imagens D2/D3: embeded via URL pública, sem upload via Chrome.
  - ✅ É IA? imagens: idem.

### 6. Salvar como rascunho

- **NÃO clicar em Schedule, Publish, ou Send.**
- Clicar em "Save draft" / "Save as draft".
- Capturar `draft_url` da barra de endereço (deve conter `/posts/{id}/edit`).

**Por que o playbook para no draft (não tenta Schedule via automação)** (#1198, 2026-05-12): testado 5 mecanismos pra clicar "Publish on..." no modal Schedule do Beehiiv — `computer.left_click` por coord, `find` + ref, `btn.click()` via JS, `PointerEvent` dispatch synthetic, `props.onClick(fakeEvent)` direto no React fiber. Todos foram silenciosamente rejeitados (modal não fecha, status permanece `draft`, `scheduled_at` null). Provável guard de user-activation (gesto humano real) no Beehiiv pra ações de blast radius alto (publicação real pra audiência). Conclusão: **Schedule é sempre manual**, mesmo se o resto do flow rodar 100% automático — não vale gastar mais ciclos tentando contornar.

### 6.5. Setar Subject line do email (#610)

Antes de enviar o test email, garantir que o Subject está correto.
Beehiiv aplica subject automático baseado em template — pode herdar o
título da edição anterior (caso real 260505: test email veio com D1
de 260504). Setar explicitamente evita re-envio manual.

1. **Localizar campo Subject**: navegar pra área de configurações do post
   (geralmente menu "..." ou aba "Settings"/"Email" no painel lateral).
   Encontrar input com label "Subject" ou "Subject line".
2. **Limpar** o conteúdo existente (triple-click ou Ctrl+A + Delete).
3. **Setar valor**: usar o `title` extraído no passo 1 (que já é o D1 title).
   - **Sempre** setar apenas `{title}` (igual em modo normal e test).
   - **NUNCA prefixar `[TEST] ` manualmente** (#1215): Beehiiv auto-adiciona o prefixo `[TEST] ` em qualquer email enviado via "Send test email". Setar manualmente vira `[TEST] [TEST] {title}` no inbox do editor — bug silencioso em produção há tempo.
4. **Confirmar**: tab away do input pra trigar save automático.
5. **Verificar**: ler o valor de volta via `read_page` e confirmar que bate
   com o esperado. Se Beehiiv re-aplicou template default sobrescrevendo, retry 1×.
6. Re-salvar o draft (botão "Save draft" novamente).

Se o campo Subject não for encontrado após 2 tentativas, registrar em
`unfixed_issues[]` com `reason: "subject_field_not_found"` e prosseguir
com o test email — editor pode editar manualmente.

### 6.6. Confirmar que o título PERSISTIU na API antes do test email (#1645)

**Bloqueador determinístico — NÃO enviar o test email enquanto o título não persistir.** O autosave do Beehiiv tem latência (#1198) e o título setado via Chrome pode levar segundos pra serializar no backend; setters programáticos (execCommand/setNative) **nunca** persistem (memory `feedback_beehiiv_title_real_keystrokes` — usar teclado real). Em 260601 o `get_post` retornou `"New post"` por minutos. Sem este guard, o test email sai com subject errado e o loop de review só pega depois (ou nem pega).

Procedimento (retry pra absorver a latência do autosave):

1. Esperar ~8s após o blur do campo título.
2. `mcp__claude_ai_Beehiiv__get_post` com o `post_id`.
3. Comparar `post.title` (e `post.subject_line` / `email_settings.email_subject_line`) com o `{title}` esperado.
4. Se `post.title === "New post"` ou diverge do esperado: re-setar o título via **teclado real** (computer click + ctrl+a + Delete + type + blur), esperar ~8s, repetir o `get_post`. Até 3 tentativas.
5. Só prosseguir pro passo 7 quando `post.title` bater com o esperado. Se após 3 tentativas ainda divergir, **halt** (render-halt-banner) — não enviar test email com subject errado.

### 7. Enviar email de teste

**⚠️ Rate limit silencioso #1419**: Beehiiv tem rate limit em "Send test email" (~10 sends/hora). Sends posteriores são absorvidos sem erro visual nem API error — popover de sucesso aparece mas o email NÃO chega ao Gmail. Em 260520, sends 11-14 foram stale; loop verify→fix iterou sobre o 10º (mais antigo). Antes de cada click, consultar o counter:

```typescript
import { loadSendCount, recordSend, decideWarnLevel, shouldResetWindow, getCountFilePath } from "scripts/lib/beehiiv-send-count.ts";
import { unlinkSync, existsSync } from "node:fs";

// Reset natural se janela 1h passou desde último send (rate limit resetou)
const state = loadSendCount(edition_dir);
if (state && shouldResetWindow(state.last_sent_at)) {
  const countPath = getCountFilePath(edition_dir);
  if (existsSync(countPath)) unlinkSync(countPath);
}

// Decide warn/block antes do send
const current = loadSendCount(edition_dir);
const decision = decideWarnLevel(current?.count ?? 0);
if (decision.level === "block") {
  halt(`Block: ${decision.message}`);
}
if (decision.level === "warn") {
  log_warn(decision.message);
}

// ... click Send test email ...
recordSend(edition_dir, true);
```

**⚠️ Limite de test emails por post (#2376)**: além do rate limit por hora, o Beehiiv tem um limite de test emails **por post**. Ao atingir, "Send test email" retorna "Test send limit exceeded" sem aviso visual proativo — popover de sucesso pode aparecer mas o email NÃO chega. Incidente 260619: 4 iterações + 2 sem email = ~90min no Stage 5 por não detectar o limite.

Antes de cada "Send test email", verificar o contador por post:

```typescript
import {
  readTestEmailCount,
  incrementTestEmailCount,
  setTestEmailCount,
  markDraftVerified,
  decideTestSendAction,
} from "scripts/lib/beehiiv-test-send-limit.ts";
import { logEvent } from "scripts/lib/run-log.ts";

// Checar contador antes do send
const currentCount = readTestEmailCount(edition_dir);
const limitDecision = decideTestSendAction(currentCount);

if (limitDecision.action === "use_draft_fallback") {
  // Limite possivelmente atingido — não tentar send; verificar via draft link
  logEvent({
    edition: AAMMDD,
    stage: 5,
    agent: "beehiiv-playbook",
    level: "warn",
    message: "test_send_limit_reached",
    details: { test_email_count: currentCount, draft_url, edition_dir },
  });
  // markDraftVerified só funciona se 05-published.json já existe (modo fix).
  // Em modo create, draft_verified é gravado no passo 8 (ver abaixo).
  const marked = markDraftVerified(edition_dir);
  if (!marked) log_warn("draft_verified não persistido — 05-published.json ainda não gravado (modo create); setar no passo 8");
  // NÃO executar o click "Send test email" — pular pro fallback de draft link abaixo.
}

if (limitDecision.action === "alert") {
  log_warn(limitDecision.message);
  // Avisar o editor mas ainda tentar o send
}

// ... (só se action !== "use_draft_fallback") click Send test email ...
recordSend(edition_dir, true); // rate-limit por hora (#1419)

// ⚠️ ORDERING (#2376 review): em modo CREATE, 05-published.json ainda NÃO existe
// neste ponto (é gravado no passo 8). Portanto:
//  - NÃO chamar incrementTestEmailCount aqui em modo create — ela retorna null
//    (increment perdido) porque o arquivo não existe.
//  - Em vez disso, rastrear o nº de sends numa variável local (sends_done++) e
//    gravar test_email_count: sends_done no passo 8 via setTestEmailCount OU no
//    próprio objeto JSON do passo 8.
//  - Em modo FIX (Passo fix-3), 05-published.json JÁ existe da run de create →
//    chamar incrementTestEmailCount(edition_dir) e checar o retorno:
//      const newCount = incrementTestEmailCount(edition_dir);
//      if (newCount === null) log_warn("increment de test_email_count perdido — verificar 05-published.json");
```

**Fallback de verificação via draft link (quando limite por post atingido):**

Quando `use_draft_fallback`, verificar o conteúdo diretamente no draft do Beehiiv com checklist explícita:

1. Abrir `draft_url` no Beehiiv.
2. Usar "Preview" do Beehiiv (aba "Preview" ou botão "Preview email") para ver o render HTML.
3. Verificar manualmente com a seguinte checklist (substitui o `review-test-email` via Gmail):
   - [ ] Título e subtítulo corretos
   - [ ] Imagens de destaque carregam (D1, D2, D3)
   - [ ] Imagens É IA? carregam (A e B)
   - [ ] Botões de voto do É IA? têm URLs de voto (mesmo que `{{poll_a_url}}` — são merge tags)
   - [ ] 3 destaques presentes (ou 2 se edição com 2 destaques)
   - [ ] Seção USE MELHOR presente
   - [ ] Seção RADAR presente
   - [ ] Seção OUTRAS NOTÍCIAS não está truncada
   - [ ] Nenhum placeholder `[TODO]` ou `[FALTA]` visível
4. Registrar `draft_verified: true` em `05-published.json`:
   - **Modo fix** (arquivo já existe): `markDraftVerified(edition_dir)` — checar o retorno `true`; se `false`, logar warn (write falhou).
   - **Modo create** (arquivo ainda não gravado): incluir `"draft_verified": true` diretamente no objeto JSON do passo 8.
5. Prosseguir para o passo 8 (gravar `05-published.json`) com `draft_verified: true` e `test_email_count` = nº de sends já tentados.

**⚠️ Wiring do skip (#2376 review):** o campo `draft_verified: true` **registra** que a verificação foi via draft, mas o pulo do `review-test-email` loop NÃO está automatizado no `orchestrator-stage-5.md` (que mantém a regra "este loop nunca deve ser pulado"). Em modo `use_draft_fallback`, o top-level que lê este playbook deve: (a) marcar `draft_verified: true`, (b) registrar em `unfixed_issues[]` `{ reason: "verified_via_draft_link", section: "test-email", details: "limite de test email por post atingido" }`, e (c) tratar a checklist de draft acima como o resultado do loop (não despachar `review-test-email` de novo só pra ver "nenhum email"). Isso é decisão do top-level, não enforcement determinístico — documentado aqui de propósito (evita editar o orchestrator e disparar o snapshot test #634).

- Abrir menu de testes → enviar para `test_email` → confirmar.
- Capturar timestamp:
  ```bash
  node -e "process.stdout.write(new Date().toISOString())"
  ```

### 8. Gravar `05-published.json`

```json
{
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "title": "...",
  "subject_set": "...",
  "template_used": "Default",
  "test_email_sent_to": "vjpixel@gmail.com",
  "test_email_sent_at": "2026-04-18T12:34:56.789Z",
  "status": "draft",
  "unfixed_issues": [],
  "test_email_count": 1,
  "draft_verified": false
}
```

`test_email_count` (#2376): número de test emails enviados para este post neste pipeline (não reseta com janela de 1h como o counter de #1419 — este é por post). **Em modo create**, este passo 8 grava o nº de sends feitos no passo 7 diretamente no objeto JSON (o arquivo não existia durante o passo 7). **Em modo fix**, `incrementTestEmailCount()` de `scripts/lib/beehiiv-test-send-limit.ts` incrementa a cada send (o arquivo já existe). Quando o valor lido por `readTestEmailCount()` >= `TEST_SEND_ALERT_THRESHOLD` (3), o playbook alerta; quando > 3, cai no fallback de draft link. `incrementTestEmailCount`/`setTestEmailCount`/`markDraftVerified` persistem via `writeFileAtomic` (#1132) — `05-published.json` é output crítico, write não-atômico corromperia o resume detector.

`draft_verified` (#2376): `true` indica que a verificação final foi feita via draft link + checklist explícita (não via test email recebido no Gmail). Setado por `markDraftVerified()` quando o limite de test emails por post é atingido. O `review-test-email` loop deve pular a verificação de Gmail se `draft_verified: true` e considerar o draft como verificado.

`subject_set` (#610): valor que o agent setou no campo Subject. **Não inclui** o prefix `[TEST] ` mesmo em test mode (#1215) — Beehiiv auto-adiciona o prefixo no envio. Se passo 6.5 falhou, registrar `subject_set: null` e adicionar entry em `unfixed_issues[]`.

`unfixed_issues[]` agrega problemas detectados no passo 5.3 (Verificação pós-paste) que o agent não conseguiu auto-corrigir. Formato por entrada: `{ "reason": "<code>", "section": "<where>", "details": "<optional>" }`. Se não-vazio, o editor deve revisar antes de publicar (o `review-test-email` loop pode pegar alguns mas nem todos).

### 9. Verificar slug pós-Schedule (#2011)

**⚠️ Bug confirmado 260610**: o wizard de Schedule do Beehiiv re-deriva o slug do título e **mangla acentos PT-BR** (`automação` → `automa-o`, `pânico` → `p-nico`), desfazendo o slug correto setado no passo 4a-bis (#1989). O Schedule acontece manualmente — depois que o editor clicar Schedule, verificar e corrigir o slug via API.

**Trigger**: após receber confirmação do editor que agendou (ou ao montar o relatório final), verificar o slug via MCP e corrigir se necessário.

```bash
# 1. Verificar slug atual via MCP (GET — read-only, sempre seguro)
# mcp__claude_ai_Beehiiv__get_post({ post_id: "{post_id}" })
# → inspecionar post.web_settings.slug

# 2. Computar o slug correto
npx tsx -e "
  import { seoSlug } from './scripts/lib/slug.ts';
  console.log(seoSlug('{title}'));
"

# 3. Se slugs divergirem: corrigir via API (não requer browser — PATCH direto)
npx tsx scripts/fix-post-slug.ts \
  --post-id {post_id} \
  --slug {slug_correto} \
  --execute
```

O script `fix-post-slug.ts` (#2011):
- Valida o slug alvo (detecta acentos manglados antes de enviar ao Beehiiv)
- Faz `PATCH /publications/{pubId}/posts/{postId}` com `{ web_settings: { slug } }`
- GET-verify pós-update (#573) — confirma que o slug persistiu
- Dry-run por default; `--execute` pra valer

**Saída esperada (JSON):**
```json
{
  "post_id": "post_...",
  "slug_before": "anthropic-lanc-a-fable-5-com-bloqueios-embutidos",
  "slug_after": "anthropic-lanca-fable-5-com-bloqueios-embutidos",
  "slug_target": "anthropic-lanca-fable-5-com-bloqueios-embutidos",
  "updated": true,
  "verified": true,
  "dry_run": false
}
```

**Se `fix-post-slug.ts` falhar** (API não suportou o campo, ou slug não persistiu após update): aba visível com o post já agendado (step=web), clicar no campo `#text-input-slug`, selecionar tudo, digitar o slug correto via teclado real (validado em 260610 que keystrokes reais persistem mesmo com status `scheduled` — `scheduled_at` não é alterado pela edição do slug).

**Hipótese a validar (próxima edição):** setar o slug DEPOIS do título estabilizar (após confirmação da API pós-autosave) e apenas ANTES do clique de Schedule pode evitar a re-derivação. Documentar resultado em #2011.

### 10. Verificar estado pós-Schedule: agendado vs publicado imediato (#2074)

**⚠️ Bug confirmado 260611**: o editor respondeu "agendado" após clicar no Beehiiv,
mas a API mostrou `status: published` com `publish_date ≈ now` — o clique foi
**Publish (envio imediato às 22:46 BRT)**, não o Schedule matinal (06:00). O
`status: "confirmed"` da API é ambíguo (ver `resolveBeehiivState` em
`scripts/lib/publish-state.ts`) — só `publish_date` vs `now` distingue
agendado de publicado.

**Trigger**: após o editor confirmar que agendou ("agendado", "ok", "pronto" ou
equivalente), **SEMPRE** executar:

```bash
# 1. Verificar estado via API determinística (#573)
npx tsx scripts/verify-scheduled-post.ts \
  --post-id {post_id} \
  --edition-dir {edition_dir}
```

**Exit codes e ações:**

| Exit | Estado (JSON `state`) | Ação |
|------|----------------------|------|
| `0` | `scheduled` — agendado corretamente | Confirmar horário: "Agendado para {scheduled_at} ✓ — {data_alvo} 06:00 BRT" |
| `1` | `published` — envio imediato detectado | Ver sequência de reconciliação abaixo |
| `2` | `unknown` / `draft` / erro de API / config ausente | Alertar editor; verificar manualmente no dashboard Beehiiv (`get_post` via MCP + inspecionar `publish_date` vs agora) |

**Banner pré-Schedule (exibir ANTES de pedir confirmação ao editor):**

Antes de pedir ao editor que clique em Schedule, exibir o alvo explícito.
`{data_alvo}` = data da edição derivada do `edition_dir` (ex: `260612` → `12/06/2026`):

```
Próximo passo: clicar em Schedule → selecionar AMANHÃ {data_alvo} → 06:00 BRT.
NÃO clique em "Publish now" — isso dispara envio imediato pra toda a audiência.
```

**Sequência de reconciliação (exit 1 — publicado imediato):**

O script já atualiza `05-published.json` (status → published, published_at).
Executar obrigatoriamente:

```bash
# 2. close-poll — finalizar scores de É IA? (regra CLAUDE.md: "Após publicar, rodar close-poll.ts")
npx tsx scripts/close-poll.ts --edition {AAMMDD}

# 3. refresh-dedup — regra "publicação manual requer refresh-dedup" do CLAUDE.md
npx tsx scripts/refresh-dedup.ts
```

Em seguida, relatar ao editor:
```
⚠️ ENVIO IMEDIATO DETECTADO — a newsletter foi publicada agora ({published_at}),
não agendada para amanhã 06:00 BRT.
O botão clicado foi "Publish" (envio imediato), não "Schedule".
05-published.json atualizado (status: published).
data/past-editions.md regenerado via refresh-dedup.
Ação sugerida: verificar no Beehiiv se o email já saiu ou se dá pra cancelar.
```

**Output esperado do script (JSON no stdout):**
```json
{
  "state": "scheduled",
  "post_id": "post_...",
  "scheduled_at": "2026-06-12T09:00:00.000Z",
  "published_at": null,
  "immediate_send_detected": false,
  "published_json_updated": false
}
```
Ou, no caso de envio imediato:
```json
{
  "state": "published",
  "post_id": "post_...",
  "scheduled_at": null,
  "published_at": "2026-06-11T01:46:23.000Z",
  "immediate_send_detected": true,
  "published_json_updated": true
}
```

## Output

```json
{
  "out_path": "data/editions/260418/05-published.json",
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "test_email_sent_to": "vjpixel@gmail.com",
  "unfixed_issues": []
}
```

## Regras

- **Nunca publicar nem agendar.** Sempre rascunho + email de teste.
- **Pré-render ANTES do browser** (ver passo 1). Rodar a sequência completa (`extract-destaques.ts` + `upload-images-public.ts --mode newsletter` + `render-newsletter-html.ts --format html` + `substitute-image-urls.ts`) produz `_internal/newsletter-final.html` pronto pra colar num único bloco Custom HTML — sem parsing durante a sessão.
- **Template é obrigatório e verificável.** Selecionar exatamente o template configurado em `platform.config.json` → `publishing.newsletter.template` (ex: `"Default"`). Se não encontrar um template com esse nome exato, abortar com `{ "error": "template_not_found", "expected": "Default", "available": [...] }`. **Nunca usar "Blank" ou "blank" como fallback** — criar post sem template causa problemas estruturais (É IA? ausente, boxes não separados). Após criar o post, confirmar o template usado e gravar em `template_used` no output.
- **Login expirado = abortar.** Não tente re-logar.
- **Chrome desconectado:** se qualquer chamada `mcp__claude-in-chrome__*` retornar erro de desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar), retornar imediatamente:
  ```json
  { "error": "chrome_disconnected", "last_step": "<nome do passo onde falhou>", "details": "<mensagem de erro bruta>" }
  ```
- **Upload de imagem**: aguardar conclusão antes do próximo bloco.
- **JS direto via `javascript_tool` é obrigatório no passo 5** (cursor positioning + chunked paste + verify). Use `find`/`read_page` apenas pra elementos React-padrão (Title, Subtitle inputs, botões "Save draft").
- **Não fechar a aba do Chrome ao final** — o editor pode querer revisar diretamente.

---

## Apêndice: Fallback chunked (legacy — não usar como default)

⚠️ **Atenção (#1327):** este caminho consome ~80K tokens vs ~5K do Worker-hosted (Fase 2). Só usar quando `upload-html-public.ts` falhar e o fallback automático ativar — nunca como primeira opção em runtime.

**Por que existe:** se o Cloudflare Worker estiver offline (deploy quebrado, 5xx, KV down), precisamos de um caminho que não dependa de fetch externo. Chunked base64 transmite o HTML via `javascript_tool` em pedaços de 2500 chars acumulados em `window.__b64chunks[]`.

**Quando ativa:** automaticamente via `Fallback automático Worker→chunked` (§5.2). Nunca proponha manualmente.

### Geração dos chunks

```bash
npx tsx scripts/chunk-html-base64.ts --edition-dir {edition_dir}
```

Gera `_internal/_b64_NN.txt` (~16 arquivos de 2500 chars + hashes). Cada chunk é pushado via `javascript_tool` separado acumulando em `window.__b64chunks[]`.

### Paste após acumular chunks

Em vez do `fetch + insertContent` da Fase 3 (Worker), decodifica `window.__b64chunks` antes de inserir:

```js
(() => {
  // Decodificar base64 → HTML (UTF-8 safe)
  const b64 = window.__b64chunks.join('');
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const html = new TextDecoder('utf-8').decode(bytes);

  const pm = document.querySelector('.tiptap.ProseMirror');
  const editor = pm?.editor;
  if (!editor) return { error: 'no editor' };

  // Achar posição do htmlSnippet no doc + posicionar cursor dentro dele
  let htmlSnippetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'htmlSnippet') {
      htmlSnippetPos = pos;
      return false;
    }
  });
  if (htmlSnippetPos === null) return { error: 'no htmlSnippet in doc' };

  const tr = editor.state.tr;
  const $pos = editor.state.doc.resolve(htmlSnippetPos + 1);
  tr.setSelection(editor.state.selection.constructor.near($pos));
  editor.view.dispatch(tr);

  // Insert como TEXT NODE (NÃO como HTML parseado)
  const ok = editor.commands.insertContent({ type: 'text', text: html });

  // Cleanup
  delete window.__b64chunks;

  // #1766: varredura direcionada — NÃO `JSON.stringify(editor.getJSON())`
  // (serializar o doc ~30KB estoura o timeout de 45s do CDP).
  let hasPollA = false, hasPollB = false;
  editor.state.doc.descendants((n) => {
    if (n.isText && n.text) {
      if (n.text.includes('{{poll_a_url}}')) hasPollA = true;
      if (n.text.includes('{{poll_b_url}}')) hasPollB = true;
    }
  });
  return {
    inserted: ok,
    htmlBytes: html.length,
    docSize: editor.state.doc.content.size,
    hasPollA,
    hasPollB,
  };
})()
```

Resultado esperado:
- `inserted: true`
- `docSize` ≈ `htmlBytes + 4` (overhead do nó)
- Markers críticos = `true`

Se `inserted: false` ou markers críticos forem `false`, registrar em `unfixed_issues[]` com `reason: "paste_failed"` e abortar antes do save.

**Custo medido**: newsletter 16KB = b64 22KB ≈ 4 chunks ≈ ~30K tokens (paste só), 16+ passos sequenciais. Worker-hosted (Fase 2 recomendada) faz tudo em ~5K tokens e 1 javascript_tool call.
