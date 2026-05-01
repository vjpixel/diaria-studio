# Playbook: Beehiiv (Stage 5 — newsletter)

Roteiro semântico para o agente `publish-newsletter` operar o editor Beehiiv via Claude in Chrome. Este documento é vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://app.beehiiv.com/`
- Conta esperada: a que possui a publicação **Diar.ia** (ver `platform.config.json` → `beehiiv.publicationName`).
- Pré-condição: usuário já logado no Chrome (sessão persistida).

## Objetivo

Criar um post na publicação Diar.ia, usando o template configurado em `platform.config.json` → `publishing.newsletter.template` (default: `"Default"`), preenchido com o conteúdo da edição, **salvo como rascunho** (sem agendar, sem publicar), e enviar um **email de teste** para `publishing.newsletter.test_email`.

## Pré-render (ANTES do browser)

Antes de abrir o Chrome, rodar os scripts pra gerar HTML pronto + URLs públicas das imagens (fluxo Custom HTML, #74):

```bash
# 1. Extrair título/subtítulo do header (cabeçalho do Beehiiv)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md

# 2. Upload das 5 imagens (cover, D2, D3, eai_a, eai_b) pro Drive como shareable
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter

# 3. Renderizar HTML do corpo com placeholders {{IMG:filename}}
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out /tmp/newsletter.html

# 4. Substituir placeholders pelas URLs do Drive
npx tsx scripts/substitute-image-urls.ts \
  --html /tmp/newsletter.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html
```

Output final: `{edition_dir}/_internal/newsletter-final.html` — HTML completo com todas as imagens via CDN URLs, pronto pra colar num único bloco Custom HTML do Beehiiv. **Não ler `02-reviewed.md` durante a sessão do browser** — todo o conteúdo já está renderizado.

## Fluxo

### 1. Abrir publicação
- Navegar para `https://app.beehiiv.com/`.
- Se cair em tela de login, abortar com erro `"Beehiiv login expirado — re-loga no Chrome e re-roda o stage"`.
- Selecionar workspace **Diar.ia** se houver seletor.

### 2. Criar novo post
- Barra lateral → **Posts**.
- Botão **New post** (canto superior direito).
- Aparecerá modal/página de seleção de template.

### 3. Selecionar template
- Procurar template chamado exatamente igual ao valor de `publishing.newsletter.template` (ex: `"Default"`).
- Se não encontrar template com esse nome, abortar com erro `"Template '{nome}' não encontrado no Beehiiv. Verifique o nome em platform.config.json e na conta Beehiiv."`.
- Selecionar e confirmar.

### 4. Preencher cabeçalho
- **Title**: primeiro título da edição (linha de assunto da newsletter — extrair do `02-reviewed.md`).
- **Subtitle** (se o template tiver): subtítulo curto da edição (≤80 chars).
- **Cover image** (Thumbnail): upload de `04-d1-2x1.jpg` (1600×800 — a imagem wide do destaque 1 é a capa).

### 5. Colar corpo no bloco Custom HTML (#74)

O fluxo é **all-or-nothing**: 1 paste de HTML completo num único bloco Custom HTML pré-existente no template. Sem encher bloco-a-bloco; sem upload manual de imagens (todas as 5 imagens da newsletter — cover + D2 + D3 + duas É IA? — estão embedadas via Drive CDN URLs no HTML pré-renderizado).

**5.1. Localizar o bloco Custom HTML.** O template (`Default`) precisa ter exatamente 1 bloco Custom HTML pré-configurado — é onde o conteúdo vai. Se o template tiver outros blocos (ex: Subscribe CTA no final, Poll Trivia), manter intactos. Se NÃO houver bloco Custom HTML, abortar com `template_missing_custom_html` — editor cria template adequado antes de retentar.

**5.2. Colar HTML.** Abrir o bloco Custom HTML em modo edição. Colar o conteúdo de `{edition_dir}/_internal/newsletter-final.html`. Salvar o bloco.

**5.3. Verificação pós-paste.** Beehiiv renderiza preview em ~2-3s. Re-ler o DOM via `read_page` e confirmar 5 imagens carregadas com preview (não placeholders/broken icons). Se alguma falhar, registrar em `unfixed_issues[]` com `reason: "image_url_broken_{key}"` (causa típica: URL Drive demora a propagar CDN; re-rodar `upload-images-public.ts --no-cache` resolve).

**Poll Trivia (#107) — passo manual do editor pós-paste.** O Custom HTML não inclui o Poll do Beehiiv (é tipo de bloco nativo, não HTML). Após colar o HTML do corpo, o editor adiciona um bloco **Poll Trivia** logo abaixo do É IA?:

- **Tipo:** Trivia (não Voting).
- **Pergunta:** `Qual delas é IA?`
- **Opções:** `A` e `B`.
- **Marcar como correta** a letra do `ai_side` em `_internal/01-eai-meta.json` (preenchido upstream pelo `eai-compose.ts` no sorteio A/B do #192):
  ```bash
  node -e "console.log(JSON.parse(require('fs').readFileSync('data/editions/{AAMMDD}/_internal/01-eai-meta.json','utf8')).ai_side)"
  ```
  Edições antigas pré-#192 podem ter `ai_side: null` no meta — nesse caso o editor deduz pela ordem do crédito/imagem.

### 6. Salvar como rascunho
- **NÃO clicar em Schedule, Publish, ou Send.**
- Procurar botão/menu **Save draft** ou **Save as draft** (geralmente no canto superior direito ou no menu "..." do post).
- Confirmar salvamento.
- A URL deve mudar para algo como `https://app.beehiiv.com/posts/{id}/edit` — capturar essa URL como `draft_url`.

### 7. Enviar email de teste
- No editor do post, procurar opção **Send test email** (geralmente no menu "..." ou em "Preview" → "Send test").
- Inserir o endereço de `publishing.newsletter.test_email` (ex: `vjpixel@gmail.com`).
- Confirmar envio.
- Aguardar mensagem de confirmação na UI (ex: "Test email sent").
- Capturar timestamp ISO atual como `test_email_sent_at`.

### 8. Validar sucesso
- `draft_url` capturada.
- Confirmação visual de envio do teste.
- Retornar JSON conforme `05-published.json`.

## Modo rascunho

**Suportado.** Beehiiv tem "Save draft" nativo. Não há fallback para agendamento neste stage — newsletter é sempre rascunho + teste.

## Email de teste

**Suportado.** Beehiiv permite enviar testes para qualquer endereço sem precisar adicionar à lista de assinantes.

## Gotchas conhecidos

- O botão **New post** pode estar atrás de um menu "+" em telas menores. Procurar texto "New post" semanticamente.
- Selecionar o template pode exigir scroll na lista — usar `find` com o nome do template.
- O nome do template é case-sensitive. Se a conta tem `"Default"` mas o config tem `"default"`, falha.
- Beehiiv às vezes mostra modal de "Upgrade" para features pagas — fechar e prosseguir; o save de rascunho é gratuito.
- **Imagem broken no preview.** Se uma das 5 imagens aparecer como ícone de imagem quebrada após o paste, geralmente é URL Drive ainda propagando no CDN. Solução: re-rodar `upload-images-public.ts --no-cache` (gera URLs novas) e re-colar o HTML. Registrar em `unfixed_issues[]` se persistir.
- **Custom HTML block ausente no template.** Se a UI não mostrar bloco Custom HTML pré-configurado, abortar — editor precisa criar template adequado antes (Beehiiv cobra Custom HTML em planos pagos (verificar tier atual)).

## Validação de sucesso

- URL final contém `/posts/{id}/edit` (rascunho) ou `/posts/{id}` (qualquer estado salvo).
- Test email confirmação aparece na tela.

## Erros recuperáveis

- **Login expirou** → abortar com mensagem clara, usuário re-loga.
- **Template não encontrado** → abortar com mensagem listando templates encontrados.
- **Upload de imagem falha** → tentar 2x; se persistir, abortar e reportar qual imagem.
- **Save draft sem botão visível** → talvez o template salve auto; verificar se URL contém `/edit` — se sim, considerar salvo.
