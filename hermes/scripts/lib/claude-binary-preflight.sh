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
#       0, mesmo o binário ter voltado pro stub. Agora a VERIFICAÇÃO do
#       reparo (não a checagem inicial — essa continua só `--version`, pra
#       não quebrar callers cujo binário já saudável seja um arquivo
#       pequeno, ex. um fake de teste) exige `--version` OK E o arquivo
#       resolvido não ser um stub por tamanho (~500 bytes é o tamanho real
#       do placeholder medido, default do limiar é 4096). Se o stub
#       persistir depois do install.cjs, o reparo DIRETO (copiar o binário
#       nativo de dentro do pacote `@anthropic-ai/claude-code-*` do MESMO
#       prefixo npm, sem depender do postinstall) é a última linha.
#
# Sequência: 1) `claude --version` falhou? 2) roda `node <install.cjs>`
# (idempotente) 3) `--version` de novo E não-stub? resolvido. 4) ainda
# quebrado/stub? reparo DIRETO (copy do binário da plataforma) 5) ainda
# quebrado/stub? exit 5 (preflight) ou retorna 1 (ensure) 6) funcionou?
# AVISA no stderr (nunca silencioso — reparar sem avisar esconde a
# frequência real da quebra, o dado que gerou a issue) e segue.
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
# E o reparo não resolver.
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
#
# #7468: quando `CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD` é passado explicitamente
# (sempre o caso em teste, pra nunca depender de npm/node reais), o reparo
# DIRETO (que deriva de `npm root -g` de novo) é PULADO de propósito — o
# override já é "o chamador assumiu o reparo inteiro", não faz sentido este
# módulo sneakar uma segunda derivação por trás dele tocando o npm/node reais
# da máquina que roda o teste. Em produção (sem override) o reparo direto usa
# o MESMO `npm root -g` já resolvido pro install.cjs.

