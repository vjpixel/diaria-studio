---
name: diaria-publica-video
description: Alias de `/diaria-publica AAMMDD` (#12620) — o nome antigo da skill que publica os dois vídeos da edição e, entre eles, as Etapas 5 e 6 (#12591). O fluxo inteiro vive em `.claude/skills/diaria-publica/SKILL.md`. Uso — `/diaria-publica-video AAMMDD [--so horizontal|vertical] [--sem-publicacao] [--skip canal[,canal...]] [--video-url URL]`.
---

# /diaria-publica-video AAMMDD — alias (#12620)

Desde o #12620 (10/11/2026) a skill se chama **`/diaria-publica`**: depois do #12591 ela publica o horizontal, roda as Etapas 5 e 6 e publica o vertical, e o nome antigo só falava do vídeo. Esta skill continua existindo para não quebrar o hábito nem os comandos já impressos.

Ao ser invocada: ler `.claude/skills/diaria-publica/SKILL.md` e executar o fluxo dela, repassando `AAMMDD` e todos os argumentos que vierem (`--so`, `--sem-publicacao`, `--skip`, `--video-url`), sem acrescentar nem tirar nada. Valem as mesmas regras da skill completa: o upload e o `--publish` só saem com o "pode publicar" explícito do editor sobre o plano e, depois de qualquer interrupção, o registro é relido antes de seguir (seção "Confirmação explícita e interrupção", #11741); nenhuma outra skill é encadeada além das Etapas 5 e 6 que o próprio fluxo roda (#5578).

Não duplicar o fluxo aqui: qualquer mudança vai no `SKILL.md` da `/diaria-publica`. O `short-related-task.md` desta pasta continua aqui de propósito: é o roteiro da task `diaria-short-video-relacionado` do Neo, cujo prompt o lê por este caminho (`scripts/lib/scheduled-tasks.ts`).
