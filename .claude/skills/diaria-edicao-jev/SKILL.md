---
name: diaria-edicao-jev
description: Perfil Jev de /diaria-edicao (#8421) — mesmas Etapas 1-4, com todas as jev.features.* ligadas (DIARIA_JEV_PROFILE=all) e o perfil registrado em _internal/.jev-profile.json, para o relatório A/B. Uso — `/diaria-edicao-jev AAMMDD [mesmas flags de /diaria-edicao]`. Termina no fim do Stage 4.
---

# /diaria-edicao-jev

Wrapper fino de `/diaria-edicao`. **Não duplica o playbook**: leia `.claude/skills/diaria-edicao/SKILL.md` e execute-o integralmente (argumentos, Passos 0-2b, gates idênticos), com UM passo extra antes do Stage 0.

`/diaria-edicao` (sem este wrapper) é o braço A do teste A/B. Este comando é o braço B.

## Passo extra — perfil Jev (antes do Stage 0)

Com `AAMMDD` já resolvido conforme o SKILL de `/diaria-edicao`:

1. Exportar `DIARIA_JEV_PROFILE=all` **escopado** aos comandos do pipeline desta sessão (prefixo por comando, ou o ambiente dos subprocessos spawnados). Nunca `export` persistente no shell. Efeito: `jev.features.*` ficam ligadas onde a flag efetiva é lida (`scripts/lib/jev-profile.ts`, `isJevFeatureOn`) — hoje `dedup_grayzone` (shadow, salvo `jev.shadow: false`) e `actor_brazil`.
2. Gravar o marcador do braço B:

   ```
   DIARIA_JEV_PROFILE=all npx tsx scripts/write-jev-profile.ts --edition {AAMMDD}
   ```

   Produz `_internal/.jev-profile.json` com `features` efetivamente ligadas e `written_at`. Falha aqui é warning, nunca bloqueia a edição (mas a edição sem o arquivo cairia no braço A do relatório).
3. Seguir para o Passo 0 de `/diaria-edicao`.

## Fronteira (#5578/#6171)

Encerra no fim do Stage 4, como `/diaria-edicao`. **Não encadeia para o Stage 5**: imprimir o comando `/diaria-5-publicacao` para sessão nova e parar.

## Relatório A/B

`npx tsx scripts/jev-ab-report.ts --editions AAMMDD,AAMMDD,...` compara edições sem o marcador (A) e com ele (B).
