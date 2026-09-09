#!/usr/bin/env bash
# Troca e restauração de arquivo que PODE ser symlink.
#
# Existe por um estrago real: o `fase3.sh` trocava
# `~/.hermes/scripts/claude-openrouter.sh` por um stub com `cp` e restaurava
# com `cp` de volta. O original era SYMLINK para o repo; o `cp` destruiu o
# symlink e deixou um arquivo comum no lugar. O wrapper faz `source ./lib/…`
# relativo à própria localização — e `lib/` só existe no repo, não em
# `~/.hermes/scripts/`. Resultado: o wrapper passou a morrer no `source`, em
# PRODUÇÃO, e o tick seguinte teve que contornar sozinho.
#
# `cp` sobre symlink escreve no ALVO ou substitui o link, dependendo do caso;
# nunca preserva a natureza do que estava lá. Restauração de infra precisa
# recriar o TIPO, não só o conteúdo.
set -u

# guardar <arquivo> <dir-de-backup> → grava tipo + conteúdo/alvo
guardar() {
  local alvo="$1" dir="$2" nome
  nome="$(basename "$alvo")"
  mkdir -p "$dir"
  if [ -L "$alvo" ]; then
    readlink "$alvo" > "$dir/$nome.symlink-target"
    echo "guardado: $nome é SYMLINK -> $(readlink "$alvo")"
  else
    cp -p "$alvo" "$dir/$nome.file"
    echo "guardado: $nome é arquivo comum"
  fi
}

# restaurar <arquivo> <dir-de-backup> → recria o TIPO original
restaurar() {
  local alvo="$1" dir="$2" nome
  nome="$(basename "$alvo")"
  if [ -f "$dir/$nome.symlink-target" ]; then
    ln -sfn "$(cat "$dir/$nome.symlink-target")" "$alvo"
    echo "restaurado: $nome como SYMLINK -> $(readlink "$alvo")"
  elif [ -f "$dir/$nome.file" ]; then
    cp -p "$dir/$nome.file" "$alvo"
    echo "restaurado: $nome como arquivo comum"
  else
    echo "ERRO: sem backup de $nome em $dir — NÃO restaurado" >&2
    return 1
  fi
}

# trocar <arquivo> <substituto> — remove o link antes, para não escrever no alvo
trocar() {
  local alvo="$1" novo="$2"
  rm -f "$alvo"          # se era symlink, tira o link em vez de escrever no repo
  cp -p "$novo" "$alvo"
}

case "${1:-}" in
  guardar|restaurar|trocar) "$@" ;;
  *) echo "uso: $0 {guardar|restaurar} <arquivo> <dir-backup> | $0 trocar <arquivo> <novo>" >&2; exit 2 ;;
esac
