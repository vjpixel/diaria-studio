#!/usr/bin/env bash
# claude-binary-preflight.sh (#6875, #6879, #6891, #7468) — checagem
# compartilhada: o binário Claude Code precisa existir e responder a
# `--version` antes de qualquer script de cron tentar usá-lo
# (claude-openrouter.sh, continuo-pr-review.sh, opus-daily-diff-review.sh).
# Sem isso, a falha real (binário ausente/quebrado, postinstall não rodou)
# vira sintoma enigmático no meio do script chamador em vez de erro
# nomeado logo no início.
#
# #6891 (01/09/2026): auto-reparo UMA vez antes de abortar. Medido em 01/09
# (#6875/#6891): o auto-updater do Claude Code reinstala em ciclo, e cada
# reinstalação abre uma janela em que o shim do npm já aponta pro binário
# mas o `postinstall` ainda não terminou de criá-lo — 3 quebras em 5h. A
# Parte A do #6891 (DISABLE_AUTOUPDATER=1 nos 3 scripts) ataca a CAUSA;
# esta Parte B é a rede de segurança pra quem invocar de fora dos 3 scripts,
# ou pra qualquer outra causa de binário quebrado — reparar é uma linha
# idempotente (`node install.cjs`), caro demais abortar por isso na
# frequência medida.
#
# #7468 (05/09/2026): o reparo de uma vez não era suficiente. O #6891
# fechou com DISABLE_AUTOUPDATER=1 + preflight com auto-reparo, e MESMO
# ASSIM o binário quebrou dentro da janela de cada sessão dots, 3/3 no
# tick 260905. Dois defeitos, ambos aqui corrigidos:
#
#   (a) O reparo roda UMA vez no preflight e as tentativas 2-3 da cadeia de
#       fallback do wrapper herdam o binário quebrado — o #6891 só
#       consertava o começo. `claude_binary_ensure` (fail-soft, abaixo)
#       re-verifica e re-repara ENTRE as tentativas, então cada `claude -p`
#       parte com o binário reparado.
#
#   (b) O `node install.cjs` é idempotente mas NUNCA distingue "colocou o
#       binário" de "falhou silenciosamente" — ele sai 0 em ambos os casos
#       (imprime no stderr e seta exitCode=1 quando falha). O preflight
#       antigo confiava nisso: o reparo "resolveu" se o install.cjs saísse
#       0, mesmo o binário ter voltado pro stub. Agora o reparo é
#       verificado por CONTEÚDO: se o binário for um stub (~500 bytes, o
#       tamanho real do placeholder) ou não responde `--version`, o
#       reparo é tentado de novo — e, se o stub persistir, o reparo direto
#       (copy do binário da plataforma, sem depender do postinstall) é a
#       última linha.
#
# Sequência: 1) `claude --version` falhou? 2) roda `node <install.cjs>`
# (idempotente) 3) tenta `claude --version` de novo 4) ainda falhou?
# reparo DIRETO (copy do binário da plataforma) 5) ainda falhou? exit 5
# como antes 6) funcionou? AVISA no stderr (nunca silencioso — reparar sem
# avisar esconde a frequência real da quebra, o dado que gerou a issue) e
# segue.
#
# Uso: sourced pelos 3 scripts, chamado logo após `set -euo pipefail`:
#   source "$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/lib/claude-binary-preflight.sh"
#   claude_binary_preflight
#
# #6943 (01/09/2026): o `readlink -f` é OBRIGATÓRIO no chamador, não
# opcional/estilístico. `${BASH_SOURCE[0]}` sozinho, sem resolver o
# symlink primeiro, resolve pro caminho de INVOCAÇÃO quando o script é
# deployado como symlink (`~/.hermes/scripts/claude-openrouter.sh ->
# .../hermes/scripts/claude-openrouter.sh`, o caso real no `helios`) — o
# `dirname` cai fora do repo, e este `source` nunca encontra o arquivo.
# `continuo-pr-review.sh` sobrevivia ao mesmo bug só porque foi deployado
# como STUB com `exec` (troca de processo, `BASH_SOURCE` novo já é o
# caminho real) — dois formatos de deploy convivendo, um quebrado e um
# não, e nada no código avisava disso. Contínuo ficou 8 de 11 ticks sem
# fazer nada (#6922/#6943) porque o wrapper morria antes de qualquer
# chamada, sempre no mesmo lugar.
#
# Sai com exit 5 (mesmo código de antes) se o binário estiver ausente/quebrado
# E o reparo não resolve.
#
# Duas funções, porque o cenário do #7468 exige dois contratos diferentes:
#
#   claude_binary_preflight — FAIL-HARD. Usado no início do script: o
#     wrapper não pode nem começar com o binário quebrado. Sai (exit 5) se
#     o reparo não resolver.
#
#   claude_binary_ensure — FAIL-SOFT. Usado ENTRE as tentativas da cadeia
#     de fallback: uma tentativa que falhou por quota/rate-limit não pode
#     ser arruinada por um binário quebrado que o reparo resolve. Nunca
#     sai: devolve 0 (binário ok) ou 1 (ainda quebrado, mas o caller
#     decide o que fazer — no wrapper, é "próximo modelo").
#
# Testável isoladamente via 4 overrides (nenhum depende do `claude`/`npm`/
# `node` reais — ver claude-binary-preflight.test.sh):
#   CLAUDE_BINARY_PREFLIGHT_CMD          — binário verificado (default: claude)
#   CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD   — comando de reparo (default: deriva
#                                          `node <npm root -g>/@anthropic-ai/claude-code/install.cjs`)
#   CLAUDE_BINARY_PREFLIGHT_NPM_CMD      — binário `npm` usado pra resolver
#                                          o prefixo global (default: npm)
#   CLAUDE_BINARY_PREFLIGHT_STUB_SIZE    — tamanho máximo em bytes que
#                                          conta como stub (default: 4096)
BODY
