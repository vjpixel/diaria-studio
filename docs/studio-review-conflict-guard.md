# Conflito editor(Studio)×pipeline em `02-reviewed.md`/`03-social.md`

Movido do `CLAUDE.md` (#6935 PR 2 — curadoria do teto de bytes). Enforcement
real vive em código (`scripts/studio-ui/studio-review.ts`, `server.ts`,
`scripts/studio-ui/public/revisao.js`, `revisao-guards.js`), não no texto
deste bullet — mover daqui não muda o comportamento do Studio.

## Estado: warn-before-save implementado, sentido inverso continua risco aceito (#3729)

A retirada do Drive sync (#3636) removeu o único mecanismo que existia pra
esse cenário — o push do Stage 2 rodava com `--on-conflict pull-merge
--fail-on-conflict` (3-way merge + halt banner quando editor e pipeline
tocavam a mesma região).

Investigado no #3729 (rodada overnight 260719/20): um lockfile análogo ao
já usado em `scripts/lib/social-published-store.ts` não é viável aqui
porque o lado pipeline escreve via `Edit`/`Write` do agente (LLM tool
call), não via script interceptável que possa checar/segurar um lock.

## A mitigação: warn-before-save no client do Studio

Decisão `/diaria-develop` 260720, reusando o padrão do guard de divergência
já usado pro slug `html-final` (#3635):

- `GET .../review/:slug` retorna `modifiedAt` (mtime do arquivo no momento
  da leitura).
- O painel guarda esse valor e reenvia como `expectedModifiedAt` no
  `PUT .../review/:slug`.
- `saveReviewFile` (`scripts/studio-ui/studio-review.ts`) compara contra o
  mtime ATUAL em disco e recusa o write com `{conflict: true}` se divergir
  (o handler HTTP em `server.ts` responde 409) — o write NUNCA é feito
  silenciosamente por cima.
- O painel (`scripts/studio-ui/public/revisao.js`) trata o 409 com um
  dialog (`SAVE_CONFLICT_CONFIRM_MESSAGE` em `revisao-guards.js`): OK
  sobrescreve mesmo assim (retry com `force: true`), Cancelar recarrega a
  versão do disco descartando a edição local não salva.

## Escopo explícito, ainda parcial

Isto protege só o save do EDITOR sobrescrever uma escrita do PIPELINE. O
sentido inverso — pipeline sobrescrevendo uma edição do editor feita no
Studio mas ainda não vista pelo pipeline — **não é coberto** (o pipeline
escreve via `Edit`/`Write` do agente, sem esse ponto de interceptação) e
continua risco aceito, mitigado pela mesma janela estreita de tempo-real do
Studio (segundos, não as horas do Drive assíncrono antigo). Se o editor
notar perda de edição no sentido inverso, reportar em issue nova.
