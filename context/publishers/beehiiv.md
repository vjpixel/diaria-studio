# Playbook: Beehiiv (Stage 6 — newsletter)

Roteiro semântico para o agente `publish-newsletter` operar o editor Beehiiv via Claude in Chrome. Este documento é vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://app.beehiiv.com/`
- Conta esperada: a que possui a publicação **Diar.ia** (ver `platform.config.json` → `beehiiv.publicationName`).
- Pré-condição: usuário já logado no Chrome (sessão persistida).

## Objetivo

Criar um post na publicação Diar.ia, usando o template configurado em `platform.config.json` → `publishing.newsletter.template` (default: `"Default"`), preenchido com o conteúdo da edição, **salvo como rascunho** (sem agendar, sem publicar), e enviar um **email de teste** para `publishing.newsletter.test_email`.

## Pré-render (ANTES do browser)

Antes de abrir o Chrome, rodar os scripts de extração para ter todo o conteúdo pronto:

```bash
# Extrair destaques como JSON estruturado
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md

# Extrair conteúdo completo como JSON (destaques + seções + É AI? + emojis + imagens)
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format json
```

O JSON contém `title`, `subtitle`, `destaques[]` (com `category`, `emoji`, `title`, `body`, `why`, `url`), `eai`, e `sections[]`. Use esses dados diretamente — **não ler `02-reviewed.md` durante a sessão do browser**.

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
- **Cover image** (Thumbnail): upload de `05-d1-2x1.jpg` (1600×800 — a imagem wide do destaque 1 é a capa).

### 5. Preencher corpo (block-by-block acelerado)

**Usar os dados do JSON pré-extraído** (passo "Pré-render"). Não ler `02-reviewed.md` durante o browser session — todo o conteúdo já está parseado e pronto.

**Regra fundamental: cada seção do template tem seu próprio bloco/container.** Nunca colar conteúdo de duas seções dentro do mesmo bloco.

**Sequência mecânica para cada destaque (d1, d2, d3):**
1. Encontrar o bloco correspondente no template
2. Preencher label de categoria: `{emoji} {category}` (ex: `🧮 REGULAÇÃO`) — manter cor verde/teal do template
3. Preencher título como texto linkado à URL do destaque
4. Upload imagem: D1=`05-d1-2x1.jpg` (wide), D2=`05-d2.jpg`, D3=`05-d3.jpg`
5. Colar `body` (parágrafos)
6. Colar heading "Por que isso importa:" + `why`

**É AI?** — bloco separado:
1. Label: `🖼️ É IA?`
2. Upload `04-eai-real.jpg` (primeiro) e `04-eai-ia.jpg` (depois), como **dois blocos de imagem separados empilhados verticalmente** (não side-by-side)
3. Crédito: `eai.credit` do JSON

**Seções (Pesquisas, Lançamentos, Outras Notícias):**
1. Para cada seção no JSON `sections[]`, encontrar o bloco correspondente
2. Preencher label: `{emoji} {name}`
3. Para cada item: título linkado + descrição
4. Se uma seção não existir no JSON (vazia), deletar o bloco do template

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
- Retornar JSON conforme `06-published.json`.

## Modo rascunho

**Suportado.** Beehiiv tem "Save draft" nativo. Não há fallback para agendamento neste stage — newsletter é sempre rascunho + teste.

## Email de teste

**Suportado.** Beehiiv permite enviar testes para qualquer endereço sem precisar adicionar à lista de assinantes.

## Gotchas conhecidos

- O botão **New post** pode estar atrás de um menu "+" em telas menores. Procurar texto "New post" semanticamente.
- Selecionar o template pode exigir scroll na lista — usar `find` com o nome do template.
- Upload de imagem: aguardar barra de progresso terminar antes de prosseguir para o próximo bloco (sob risco de o upload ser cancelado).
- O nome do template é case-sensitive. Se a conta tem `"Default"` mas o config tem `"default"`, falha.
- Beehiiv às vezes mostra modal de "Upgrade" para features pagas — fechar e prosseguir; o save de rascunho é gratuito.
- **Cor dos labels de seção.** Ao colar texto sobre um placeholder do template, o Beehiiv pode resetar a formatação (cor, negrito, tamanho) para o padrão (preto). Verificar se labels de categoria (topo de cada box de destaque) mantêm a cor verde original do template. Se perderam, re-aplicar manualmente.
- **Boxes fundidos.** Se dois blocos aparecem dentro do mesmo container (ex: D2 e É AI? juntos), o conteúdo foi colado no lugar errado. Desfazer e recolar no container correto — cada seção do template tem seu próprio bloco.
- **Blocos duplicados.** Templates podem ter blocos extras (ex: "Outras Notícias" duplicado) se o post foi criado a partir de edição anterior ou merge. Antes de preencher, verificar se cada seção tem exatamente 1 bloco — deletar duplicatas.

## Validação de sucesso

- URL final contém `/posts/{id}/edit` (rascunho) ou `/posts/{id}` (qualquer estado salvo).
- Test email confirmação aparece na tela.

## Erros recuperáveis

- **Login expirou** → abortar com mensagem clara, usuário re-loga.
- **Template não encontrado** → abortar com mensagem listando templates encontrados.
- **Upload de imagem falha** → tentar 2x; se persistir, abortar e reportar qual imagem.
- **Save draft sem botão visível** → talvez o template salve auto; verificar se URL contém `/edit` — se sim, considerar salvo.
