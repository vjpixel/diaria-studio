# Browser Publish Setup — Diar.ia Studio

Setup do MCP **Claude in Chrome** para Stages 6 e 7 (publicação automatizada da newsletter no Beehiiv e dos 6 posts sociais no LinkedIn + Facebook).

---

## Por que Claude in Chrome (e não Playwright)

- Login do usuário no Chrome é reaproveitado automaticamente (sem persistência manual de sessão por plataforma).
- Compreensão semântica da página → resiliente a mudanças de UI (LinkedIn/Facebook redesenham com frequência).
- Volume baixo (7 publicações/dia) não justifica manutenção de seletores CSS.
- Custo modesto (~600k tokens/dia, marginal).

---

## 1. Instalar a extensão Claude in Chrome

1. Instalar a extensão **Claude in Chrome** no Chrome (disponível na Chrome Web Store ou via [claude.ai/chrome](https://claude.ai/chrome)).
2. Fazer login com a mesma conta Anthropic usada no Claude Code.
3. Confirmar que a extensão está ativa (ícone na barra de ferramentas).

## 2. Confirmar MCP no Claude Code

No diretório `diaria-studio`, rodar:

```
/mcp
```

Deve listar `Claude_in_Chrome` (conector nativo). As ferramentas `mcp__Claude_in_Chrome__*` ficam disponíveis automaticamente.

## 3. Logar nas 3 plataformas no Chrome

Abrir o Chrome (mesma instância onde a extensão está instalada) e logar manualmente em:

| Plataforma | URL | Conta esperada |
|---|---|---|
| Beehiiv | https://app.beehiiv.com/ | Conta dona da publicação Diar.ia |
| LinkedIn | https://www.linkedin.com/ | Perfil pessoal ou página Diar.ia |
| Facebook (Business Suite) | https://business.facebook.com/ | Conta com acesso à página Diar.ia |

Marcar "lembrar login" / "manter conectado" em cada plataforma para que a sessão persista.

## 4. Permissões em `.claude/settings.json`

O arquivo `.claude/settings.json` já libera as ferramentas de leitura/escrita do Claude in Chrome em modo `allow`:

```
mcp__Claude_in_Chrome__navigate
mcp__Claude_in_Chrome__read_page
mcp__Claude_in_Chrome__form_input
mcp__Claude_in_Chrome__find
mcp__Claude_in_Chrome__file_upload
mcp__Claude_in_Chrome__tabs_create_mcp
mcp__Claude_in_Chrome__tabs_close_mcp
```

`mcp__Claude_in_Chrome__javascript_tool` fica em `ask` (executar JS arbitrário pede confirmação).

## 5. Configuração em `platform.config.json`

Bloco `publishing`:

```json
"publishing": {
  "newsletter": {
    "mode": "draft",
    "template": "Default",
    "test_email": "vjpixel@gmail.com"
  },
  "social": {
    "mode": "draft_or_schedule",
    "fallback_schedule": {
      "linkedin": { "d1_time": "09:00", "d2_time": "12:30", "d3_time": "16:00", "day_offset": 1 },
      "facebook": { "d1_time": "10:00", "d2_time": "13:30", "d3_time": "17:00", "day_offset": 1 }
    },
    "timezone": "America/Sao_Paulo"
  }
}
```

- `newsletter.template`: nome **exato** do template no Beehiiv (case-sensitive). Default = `"Default"`.
- `newsletter.test_email`: para onde enviar o email de teste após salvar o rascunho.
- `social.mode = draft_or_schedule`: tenta rascunho primeiro, agenda como fallback.
- `social.fallback_schedule.{plataforma}.{d{N}_time}`: horário (HH:MM) na timezone configurada.
- `social.fallback_schedule.{plataforma}.day_offset`: dias no futuro a partir de hoje (1 = amanhã).

## 6. Verificar setup

1. Abrir Chrome — extensão Claude in Chrome ativa, logado nas 3 plataformas.
2. No Claude Code: `/mcp` → confirmar `Claude_in_Chrome` listado.
3. Rodar `/diaria-publicar newsletter YYYY-MM-DD` numa edição com Stage 5 completo.
4. O agente deve abrir o Beehiiv no Chrome, criar o rascunho, e enviar o teste.

## Resolução de problemas

| Erro | Causa | Solução |
|---|---|---|
| "Login expirado" | Sessão de uma das plataformas caducou | Re-logar no Chrome, re-rodar o stage |
| "Template 'Default' não encontrado" | Nome do template em `platform.config.json` não bate com o Beehiiv | Verificar nome exato no dashboard Beehiiv → Templates |
| Test email não chega | Filtros do Gmail / endereço errado | Verificar `test_email` em `platform.config.json` |
| Composer LinkedIn não abre rascunho | UI mudou ou conta sem feature | Fallback automático para agendamento — checar `07-social-published.json` para confirmar |
| Imagem não sobe | Arquivo > 10MB ou formato errado | Imagens do Stage 5 são .jpg ~1–2MB; verificar se `05-d{N}.jpg` existe e é válido |
