# Restaurar arquivos da edição após `.conflictN` do sync (#13545)

O sync de `data/` (rclone bisync, `scripts/systemd/gdrive-data-bisync.sh`, que chama o `gdrive-bisync.sh`) roda com `--conflict-resolve newer --conflict-loser num`: quando um arquivo muda dos dois lados, a versão mais nova fica no nome original e a perdedora vira `{nome}.conflictN`. Quando o `newer` não decide (tamanhos diferentes com o mesmo mtime, o caso `sizes differ` do log), as DUAS versões são renomeadas e o original some. Na edição 261118 isso aconteceu com `02-reviewed.md`, `_internal/01-approved.json`, `06-public-images.json`, o sentinel do Stage 4 e imagens.

## Como o pipeline acusa

Invariante `edition-sync-conflicts` (Stage 4, `error`): roda em `check-invariants.ts --stage 4` (passo 5 do §4b do playbook, depois do upload das imagens e do pré-render, antes do gate) e no `pipeline-sentinel.ts write --step 4` (fim, recusa o sentinel). Acusa:

- qualquer `*.conflictN` dentro da pasta da edição, fora de `_conflitos-*`;
- ausência de `02-reviewed.md`, `_internal/01-approved.json` ou `06-public-images.json`.

Aviso antecipado (#13614): um aborto do bisync de `data/` no meio de uma rodada (`Bisync aborted`) com edição em curso vira o achado `alarm-data-bisync-aborted-during-edition` do `Diaria-GDrive-Sync-Alarm` (issue P1 + e-mail), porque é a rodada seguinte ao aborto que gera os `.conflictN`. Ao receber esse aviso, rode a invariante acima na edição em curso antes de seguir.

## Restaurar com segurança

1. Pare a escrita na edição (nenhuma outra sessão ou máquina rodando Stage 2-4 nela).
2. Liste: `npx tsx scripts/triage-conflict-copies.ts --root data/editions/{AAMM}/{AAMMDD} --out /tmp/plano.json` (dry-run, grava o plano, não move nada).
3. Original presente e válido: compare com a cópia (`diff`, mtime). Se a cópia é a versão boa, guarde o original em `_conflitos-{AAMMDD}/` ao lado e só então ponha a cópia no nome original. Se o original é o bom, arquive a cópia. O `--apply --plan /tmp/plano.json` do mesmo script só move as entradas que o plano marcou `archive` (cópia idêntica, inválida, ou mais velha que um original válido); cópia mais nova que difere do original sai `review` (ou `keep`) e nunca é movida, então o gate segue bloqueado. Para `review`/`keep`, depois de decidir, arquive à mão: `mkdir -p {pasta-da-cópia}/_conflitos-{AAMMDD}` e `mv {cópia} {pasta-da-cópia}/_conflitos-{AAMMDD}/` (a checagem ignora qualquer pasta `_conflitos-*`).
4. Original ausente: escolha pela data de modificação e pelo conteúdo, nunca pelo N. O número não é ordem temporal: num mesmo evento o rclone numera pelo lado de origem (a cópia do Drive vira `.conflict1` e a local `.conflict2`, log de 17/11/2026 da 261116), então "maior N" pode restaurar justo a versão defasada. Os helpers `conflictCopiesOf`/`chooseConflictCopy` de `scripts/lib/sync-conflict-copy.ts` ordenam por mtime e dizem quando as mais novas empatam (`tie`): no empate a escolha é sua, pelo conteúdo (`diff` entre as cópias). Confira o conteúdo antes de copiar (`cp`, nunca `mv`) e deixe a cópia em `_conflitos-{AAMMDD}/`.
5. Depois de restaurar `02-reviewed.md` ou `06-public-images.json`, refaça o que dependia deles (pré-render, embed do mapa de imagens, preview do social) e rode `npx tsx scripts/check-invariants.ts --stage 4 --edition-dir data/editions/.../{AAMMDD}/`.

Nunca apague uma cópia `.conflictN`: ela pode ser a única versão de algo (#9732).

## Limite do diagnóstico

A causa raiz (qual escritor concorrente gera o conflito: Drive/bisync no Neo, outra sessão ou o `sync-code`) não é observável a partir deste repositório: depende do log do bisync e do histórico de revisões do Drive. Fica pendente na issue.
