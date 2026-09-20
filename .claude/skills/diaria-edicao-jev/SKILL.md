---
name: diaria-edicao-jev
description: Perfil Jev de /diaria-edicao (#8421) — mesmas Etapas 1-4, com todas as jev.features.* ligadas e o Jev DECIDINDO (DIARIA_JEV_PROFILE=all força shadow:false), perfil registrado em _internal/.jev-profile.json para o relatório A/B. Uso — `/diaria-edicao-jev AAMMDD [mesmas flags de /diaria-edicao]`. Termina no fim do Stage 4.
---

# /diaria-edicao-jev

Wrapper fino de `/diaria-edicao`. **Não duplica o playbook**: leia `.claude/skills/diaria-edicao/SKILL.md` e execute-o integralmente (argumentos, Passos 0-2b, gates idênticos), com UM passo extra antes do Stage 0.

`/diaria-edicao` (sem este wrapper) é o braço A do teste A/B. Este comando é o braço B.

**O braço B decide de fato**: com `DIARIA_JEV_PROFILE=all` o shadow efetivo é `false` (o Jev decide onde a confiança é >= 0,7; fail-soft mantido). A faixa 0,70-0,85 de Jaccard do dedup NÃO foi calibrada (a medição #8417 cobriu só [0,35, 0,70)). Config commitado e `/diaria-edicao` comum seguem `dedup_grayzone:false`, `shadow:true`.

## Passo extra — perfil Jev (antes do Stage 0)

Com `AAMMDD` já resolvido conforme o SKILL de `/diaria-edicao`:

1. Exportar `DIARIA_JEV_PROFILE=all` **escopado** aos comandos do pipeline desta sessão (prefixo por comando, ou o ambiente dos subprocessos spawnados). Nunca `export` persistente no shell. A flag efetiva é lida em `scripts/lib/jev-profile.ts` (`isJevFeatureOn`, `effectiveJevShadow`) — hoje `dedup_grayzone` e `actor_brazil`.
2. Gravar o marcador do braço B:

   ```
   DIARIA_JEV_PROFILE=all npx tsx scripts/write-jev-profile.ts --edition {AAMMDD}
   ```

   Produz `_internal/.jev-profile.json` (`features` ligadas, `shadow` efetivo, `written_at`). **Se falhar (exit != 0): imprimir banner `Edição NÃO vale como braço B do A/B` e seguir a edição normalmente** — sem o marcador válido ela cairia no braço A ou seria excluída; nunca é warning silencioso.
3. Seguir para o Passo 0 de `/diaria-edicao`.

## Retomada

O marcador persiste no diretório da edição. Se a edição for retomada com `/diaria-edicao` comum, o marcador continua lá mas o perfil NÃO vale mais. Retome sempre com `/diaria-edicao-jev`. O relatório avisa quando o marcador é anterior ao Stage 1 ou quando o artefato do dedup não registra `profile_env=all`.

## Fronteira (#5578/#6171)

Encerra no fim do Stage 4, como `/diaria-edicao`. **Não encadeia para o Stage 5**: imprimir o comando `/diaria-5-publicacao` para sessão nova e parar.

## Relatório A/B

`npx tsx scripts/jev-ab-report.ts --editions AAMMDD,AAMMDD,...` compara edições sem o marcador (A) e com marcador válido (B). Marcador corrompido/inválido, edição inexistente e edição sem métrica ficam de fora, com aviso.
