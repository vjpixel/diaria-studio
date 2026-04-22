# Playbook: Beehiiv (Stage 6 — newsletter)

Roteiro semântico para o agente `publish-newsletter` operar o editor Beehiiv via Claude in Chrome. Este documento é vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://app.beehiiv.com/`
- Conta esperada: a que possui a publicação **Diar.ia** (ver `platform.config.json` → `beehiiv.publicationName`).
- Pré-condição: usuário já logado no Chrome (sessão persistida).

## Objetivo

Criar um post na publicação Diar.ia, usando o template configurado em `platform.config.json` → `publishing.newsletter.template` (default: `"Default"`), preenchido com o conteúdo da edição, **salvo como rascunho** (sem agendar, sem publicar), e enviar um **email de teste** para `publishing.newsletter.test_email`.

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
- **Cover image** (Thumbnail): upload de `05-d1.jpg` (a imagem do destaque 1 é a capa).

### 5. Preencher corpo
- O editor do Beehiiv tem áreas/blocos pré-definidos pelo template. Para cada destaque (D1, D2, D3):
  - Colar o texto do destaque (extraído de `02-reviewed.md`).
  - Inserir imagem inline correspondente (`05-d{N}.jpg`).
- Bloco **É AI?** (duas imagens — o leitor adivinha qual é IA):
  - Colar texto de `04-eai.md` (só a linha de crédito — sem parágrafo editorial).
  - Inserir `04-eai-real.jpg` (foto real da Wikimedia POTD) e, logo em seguida, `04-eai-ia.jpg` (versão gerada por IA). **Ordem fixa: real primeiro, IA depois — empilhadas verticalmente como dois blocos de imagem separados**, sem tentar layout side-by-side (nem todo template suporta grid inline, e empilhar garante que ambas rendam em mobile). Rótulos A/B nas imagens são opcionais e ficam a cargo do poll, não do upload.
- Outros blocos do template (Lançamentos, Pesquisa, Outras): preencher com seções correspondentes de `02-reviewed.md`.

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

## Validação de sucesso

- URL final contém `/posts/{id}/edit` (rascunho) ou `/posts/{id}` (qualquer estado salvo).
- Test email confirmação aparece na tela.

## Erros recuperáveis

- **Login expirou** → abortar com mensagem clara, usuário re-loga.
- **Template não encontrado** → abortar com mensagem listando templates encontrados.
- **Upload de imagem falha** → tentar 2x; se persistir, abortar e reportar qual imagem.
- **Save draft sem botão visível** → talvez o template salve auto; verificar se URL contém `/edit` — se sim, considerar salvo.
