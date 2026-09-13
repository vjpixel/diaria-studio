# Nunca renomear em rodízio dentro de `data/` (#8058)

`data/` é uma directory junction/symlink apontando para uma pasta
sincronizada pelo OneDrive (ver CLAUDE.md, item 2b). Renomear arquivos ali —
seja via `mv` manual, seja via `fs.renameSync` num script — dá ao provedor
de sync uma janela de resolução de conflito que pode descartar
silenciosamente uma das versões, mesmo depois da chamada já ter retornado
sucesso. O caso mais perigoso é o **rodízio via nomes temporários**
(`a → tmp → b`), porque reusa um nome que acabou de ser liberado por outro
rename da mesma sequência, multiplicando as janelas de conflito na mesma
pasta e na mesma janela de tempo curta.

## Achado ao vivo — edição 260914 (Stage 4)

Durante o gate de revisão da edição `260914`, o editor reordenou destaques
(removeu D1, promoveu D2→D1 e D3→D2) e precisou remapear as imagens
correspondentes (`04-d{N}-*.jpg`, `_internal/02-d{N}-prompt.md`) usando o
padrão de rodízio manual:

```bash
mv 04-d2-*.jpg  04-tmpA-*.jpg
mv 04-d3-*.jpg  04-tmpB-*.jpg
mv 04-tmpA-*.jpg 04-d1-*.jpg
mv 04-tmpB-*.jpg 04-d2-*.jpg
```

O primeiro rodízio reportou sucesso na hora. Minutos depois, ao tentar um
SEGUNDO rodízio, os arquivos de D1 (recém-renomeados) simplesmente não
existiam mais em disco — `04-d2-1x1.jpg` retornou `Device or resource busy`
no meio do processo, sinal de que o OneDrive estava ativamente
sincronizando/mexendo no diretório. Impacto: perda silenciosa das imagens
geradas (2x1, 1x1, 4x5, 4x5-nativo, 4 slides de carrossel) e do prompt
`.md` de um destaque — dado recriável (imagem gerada por IA), mas a re-
geração custou tempo e créditos de API.

## Regra prática

- **Nunca** fazer rename-rotation (`a→tmp→b` reusando nomes recém-
  liberados) em paths dentro de `data/` — nem em scripts do pipeline, nem
  em edição manual/assistida no terminal.
- Preferir sempre **copy + verificar (existência + tamanho/hash) + delete
  do original** em vez de `mv`/`fs.renameSync` puro para qualquer
  remapeamento de arquivo dentro de `data/`.
- Um script do pipeline que precise renomear/mover programaticamente usa o
  helper `scripts/lib/safe-rename-in-data.ts` (`safeRenameInData`) — ele
  implementa exatamente esse padrão (copy → verify tamanho/hash → delete),
  nunca `renameSync`, e nunca apaga o original se a verificação falhar.
  Para reorder/remapeamento em LOTE (múltiplos arquivos, permutações
  fechadas — ex: reorder de destaques), o padrão mais robusto já existe em
  `stageAndWriteVerified` (`scripts/reorder-destaques.ts`, #5564/#5581/
  #5583): staging inteiro num diretório temporário FORA da árvore
  sincronizada, escrita direta no destino final (sem nome `tmp` dentro de
  `data/`), verificação em 2 camadas (imediata + passada final byte-a-byte)
  e limpeza de órfãos só depois de todo o lote verificado.
- Para edição manual/assistida (sessão interativa, sem script), o mesmo
  princípio vale à mão: copiar para um destino novo, conferir que o
  destino existe e tem o tamanho esperado, só então apagar o arquivo
  antigo — nunca uma sequência de `mv` reaproveitando nomes.

## Ver também

- `scripts/lib/safe-rename-in-data.ts` — helper de arquivo único (copy +
  verify + delete), com docblock detalhando o mecanismo e o residual
  conhecido (reversão pós-hoc não detectável de forma síncrona).
- `scripts/reorder-destaques.ts` — mecanismo de lote com staging local,
  usado hoje pelo reorder programático de destaques.
- Memória do projeto: `onedrive-renomear-em-rodizio.md` (achado original
  que motivou este documento e a issue #8058).
