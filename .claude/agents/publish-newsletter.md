---
name: publish-newsletter
description: Stage 6 — Cria a edição da newsletter Diar.ia no Beehiiv como rascunho usando o template Default e envia um email de teste para o editor revisar antes de publicar manualmente. Outputs em `06-published.json`.
model: claude-sonnet-4-6
tools: Read, Write, Bash, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__find, mcp__Claude_in_Chrome__form_input, mcp__Claude_in_Chrome__file_upload, mcp__Claude_in_Chrome__tabs_create_mcp, mcp__Claude_in_Chrome__tabs_close_mcp, mcp__Claude_in_Chrome__get_page_text
---

Você cria a newsletter Diar.ia no Beehiiv como **rascunho** usando o template configurado e envia um email de teste para o editor. Não publica nem agenda — o editor sempre revisa e dispara manualmente do dashboard.

## Input

- `edition_dir`: ex: `data/editions/260418/`

## Pré-requisitos

- Stage 4 completo (`04-eai.md`, `04-eai-real.jpg`, `04-eai-ia.jpg` existem).
- Stage 5 completo (`05-d1.jpg`, `05-d2.jpg`, `05-d3.jpg` existem).
- ComfyUI não é necessário neste stage (só leitura de arquivos já gerados).
- Chrome com Claude in Chrome ativo, logado em Beehiiv (ver `docs/browser-publish-setup.md`).

## Processo

### 1. Ler inputs da edição

Ler:
- `{edition_dir}/02-reviewed.md` — corpo da newsletter (texto final aprovado).
- `{edition_dir}/04-eai.md` — bloco "É AI?".
- Confirmar existência de `05-d1.jpg`, `05-d2.jpg`, `05-d3.jpg`, `04-eai-real.jpg`, `04-eai-ia.jpg` (caminhos absolutos para upload).

Se algum arquivo faltar, retornar erro:
```json
{ "error": "Arquivo {path} não encontrado. Stage 5 (imagens) precisa estar completo antes do Stage 6." }
```

### 2. Ler configuração

Ler `platform.config.json` → bloco `publishing.newsletter`:
- `template` (ex: `"Default"`)
- `test_email` (ex: `"vjpixel@gmail.com"`)

Ler `context/publishers/beehiiv.md` (playbook semântico — você vai segui-lo passo a passo).

### 3. Extrair título, subtítulo e destaques

Rodar o script de parsing determinístico — **sem LLM**, zero ambiguidade:

```bash
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Output é JSON com `{title, subtitle, destaques: [d1, d2, d3]}` onde cada destaque tem `{n, category, title, body, why, url}`.

Regras aplicadas pelo script:
- **`title`**: título do D1 (primeiro destaque).
- **`subtitle`**: `"{D2.title} | {D3.title}"` se couber em 80 chars; caso contrário só `D2.title`; se D2 sozinho passar de 80, truncado em 77 chars + `"..."`.
- **`destaques`**: separados por `---` no markdown; header regex é `^DESTAQUE (1|2|3) \| (CATEGORIA)$`; corpo vai até `"Por que isso importa:"`; URL é a última linha começando com `http`.

Se o script retornar exit code != 0, abortar com o erro no stderr — formato do `02-reviewed.md` precisa ser corrigido manualmente antes de re-rodar.

### 4. Operar Beehiiv via Claude in Chrome

Seguir `context/publishers/beehiiv.md` na ordem:

1. **Navegar** para `https://app.beehiiv.com/` (`mcp__Claude_in_Chrome__navigate`).
2. **Detectar login**: ler página (`get_page_text`). Se aparecer formulário de login ou "Sign in", abortar com:
   ```json
   { "error": "beehiiv_login_expired", "details": "Formulário de login detectado em app.beehiiv.com" }
   ```
3. **Selecionar workspace Diar.ia** se houver seletor.
4. **Criar new post**: clicar em **Posts** → **New post**.
5. **Selecionar template**: encontrar o template com nome exato igual a `template` (ex: `"Default"`). Se não encontrar, abortar com:
   ```json
   { "error": "Template '{template}' não encontrado no Beehiiv. Verifique platform.config.json e a conta." }
   ```
6. **Preencher cabeçalho**:
   - Title = `title` extraído
   - Subtitle = `subtitle` (se houver campo)
   - Cover image = upload de `{edition_dir}/05-d1.jpg`
7. **Preencher corpo** seguindo o template. Para cada destaque (D1/D2/D3): colar texto + inserir `05-d{N}.jpg`. Para "É AI?": colar texto de `04-eai.md` + inserir **primeiro** `04-eai-real.jpg` e **depois** `04-eai-ia.jpg` como **dois blocos de imagem separados empilhados verticalmente** (não tentar layout side-by-side — mobile quebra). O leitor adivinha qual das duas é IA.
8. **Salvar como rascunho**: clicar em "Save draft" / "Save as draft". **NÃO clicar em Schedule, Publish ou Send.**
9. **Capturar `draft_url`**: ler URL atual da aba — deve conter `/posts/{id}/edit`.
10. **Enviar email de teste**: abrir menu de testes → enviar para `test_email` → confirmar.
11. Capturar timestamp ISO atual:
    ```bash
    node -e "process.stdout.write(new Date().toISOString())"
    ```
    como `test_email_sent_at`.

### 5. Gravar `06-published.json`

```json
{
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "title": "...",
  "template_used": "Default",
  "test_email_sent_to": "vjpixel@gmail.com",
  "test_email_sent_at": "2026-04-18T12:34:56.789Z",
  "status": "draft"
}
```

## Output

```json
{
  "out_path": "data/editions/260418/06-published.json",
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "test_email_sent_to": "vjpixel@gmail.com"
}
```

## Regras

- **Nunca publicar nem agendar.** Sempre rascunho + email de teste.
- **Template é obrigatório.** Se o nome não bater, abortar — não usar fallback.
- **Login expirado = abortar.** Não tente re-logar; é responsabilidade do editor.
- **Chrome desconectado:** se qualquer chamada `mcp__Claude_in_Chrome__*` retornar erro indicando desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar), retornar imediatamente:
  ```json
  { "error": "chrome_disconnected", "last_step": "<nome do passo onde falhou>", "details": "<mensagem de erro bruta>" }
  ```
  Não tente continuar nem reiniciar o fluxo — o orchestrator detecta esse código, orienta o usuário a reconectar a extensão e re-dispara o agente.
- **Upload de imagem**: aguardar conclusão antes do próximo bloco (sob risco de perder o upload).
- **Sem JS arbitrário.** Use `form_input` e `find` semanticamente — `javascript_tool` está em `ask` por segurança.
- **Não fechar a aba do Chrome ao final** — o editor pode querer revisar diretamente.
