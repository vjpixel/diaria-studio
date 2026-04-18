# Diar.ia Studio

Pipeline Claude Code para produção da newsletter **Diar.ia** (diaria.beehiiv.com), fim-a-fim, com gates humanos e zero custo recorrente de LLM (roda via OAuth da sua assinatura Claude).

## Pré-requisitos

- [Claude Code](https://claude.com/claude-code) instalado e autenticado com sua assinatura.
- Plano Beehiiv pago (Scale ou superior, para acesso ao MCP oficial).
- Node.js 20+ (para os scripts em `scripts/`).
- Fase 2: ComfyUI ou Stable Diffusion WebUI Forge local.
- Fase 3: Playwright MCP + logins persistidos em Beehiiv / LinkedIn / Facebook / Instagram.

## Quick start

```bash
cd diaria-studio
claude               # abre Claude Code neste diretório
/mcp                 # verifica que clarice e beehiiv estão conectados
/diaria-atualiza-audiencia
/diaria-refresh-dedup
/diaria-edicao 2026-04-18
```

Cada stage da pipeline pausa num gate humano. Siga as instruções no chat.

## Documentação

- [`CLAUDE.md`](./CLAUDE.md) — instruções do projeto (lidas automaticamente pelo Claude Code).
- [`context/editorial-rules.md`](./context/editorial-rules.md) — regras editoriais absolutas.
- [`.claude/agents/`](./.claude/agents/) — subagentes do pipeline.
- [`.claude/skills/`](./.claude/skills/) — slash commands invocáveis.

## Status

- [x] Fase 1 — stages textuais (Research → Writing → Social)
- [ ] Fase 2 — imagens via Stable Diffusion local + É AI? via Wikimedia POTD
- [ ] Fase 3 — publicação automatizada via Playwright
