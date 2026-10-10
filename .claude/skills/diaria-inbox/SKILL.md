---
name: diaria-inbox
description: (Opcional) Drena manualmente as submissões enviadas para o inbox editorial (`diariaeditor@gmail.com`) e anexa em `data/inbox.md`. O Stage 1 de `/diaria-1-pesquisa` e `/diaria-edicao` já faz isso sozinho — use para recuperar submissões depois de renovar o token Google (`oauth-setup.ts`), pré-visualizar o que entra na próxima edição, ou depurar.
---

# /diaria-inbox (manual / opcional)

Roda o mesmo drain que o Stage 1 executa automaticamente.

## Quando usar

- **Recuperação após token expirado** (caso principal): se um drain falhou com `auth_expired`, o cursor não avançou — rodar `npx tsx scripts/oauth-setup.ts` e depois esta skill recupera as submissões que ficaram para trás. É a ação que o próprio script imprime no aviso.
- Ver o que vai entrar na próxima edição antes de iniciá-la.
- Forçar um drain fora do fluxo, ou depurar quando uma submissão não aparece.

## Como funciona

O script `scripts/inbox-drain.ts` usa a **Gmail REST API com OAuth** (`data/.credentials.json`, gerado por `scripts/oauth-setup.ts`) — não usa MCP. Ele busca na pasta **Enviados** de `vjpixel@gmail.com` os e-mails endereçados a `diariaeditor@gmail.com` **ou** `diaria.editor@gmail.com` (o operador `to:` do Gmail não normaliza pontos, #3362), desde o cursor em `data/inbox-cursor.json`. Não depende de label, filtro ou forward (#3217). A query pode ser sobrescrita em `platform.config.json` → `inbox.gmailQuery`.

## Execução

```bash
npx tsx scripts/inbox-drain.ts
```

Ao final, mostre ao usuário:

1. O JSON de resultado (`new_entries`, `urls`, `topics`, `most_recent_iso`, `skipped`, `reason`).
2. Se `new_entries > 0`, as últimas entradas de `data/inbox.md`.
3. Se `skipped: true`, o motivo e a ação:

| `reason` | Significado | Ação |
|---|---|---|
| `auth_expired` | Token OAuth Google expirado/revogado | `npx tsx scripts/oauth-setup.ts`, depois rodar esta skill de novo |
| `search_failed` | Gmail falhou ao listar (timeout, 5xx, schema) — cursor não avançou | Rodar de novo; se persistir, ver `error_samples` |
| `inbox_disabled` | `inbox.enabled: false` em `platform.config.json` | Intencional — reativar só se o editor quiser |
| `gmail_mcp_error` | Exceção genérica do script (nome legado — não envolve MCP) | Ler a mensagem em `error`; checar o token com `npx tsx scripts/check-google-token.ts` |

Inbox vazio (`new_entries: 0`, `skipped: false`) é estado normal, não falha.

Setup e troubleshooting completos: `docs/gmail-inbox-setup.md`.
