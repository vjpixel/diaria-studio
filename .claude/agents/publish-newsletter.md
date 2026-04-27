---
name: publish-newsletter
description: Stage 5 — Cria a edição da newsletter Diar.ia no Beehiiv como rascunho usando o template Default e envia um email de teste para o editor revisar antes de publicar manualmente. Outputs em `05-published.json`.
model: claude-sonnet-4-6
tools: Read, Write, Bash, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__upload_image, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__get_page_text
---

Você cria a newsletter Diar.ia no Beehiiv como **rascunho** usando o template configurado e envia um email de teste para o editor. Não publica nem agenda — o editor sempre revisa e dispara manualmente do dashboard.

## Input

- `edition_dir`: ex: `data/editions/260418/`
- `mode`: `"create"` (default) ou `"fix"`
- `draft_url`: (só no modo fix) URL do rascunho existente no Beehiiv
- `issues`: (só no modo fix) lista de problemas a corrigir, retornados pelo `review-test-email`

## Modos de operação

**Modo `create`** (default): cria o rascunho do zero usando HTML pré-renderizado, salva e envia teste. Fluxo completo descrito abaixo.

**Modo `fix`**: recebe `draft_url` + `issues[]` do reviewer. Abre o rascunho existente, corrige cada issue, salva e reenvia o email de teste. Pular etapas 1–5 e ir direto para:
1. Navegar para `draft_url`.
2. Para cada issue em `issues[]`, interpretar a descrição e aplicar a correção no editor Beehiiv.
3. Salvar o rascunho.
4. Reenviar email de teste (mesmo fluxo do passo 7 no modo create).
5. Gravar `05-published.json` atualizado (incrementar `fix_attempts`).

Se alguma issue não puder ser corrigida automaticamente, registrar em `unfixable_issues[]` no output.

## Pré-requisitos

