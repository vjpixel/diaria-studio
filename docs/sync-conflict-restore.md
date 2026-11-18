# Restaurar arquivos da edição após `.conflictN` do sync (#13545)

O sync de `data/` (rclone bisync, `scripts/systemd/gdrive-data-bisync.sh`, `--conflict-loser num`) renomeia a versão perdedora de um arquivo alterado dos dois lados para `{nome}.conflictN`. Sem `--conflict-resolve newer`, as duas versões ganham sufixo e o original some. Na edição 261118 isso aconteceu com `02-reviewed.md`, `_internal/01-approved.json`, `06-public-images.json`, o sentinel do Stage 4 e imagens.

## Como o pipeline acusa

Invariante `edition-sync-conflicts` (Stage 4, `error`): roda em `check-invariants.ts --stage 4` (início) e no `pipeline-sentinel.ts write --step 4` (fim, recusa o sentinel). Acusa:

- qualquer `*.conflictN` dentro da pasta da edição, fora de `_conflitos-*`;
- ausência de `02-reviewed.md`, `_internal/01-approved.json` ou `06-public-images.json`.

## Restaurar com segurança

1. Pare a escrita na edição (nenhuma outra sessão ou máquina rodando Stage 2-4 nela).
2. Liste: `npx tsx scripts/triage-conflict-copies.ts --root data/editions/{AAMM}/{AAMMDD} --out /tmp/plano.json` (dry-run, grava o plano, não move nada).
3. Original presente e válido: compare com a cópia (`diff`, mtime). Se a cópia é a versão boa, guarde o original em `_conflitos-{AAMMDD}/` ao lado e só então ponha a cópia no nome original. Se o original é o bom, arquive a cópia (`npx tsx scripts/triage-conflict-copies.ts --root data/editions/{AAMM}/{AAMMDD} --apply --plan /tmp/plano.json`).
4. Original ausente: a `.conflictN` de maior N costuma ser a mais recente; confira o conteúdo antes de copiar (`cp`, nunca `mv`) e deixe a cópia em `_conflitos-{AAMMDD}/`.
5. Depois de restaurar `02-reviewed.md` ou `06-public-images.json`, refaça o que dependia deles (pré-render, embed do mapa de imagens, preview do social) e rode `npx tsx scripts/check-invariants.ts --stage 4 --edition-dir data/editions/.../{AAMMDD}/`.

Nunca apague uma cópia `.conflictN`: ela pode ser a única versão de algo (#9732).

## Limite do diagnóstico

A causa raiz (qual escritor concorrente gera o conflito: Drive/bisync no Neo, outra sessão ou o `sync-code`) não é observável a partir deste repositório: depende do log do bisync e do histórico de revisões do Drive. Fica pendente na issue.
