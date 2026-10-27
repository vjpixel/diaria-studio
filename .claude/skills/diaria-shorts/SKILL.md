---
name: diaria-shorts
description: Alias de `/diaria-publica-video AAMMDD --so vertical` (#11209) — só o vídeo vertical da edição (YouTube Shorts, Reels das páginas, Instagram em collab, perfil pessoal, X, Threads, LinkedIn). O fluxo inteiro vive em `.claude/skills/diaria-publica-video/SKILL.md`. Uso — `/diaria-shorts AAMMDD`.
---

# /diaria-shorts AAMMDD — alias (#11209)

Desde o #11209 (27/10/2026) os dois vídeos da edição saem por **`/diaria-publica-video`**. Esta skill continua existindo só como atalho para a **Parte B** (vertical, #10769).

Ao ser invocada: ler `.claude/skills/diaria-publica-video/SKILL.md` e executar o fluxo dela com `--so vertical` (repassando `AAMMDD`) — Passo 0 (pré-condição do Stage 4) e Parte B inteira, com o relato da Parte B. Não rodar a Parte A, e não encadear em nenhuma outra skill (#5578). Invocar é o pedido de publicação, como na skill completa.

Não duplicar o fluxo aqui: qualquer mudança vai no `SKILL.md` da `/diaria-publica-video`.
