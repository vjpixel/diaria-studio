## Mudança

<1-2 linhas descrevendo o que muda e por quê>

## Issue

Closes #

## Validação no sandbox (web / CI)

- [ ] `npx tsc --noEmit` limpo
- [ ] `npm test` verde
- [ ] (se aplicável) smoke test passou com fixtures

## Validação local (editor)

<!-- Passos específicos, comando exato, onde olhar. Esta seção é o handoff web → local.
     Para PRs que só tocam scripts/testes/CI, listar: pull, npm ci, npm test.
     Para PRs que tocam pipeline ou agents, listar /diaria-test, dashboards a verificar, etc. -->

- [ ] `git pull origin <branch>`
- [ ] `npm ci`
- [ ] `npm test` verde
- [ ]

## Riscos

<!-- O que pode quebrar em produção? Qual edição é afetada?
     Esta seção força pensar no blast radius antes do merge. -->

## Rollback

<!-- Como reverter se falhar na próxima edição?
     "Reverter o commit" é aceitável pra mudanças reversíveis. Para mudanças
     com side-effects (publicação, Drive, etc.), explicitar o procedimento. -->

- Reverter commit.
