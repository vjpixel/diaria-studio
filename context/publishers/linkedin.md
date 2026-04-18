# Playbook: LinkedIn (Stage 7 — social)

Roteiro semântico para o agente `publish-social` operar o composer do LinkedIn via Claude in Chrome. Documento vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://www.linkedin.com/`
- Pré-condição: usuário já logado no Chrome.
- Post como **pessoa** ou **página** Diar.ia (o composer pergunta no início — escolher conforme estratégia editorial; default = página Diar.ia se existir).

## Objetivo

Para cada destaque (d1/d2/d3), criar um post com texto + imagem. **Tentar salvar como rascunho primeiro**; se a UI não oferecer rascunho no momento, agendar conforme `publishing.social.fallback_schedule.linkedin`.

## Fluxo (por post)

### 1. Abrir composer
- Navegar para `https://www.linkedin.com/feed/`.
- Se cair em login, abortar com `"LinkedIn login expirado"`.
- Clicar em **Start a post** (no topo do feed).
- Modal de composer abre.

### 2. Escolher autor (uma vez por sessão)
- Se o composer mostrar dropdown de autor, escolher página **Diar.ia** se existir; senão, perfil pessoal.

### 3. Colar texto
- Colar conteúdo de `03-linkedin-d{N}.md` (já com hashtags e quebras de linha).
- Não adicionar nada — o conteúdo já vem pronto e revisado por Clarice.

### 4. Anexar imagem
- Clicar no ícone de **Photo** (📷) na barra inferior do composer.
- Upload `05-d{N}.jpg`.
- Aguardar preview carregar (até 30s).
- Clicar **Done** / **Next** após preview.

### 5. Tentar salvar como rascunho
- LinkedIn salva drafts automaticamente quando você fecha o composer com conteúdo. Procurar o **X** (fechar) → modal pergunta "Save as draft?" → confirmar.
- Drafts ficam em **Posts** → **Drafts** (acessível pelo perfil/página).
- Se conseguir salvar: capturar URL do draft (geralmente acessível via "View drafts"). Status = `"draft"`.

### 6. Fallback: agendar
- Se a opção de rascunho não aparecer (UI mudou ou só está disponível para alguns tipos de conta):
  - Voltar ao composer (não fechar).
  - Clicar no ícone de **clock/Schedule** (🕐) ao lado do botão Post.
  - Selecionar data = hoje + `publishing.social.fallback_schedule.linkedin.day_offset` dias.
  - Selecionar hora = `publishing.social.fallback_schedule.linkedin.d{N}_time` (timezone = `publishing.social.timezone`).
  - Confirmar **Schedule**.
  - Capturar URL do post agendado. Status = `"scheduled"`.

### 7. Validar e fechar
- Verificar mensagem de confirmação ("Post scheduled" ou "Draft saved").
- Capturar URL ou ID.
- Fechar modal/aba antes do próximo post.

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

- **Draft**: aparece em `https://www.linkedin.com/in/me/recent-activity/drafts/` (perfil) ou na seção Drafts da página.
- **Scheduled**: aparece em `https://www.linkedin.com/feed/scheduled-posts/` (ou similar) com data/hora.

## Erros recuperáveis

- **Login expirou** → abortar.
- **Upload falha** → tentar 2x.
- **Nem draft nem schedule funcionam** → abortar este post, registrar em `07-social-published.json` com `status: "failed"` e prosseguir para o próximo.
