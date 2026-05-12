---
name: diaria-inbox
description: (Opcional) Drena manualmente a caixa `diariaeditor@gmail.com` via Gmail MCP e atualiza `data/inbox.md`. Normalmente não é necessário — o orchestrator dispara isso automaticamente no Stage 1 de `/diaria-1-pesquisa` e `/diaria-edicao`. Útil para debug ou para pré-visualizar o que será considerado na próxima edição.
---

# /diaria-inbox (manual / opcional)

Puxa novos e-mails enviados para `diariaeditor@gmail.com` desde o último drain e anexa em `data/inbox.md`.

**Normalmente não precisa invocar manualmente** — `/diaria-1-pesquisa` e `/diaria-edicao` já rodam isso antes da pesquisa. Use aqui para:

- Verificar se o Gmail MCP está autenticado corretamente.
- Ver o conteúdo do `data/inbox.md` antes de iniciar uma edição.
- Forçar um drain fora do fluxo.

## Execução

Rode via Bash:

```bash
npx tsx scripts/inbox-drain.ts
```

O script (#1110 — substitui o subagente legado `inbox-drainer`) detecta sozinho cursor incremental, labels Gmail, e edge cases. Usa Gmail MCP nativo quando precisa.

Ao final, mostre ao usuário:
1. O JSON de resultado (`new_entries`, `urls`, `topics`, `most_recent_iso`, `skipped`).
2. Se `new_entries > 0`, as últimas entradas de `data/inbox.md` para confirmação visual.
3. Se `skipped: true`, explique o motivo e como corrigir (ex: label não existe → orientar criação; Gmail MCP desconectado → orientar `/mcp`).
