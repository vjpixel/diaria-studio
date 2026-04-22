# Playbook: Facebook (Stage 6 — social)

Roteiro semântico para o agente `publish-social` operar o composer do Facebook via Claude in Chrome. Documento vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://www.facebook.com/` (perfil pessoal) ou `https://business.facebook.com/` (Meta Business Suite, para páginas).
- **Recomendado**: usar Meta Business Suite (`business.facebook.com`) — UI mais estável, suporte nativo a rascunho e agendamento.
- Pré-condição: usuário já logado no Chrome, com acesso à página Diar.ia.

## Objetivo

Para cada destaque (d1/d2/d3), criar um post na página Diar.ia com texto + imagem. **Tentar salvar como rascunho primeiro**; se a UI não oferecer rascunho, agendar conforme `publishing.social.fallback_schedule.facebook`.

## Fluxo (por post)

### 1. Abrir Meta Business Suite
- Navegar para `https://business.facebook.com/`.
- Se cair em login, abortar com `"Facebook login expirado"`.
- Selecionar página **Diar.ia** no seletor de contas (canto superior esquerdo).

### 2. Abrir composer
- Barra lateral → **Content** → **Create post** (ou botão direto "+ Create post" no dashboard).

### 3. Colar texto
- Colar conteúdo da seção `## d{N}` dentro de `# Facebook` em `03-social.md` (o `publish-social` extrai a seção com parse de dois níveis e remove heading/comentários HTML antes de colar).
- Não adicionar nada — conteúdo já vem pronto.

### 4. Anexar imagem
- Seção **Media** → **Add photo/video** → **Upload from computer**.
- Upload `05-d{N}.jpg`.
- Aguardar preview carregar.

### 5. Tentar salvar como rascunho
- Botão **Save as draft** (geralmente no canto inferior direito do composer, ao lado de "Publish" e "Schedule").
- Confirmar.
- Drafts ficam em **Content** → **Posts** → tab **Drafts**.
- Capturar URL do draft. Status = `"draft"`.

### 6. Fallback: agendar
- Se a opção "Save as draft" não estiver disponível:
  - No composer, clicar no dropdown ao lado de **Publish** → escolher **Schedule post**.
  - Data = hoje + `publishing.social.fallback_schedule.facebook.day_offset` dias.
  - Hora = `publishing.social.fallback_schedule.facebook.d{N}_time` (timezone = `publishing.social.timezone`).
  - Confirmar **Schedule**.
  - Capturar URL do post agendado. Status = `"scheduled"`.

### 7. Validar e fechar
- Verificar mensagem de confirmação ("Draft saved" ou "Post scheduled").
- Capturar URL/ID.
- Fechar antes do próximo post.

## Modo rascunho

**Suportado** no Meta Business Suite. No facebook.com clássico (perfil pessoal), o suporte é limitado — preferir Business Suite para páginas.

## Modo agendamento (fallback)

**Suportado.** Meta Business Suite permite agendar com até 75 dias de antecedência.

## Gotchas conhecidos

- Meta Business Suite tem várias UIs convivendo (clássica, "novo design"). Procurar elementos por texto/semântica, não por layout.
- Upload de vídeo é diferente de imagem; só vamos usar imagem (`.jpg`).
- Selecionar a página Diar.ia no início é crítico — se postar na página errada, abortar e desfazer.
- Schedule mostra horário no fuso da conta, não no fuso do navegador. Confirmar visualmente que o horário corresponde a `publishing.social.timezone` (America/Sao_Paulo).
- Modal de "Boost post" pode aparecer após salvar — fechar (X), não clicar em "Boost".

## Validação de sucesso

- **Draft**: aparece em **Content** → **Drafts**.
- **Scheduled**: aparece em **Content** → **Scheduled posts** com data/hora.

## Erros recuperáveis

- **Login expirou** → abortar.
- **Página errada selecionada** → abortar antes de salvar.
- **Upload falha** → tentar 2x.
- **Nem draft nem schedule funcionam** → registrar `status: "failed"` em `06-social-published.json` e prosseguir.