# Resolve o caminho de arquivo por trás de `$1` (nome de comando OU path
# literal — os testes passam paths absolutos de fixtures). Vazio se não
# resolver.
_claude_binary_resolve_path() {
  local cmd="$1"
  case "$cmd" in
    */*) printf '%s' "$cmd" ;;
    *) command -v "$cmd" 2>/dev/null ;;
  esac
}

# Verdadeiro se o arquivo resolvido de `$1` existir e tiver <= `$2` bytes
# (o tamanho default do placeholder/stub, ~500 bytes, é bem menor que o
# limiar default de 4096 — folga proposital). Arquivo ausente/irresolvível
# NUNCA conta como stub aqui (é "desconhecido", não "stub") — quem decide
# o que fazer com ausência é o `--version` que já rodou antes.
_claude_binary_is_stub() {
  local cmd="$1" max_size="$2"
  local path
  path="$(_claude_binary_resolve_path "$cmd")"
  [ -n "$path" ] && [ -f "$path" ] || return 1
  local size
  size="$(wc -c < "$path" 2>/dev/null)" || return 1
  size="${size//[[:space:]]/}"
  [ -n "$size" ] && [ "$size" -le "$max_size" ]
}

# Verdadeiro se o reparo de fato colou: `--version` responde E o arquivo
# resolvido não é um stub por tamanho. As DUAS condições — não só o exit
# code do install.cjs (#7468 (b) no cabeçalho acima).
_claude_binary_repaired_ok() {
  local cmd="$1" stub_size="$2"
  "$cmd" --version >/dev/null 2>&1 || return 1
  ! _claude_binary_is_stub "$cmd" "$stub_size"
}

# Reparo DIRETO (última linha, #7468): copia o binário nativo de dentro do
# pacote `@anthropic-ai/claude-code-*` (nome varia por plataforma — não
# hardcoda arch/OS, faz glob por prefixo) do MESMO prefixo npm, por cima do
# arquivo resolvido de `$1`, sem depender do `install.cjs`/postinstall
# rodar de novo. Fail-soft: retorna 1 em qualquer etapa que não resolver
# (prefixo sem o pacote de plataforma, binário nativo ausente, cp falhando
# por permissão) — quem decide o que fazer com a falha é o caller.
_claude_binary_direct_repair() {
  local cmd="$1" npm_root="$2"
  local bin_path
  bin_path="$(_claude_binary_resolve_path "$cmd")"
  [ -n "$bin_path" ] || return 1

  local platform_dir
  platform_dir="$(find "${npm_root}/@anthropic-ai" -maxdepth 1 -type d -name 'claude-code-*' 2>/dev/null | head -n1)" || platform_dir=""
  [ -n "$platform_dir" ] || return 1

  local native_bin="${platform_dir}/claude"
  [ -f "$native_bin" ] || return 1

  cp -f "$native_bin" "$bin_path" 2>/dev/null || return 1
  chmod +x "$bin_path" 2>/dev/null || true
  return 0
}

# Núcleo compartilhado pelas duas funções públicas. "$1" é o modo: "hard"
# sai (exit 5) quando o binário segue quebrado depois de TODAS as
# tentativas de reparo (preflight); "soft" só retorna 1, nunca sai (ensure).
_claude_binary_check_and_repair() {
  local mode="$1"
  local cmd="${CLAUDE_BINARY_PREFLIGHT_CMD:-claude}"
  local stub_size="${CLAUDE_BINARY_PREFLIGHT_STUB_SIZE:-4096}"

  if "$cmd" --version >/dev/null 2>&1; then
    return 0
  fi

  local install_cjs="" repair_attempted=0 npm_root="" used_override=0
  local npm_cmd="${CLAUDE_BINARY_PREFLIGHT_NPM_CMD:-npm}"

  if [ -n "${CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD:-}" ]; then
    # Override explícito (teste/operador) — string de comando, precisa de
    # `eval` mesmo (é o próprio propósito do override). Nunca o caminho
    # default de produção.
    eval "$CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD" >/dev/null 2>&1 || true
    repair_attempted=1
    used_override=1
  else
    # Deriva o caminho do install.cjs do prefixo REAL do npm nesta máquina
    # (`~/.npmrc`/config, não uma constante — #6891 nomeia isso
    # explicitamente: hardcodar `~/.npm-global/...` quebra em qualquer
    # máquina com prefixo diferente). `node "$install_cjs"` roda direto
    # (sem `eval`) — o output de `npm root -g` nunca precisa ser
    # re-interpretado pelo shell.
    npm_root="$("$npm_cmd" root -g 2>/dev/null)" || npm_root=""
    if [ -n "$npm_root" ]; then
      install_cjs="${npm_root}/@anthropic-ai/claude-code/install.cjs"
      node "$install_cjs" >/dev/null 2>&1 || true
      repair_attempted=1
    fi
  fi

  if [ "$repair_attempted" -eq 1 ] && _claude_binary_repaired_ok "$cmd" "$stub_size"; then
    echo "AVISO: binário Claude Code estava quebrado — reparado automaticamente (#6891)${install_cjs:+" via $install_cjs"}. A frequência desta mensagem é o dado que abriu a issue — não ignorar se aparecer com frequência." >&2
    return 0
  fi

  # #7468: install.cjs saiu (ou nem rodou, ex. `npm root -g` vazio) mas o
  # binário segue quebrado/stub — última linha: reparo DIRETO usando o
  # MESMO npm_root já resolvido acima. Só no caminho SEM override — ver
  # nota no cabeçalho do arquivo sobre por que pular quando
  # CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD foi passado.
  local direct_repaired=0
  if [ "$used_override" -eq 0 ] && [ -n "$npm_root" ] && _claude_binary_direct_repair "$cmd" "$npm_root"; then
    direct_repaired=1
  fi

  if [ "$direct_repaired" -eq 1 ] && _claude_binary_repaired_ok "$cmd" "$stub_size"; then
    echo "AVISO: binário Claude Code estava quebrado (stub sobreviveu ao install.cjs) — reparado por CÓPIA DIRETA do binário da plataforma, sem depender do postinstall (#7468). A frequência desta mensagem é o dado que abriu a issue — não ignorar se aparecer com frequência." >&2
    return 0
  fi

  if [ "$mode" = "hard" ]; then
    if [ "$repair_attempted" -eq 1 ] || [ "$direct_repaired" -eq 1 ]; then
      echo "ERRO: binário Claude Code quebrado — reparo automático não resolveu (install.cjs + cópia direta tentados)${install_cjs:+" ($install_cjs)"} — rodar manualmente: node \$(npm root -g)/@anthropic-ai/claude-code/install.cjs" >&2
    else
      echo "ERRO: binário Claude Code quebrado — reparo automático NÃO foi tentado (\`npm root -g\` não resolveu um prefixo) — rodar manualmente: node \$(npm root -g)/@anthropic-ai/claude-code/install.cjs" >&2
    fi
    exit 5
  fi

  # mode = soft (claude_binary_ensure) — nunca sai, o caller decide.
  echo "AVISO: claude_binary_ensure — binário Claude Code segue quebrado/stub após reparo (#7468); fail-soft, a tentativa seguinte da cadeia decide o que fazer." >&2
  return 1
}

claude_binary_preflight() {
  _claude_binary_check_and_repair "hard"
}

# FAIL-SOFT (#7468) — chamar ENTRE as tentativas da cadeia de fallback do
# wrapper (não só uma vez no preflight do início): re-verifica e re-repara
# se necessário. Retorna 0 (binário ok) ou 1 (ainda quebrado) — NUNCA sai
# do processo.
claude_binary_ensure() {
  _claude_binary_check_and_repair "soft"
}
