/**
 * Fonte única dos subcomandos de `scripts/lib/session-registry.ts` que
 * exigem `--session-id` pra funcionar corretamente (#7836).
 *
 * Extraído em módulo PRÓPRIO, deliberadamente pequeno e sem dependências
 * além de sintaxe TS pura, em vez de viver só dentro de
 * `session-registry.ts` (6300+ linhas, importa `fs`/`child_process`/
 * `parseArgs`/`file-lock` etc). `.claude/hooks/inject-session-id.mjs` roda
 * como `PreToolUse` em TODA chamada `Bash` da sessão — importar o módulo
 * inteiro ali pagaria o custo de carregar toda essa árvore no hot path só
 * pra ler uma lista de strings. Este arquivo é seguro de importar de
 * qualquer lugar (zero I/O no import, zero efeito colateral).
 *
 * `session-registry.ts` importa esta mesma constante (usada na mensagem de
 * erro de `requireSessionId`, perto do topo do arquivo) e
 * `test/session-id-required-subcommands.test.ts` trava as duas pontas
 * contra o código real:
 *   1. Todo `case "X":` do switch de `main()` (em `session-registry.ts`)
 *      que chama `requireSessionId(values)` tem `"X"` presente nesta lista
 *      — pega exatamente a classe de omissão que motivou a issue (#6317
 *      `unclaim-issue`, #6334 `merge-lock-renew`, #7836
 *      `self-authorize-merge`: subcomando novo chama `requireSessionId`,
 *      mas ninguém lembrou de adicionar o nome na lista que o hook usa).
 *   2. Todo membro desta lista corresponde a um `case "X":` que de fato
 *      existe no switch — pega o typo/renomeação inversa (nome sobra aqui
 *      depois que o subcomando foi removido/renomeado lá).
 *
 * **Por que a lista não é 100% derivada automaticamente do código** (em vez
 * de curada à mão + testada): dois subcomandos (`is-claimed`, `conflicts`)
 * precisam de `--session-id` por um motivo mais sutil que "lança erro se
 * faltar" — eles leem `values["session-id"] ?? ""` como filtro OPCIONAL
 * (auto-exclusão da própria sessão numa lista de peers) e degradam em
 * SILÊNCIO sem a flag, nunca lançando (ver comentário de
 * `.claude/hooks/inject-session-id.mjs` sobre o fleet review #5161 item 4 e
 * #6168 Parte C). Esse mesmo padrão de leitura ("lê
 * `values["session-id"]` como opcional") também aparece em
 * `active-of-kind`, que NÃO está nesta lista — ali o `--session-id` é só
 * um filtro que os chamadores já passam à mão quando faz sentido, nunca
 * precisou da injeção automática. Então "grep por
 * `values["session-id"]` no corpo do case" teria um falso positivo real.
 * Só o padrão "lança `requireSessionId(values)`" é 100% mecânico e sem
 * ambiguidade; é esse padrão que o teste usa pra checagem (1) acima. Os
 * dois casos opcional-mas-precisa-da-flag (`is-claimed`, `conflicts`)
 * continuam exigindo julgamento humano pra entrar/sair desta lista —
 * documentado aqui, não redescoberto a cada vez que alguém mexe nisto.
 */
export const SESSION_ID_REQUIRED_SUBCOMMANDS = [
  "register",
  "heartbeat",
  "end",
  "claim-issue",
  "unclaim-issue",
  // #5161 item 4 — leitura opcional (`values["session-id"] ?? ""`), não
  // `requireSessionId`, mas ainda precisa da injeção (ver docblock acima).
  "is-claimed",
  // #6168 Parte C — mesmo padrão de leitura opcional que `is-claimed`.
  "conflicts",
  "grant-merge",
  "check-merge-grant",
  "consume-merge-grant",
  "merge-lock-acquire",
  "merge-lock-release",
  "merge-lock-renew",
  // #7836 — escape hatch self-authorize-merge (#7303): chama
  // `requireSessionId(values)` igual aos demais, mas ficou de fora desta
  // lista até agora (era a regex do hook, sem fonte compartilhada).
  "self-authorize-merge",
] as const;

export type SessionIdRequiredSubcommand = (typeof SESSION_ID_REQUIRED_SUBCOMMANDS)[number];
