---
name: diaria-youtube
description: Alias de `/diaria-publica-video AAMMDD --so horizontal` (#11209) — só o vídeo horizontal da edição no YouTube (@diariabr). O fluxo inteiro (metadados, capa, link do Studio no D1, `--upload` pela API) vive em `.claude/skills/diaria-publica-video/SKILL.md`. Uso — `/diaria-youtube AAMMDD [--video-url URL]`.
---

# /diaria-youtube AAMMDD — alias (#11209)

Desde o #11209 (27/10/2026) os dois vídeos da edição saem por **`/diaria-publica-video`**. Esta skill continua existindo só como atalho para a **Parte A** (horizontal, #10659).

Ao ser invocada: ler `.claude/skills/diaria-publica-video/SKILL.md` e executar o fluxo dela com `--so horizontal` (repassando `AAMMDD` e `--video-url`, se vierem) — Passo 0 (pré-condição do Stage 4) e Parte A inteira, com o relato da Parte A. Não rodar a Parte B, e não encadear em nenhuma outra skill (#5578).

Não duplicar o fluxo aqui: qualquer mudança vai no `SKILL.md` da `/diaria-publica-video`.