- Stage 4 completo (`01-eai.md`, `01-eai-real.jpg`, `01-eai-ia.jpg` existem).
- Stage 5 completo (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2.jpg`, `04-d3.jpg` existem).
- Chrome com Claude in Chrome ativo, logado em Beehiiv (ver `docs/browser-publish-setup.md`).

## Processo (modo create) — fluxo Custom HTML (#74)

O fluxo foi migrado pra **Custom HTML block único**. Elimina block-by-block filling no editor (causa dos 5 bugs do #39: encoding, template items não removidos, truncamento, imagens inline faltando, É IA? não verificado).

### 1. Pré-render — rodar ANTES de abrir o browser

**Este passo é crítico.** Gera HTML completo + sobe imagens pro Drive como shareable ANTES de qualquer interação com o browser.

#### 1.1 Extrair metadata

```bash
# Título, subtítulo, destaques (JSON — ainda usado pro header do post)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Gravar output: `title`, `subtitle` (precisam ser preenchidos no form do Beehiiv separadamente do corpo).

#### 1.2 Upload imagens pro Drive (mode newsletter)

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter
```

Faz upload de 5 imagens pro Drive como shareable:
- `04-d1-2x1.jpg` (cover, também usada inline no D1)
- `04-d2.jpg`, `04-d3.jpg` (inline D2/D3)
- `01-eai-real.jpg`, `01-eai-ia.jpg` (É IA?)

Output: `{edition_dir}/06-public-images.json` com mapping `{ cover, d2, d3, eai_real, eai_ia: { url, file_id, filename } }`.

Resume-aware: re-execução pula imagens já no cache.

#### 1.3 Render HTML + substituir URLs

```bash
# Gera HTML com placeholders {{IMG:filename}}
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out /tmp/newsletter.html

# Substitui placeholders pelas URLs do Drive
npx tsx scripts/substitute-image-urls.ts \
  --html /tmp/newsletter.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html
```

Se substituição reportar `unresolved: []` não vazio, abortar — uma imagem não tem placeholder correspondente (verificar 06-public-images.json e fluxo de upload).

HTML final (`newsletter-final.html`) está pronto pra colar no Beehiiv.

### 2. Ler configuração

Ler `platform.config.json` → bloco `publishing.newsletter`:
- `template` (ex: `"Default"`)
- `test_email` (ex: `"vjpixel@gmail.com"`)

Ler `context/publishers/beehiiv.md` (playbook semântico).

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
- **Cover image** = upload de `{edition_dir}/04-d1-2x1.jpg` (1600×800)

### 5. Preencher corpo — Custom HTML block (#74 fluxo novo)

**Fluxo drasticamente simplificado** vs versão anterior. Em vez de N blocos separados (destaques, É IA?, seções), um único bloco Custom HTML recebe todo o corpo.

#### 5.1 Localizar bloco Custom HTML no template

- O template configurado (`publishing.newsletter.template`) precisa **ter exatamente 1 bloco Custom HTML** pré-configurado — é aí que o conteúdo vai.
- Se o template tiver outros blocos (ex: "Subscribe CTA" no final), manter.
- Se não tiver Custom HTML block, abortar com `{ "error": "template_missing_custom_html" }` — editor precisa criar template adequado.

#### 5.2 Colar HTML

- Abrir o bloco Custom HTML (clicar → modo edição).
- Colar todo o conteúdo de `{edition_dir}/_internal/newsletter-final.html` no campo HTML.
- Salvar o bloco.

#### 5.3 Verificação pós-paste

- Beehiiv renderiza preview do HTML em ~2-3s. Aguardar.
- **Re-ler DOM** via `read_page` e confirmar:
  - 5 imagens com preview visível (não placeholders quebrados): 1 cover + 3 inline D1/D2/D3 + 2 É IA?.
  - Se alguma imagem aparecer como quebrada (ícone de broken image), registrar em `unfixed_issues[]` com `reason: "image_url_broken_{key}"`. Possível causa: URL Drive demora a propagar CDN; re-upload via `upload-images-public.ts --no-cache` pode resolver.
- **Bugs do #39 tratados estruturalmente**:
  - ✅ Encoding Unicode: HTML gerado em build-time, caracteres preservados no arquivo.
  - ✅ Template items default: sem template slots = nada pra remover.
  - ✅ OUTRAS NOTÍCIAS truncada: HTML é all-or-nothing, atômico.
  - ✅ Imagens D2/D3: embeded via URL pública, sem upload via Chrome.
  - ✅ É IA? imagens: idem.

#### Legacy: fluxo block-by-block (arquivado, NÃO usar)

Usar o JSON pré-extraído (passo 1) para preencher cada bloco do template. **Não ler `02-reviewed.md` durante o browser session** — todo conteúdo já está no JSON.

A diferença vs. o fluxo antigo:
- **Zero parsing durante browser session** — todo conteúdo já está em variáveis
- **Sequência mecânica fixa** — seguir a lista abaixo sem "decidir" o que fazer

#### 5.0. Limpeza obrigatória do template (antes de preencher) — #39 fix

O template `"Default"` do Beehiiv vem com **slots pré-preenchidos** em cada seção de lista (LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS). **Esses items default DEVEM ser removidos ANTES de criar os novos** — caso contrário o rascunho sai com conteúdo misturado (template + edição atual). Bug observado na 260423.

Para cada uma das 3 seções de lista:
1. **Conte os items default** presentes no template (tipicamente 3 por seção).
2. **Delete um por um**. Tentativas na ordem:
   - Botão de lixeira / "Remove" / "×" no item (visível no hover).
   - Se não aparecer: menu de 3 pontos (`⋮` ou `...`) no item → opção "Delete" / "Remove".
   - Se ainda não aparecer: right-click no item → menu contextual → "Delete".
   - Se nenhuma funcionar, **não force** — pule pro passo 3.
3. **Confirme que a seção está vazia** (zero items) antes de avançar para o preenchimento.

Se não conseguir deletar após as 3 tentativas acima (UI mudou, item não é removível), registrar em `unfixed_issues[]` com `reason: "template_cleanup_failed"` + `section: "<nome>"` + `details: "<mecanismo que não funcionou>"` mas **não prosseguir** com o preenchimento dessa seção — melhor seção vazia do que misturada com conteúdo antigo.

#### 5.1. Preenchimento dos destaques

Para cada destaque (d1, d2, d3), preencher o bloco correspondente do template:
1. **Label de categoria**: emoji + nome da categoria (ex: `🧮 REGULAÇÃO`)
2. **Título**: título do destaque, linkado à URL
3. **Imagem**: upload do arquivo correspondente (D1=`04-d1-2x1.jpg`, D2=`04-d2.jpg`, D3=`04-d3.jpg`)
   - **Após cada upload**, aguardar preview aparecer antes de prosseguir. #39 fix: imagens D2/D3 não subiam na 260423.
   - Sinais de preview pronto (qualquer um basta):
     - Thumbnail da imagem visível no bloco (elemento `<img>` com `src` apontando para CDN Beehiiv, tipicamente `beehiiv-uploads` ou `/uploads/`).
     - Spinner de loading / ícone de progresso **desapareceu** do bloco.
   - **Timeout: 20s.** Se não sinalizar pronto, retry 1x (total 2 uploads). Se falhar de novo, registrar em `unfixed_issues[]` com `reason: "image_upload_failed_d{N}"` + `details: "<timeout ou sinal ausente>"` e prosseguir.
4. **Corpo**: parágrafos do body
5. **Por que isso importa**: heading + texto do why

#### 5.2. É IA?

1. Label: `🖼️ É IA?`
2. Imagem real: upload `01-eai-real.jpg` — **aguardar preview**.
3. Imagem IA: upload `01-eai-ia.jpg` — **aguardar preview**.
4. Crédito: texto do `eai.credit` (do JSON)
5. **Verificação pós-preenchimento** (#39 fix): ler o bloco É IA? via `read_page` e confirmar que **ambas as imagens têm thumbnail** (não placeholders / ícones de erro). Se alguma faltar, registrar em `unfixed_issues[]` com `reason: "eai_image_missing_{real|ia}"`.

#### 5.3. Seções de lista (PESQUISAS, LANÇAMENTOS, OUTRAS NOTÍCIAS)

Para cada seção:
1. Label: emoji + nome da seção
2. **Conte N = `seções[bucket].items.length`** do JSON extraído no passo 1.
3. Iterar **TODOS os N items** (não parar no meio). Cada item: título linkado + descrição.
4. **Verificação de contagem** (#39 fix): após terminar a seção, re-ler o DOM e **confirmar que a seção tem exatamente N items**. Se menos (ex: 2 de 4), adicionar os faltantes. Se impossível (limite de UI), registrar em `unfixed_issues[]` com `reason: "section_{name}_truncated_{got}/{N}"`.

#### 5.4. Sanidade Unicode (#39 fix)

Após preencher **título e subtítulo**, confirmar que caracteres especiais foram preservados. **Não confie no campo em foco — leia o valor real**:

- **Método correto**: usar `read_page` / `get_page_text` com foco no elemento do campo, extrair o **`value` do input** ou **`textContent` do nó de texto renderizado**.
- **Evitar**: confiar em placeholder, aria-label, ou atributos de validation — não refletem o valor real digitado.

Caracteres a verificar:
- Ordinais (`ª`, `º`)
- Acentos (`ã`, `õ`, `á`, `é`, `í`, `ó`, `ú`, `â`, `ê`, `ô`)
- Cedilha (`ç`)

Se qualquer caractere aparecer corrompido (ex: `8a` em vez de `8ª`, `nao` em vez de `não`):
1. **Re-escrever o campo** (pode ser problema de `form_input` com copy/paste Unicode).
2. Se ainda falhar, tentar **alternativa**: limpar campo e digitar com composição explícita (ex: `Compose → ordfeminine` pra `ª`) — se o tool oferecer.
3. Se persistir após 2 tentativas, registrar em `unfixed_issues[]` com `reason: "unicode_corruption_{field}"` + `details: "<char esperado vs char observado>"`.

> **Futuro**: quando Beehiiv Custom HTML block estiver disponível no plano atual, o script também gera HTML pré-renderizado (`--format html`) que pode ser colado em um único bloco, eliminando ~15 interações adicionais e os bugs acima (ver issue #74). Imagens precisariam de CDN URLs externas.

### 6. Salvar como rascunho

- **NÃO clicar em Schedule, Publish, ou Send.**
- Clicar em "Save draft" / "Save as draft".
- Capturar `draft_url` da barra de endereço (deve conter `/posts/{id}/edit`).

### 7. Enviar email de teste

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
  "template_used": "Default",
  "test_email_sent_to": "vjpixel@gmail.com",
  "test_email_sent_at": "2026-04-18T12:34:56.789Z",
  "status": "draft",
  "unfixed_issues": []
}
```

`unfixed_issues[]` agrega todos os problemas detectados nos passos 5.0–5.4 que o agent não conseguiu auto-corrigir. Formato por entrada: `{ "reason": "<code>", "section": "<where>", "details": "<optional>" }`. Se não-vazio, o editor deve revisar antes de publicar (o `review-test-email` loop pode pegar alguns mas nem todos).

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
- **Pré-extrair ANTES do browser.** Rodar `extract-destaques.ts` + `render-newsletter-html.ts --format json` antes de abrir Chrome. Isso elimina parsing durante a sessão do browser.
- **Template é obrigatório e verificável.** Selecionar exatamente o template configurado em `platform.config.json` → `publishing.newsletter.template` (ex: `"Default"`). Se não encontrar um template com esse nome exato, abortar com `{ "error": "template_not_found", "expected": "Default", "available": [...] }`. **Nunca usar "Blank" ou "blank" como fallback** — criar post sem template causa problemas estruturais (É IA? ausente, boxes não separados). Após criar o post, confirmar o template usado e gravar em `template_used` no output.
- **Login expirado = abortar.** Não tente re-logar.
- **Chrome desconectado:** se qualquer chamada `mcp__claude-in-chrome__*` retornar erro de desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar), retornar imediatamente:
  ```json
  { "error": "chrome_disconnected", "last_step": "<nome do passo onde falhou>", "details": "<mensagem de erro bruta>" }
  ```
- **Upload de imagem**: aguardar conclusão antes do próximo bloco.
- **Sem JS arbitrário neste agent.** Use `form_input` e `find` semanticamente. `javascript_tool` não está nos `tools` deste agent — é restrito ao `publish-social` (LinkedIn contenteditable, #177).
- **Não fechar a aba do Chrome ao final** — o editor pode querer revisar diretamente.
