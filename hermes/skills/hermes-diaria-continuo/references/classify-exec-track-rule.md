# Regra `classifyExecTrack` — fonte única (`scripts/lib/issue-exec-track.ts`)

Arquivo fonte: `/home/vjpixel/diaria-studio/scripts/lib/issue-exec-track.ts` (linha 1, 28781 chars).
Função `classifyExecTrack` (linhas 286-318) — 5 categorias (`overnight`/`develop`/`agendada`/`bloqueada`/`fora-de-rodada`).
Conforme `SKILL.md` `overnight` (`.claude/skills/diaria-overnight/`): `overnight` = fila acionável deste ciclo; `develop` = `trade-off-real`/`credencial-escopo`; `agendada` = `aguardando-ate:` vence `trade-off-real`; `bloqueada` = `external-blocker`/`on-hold`/`not-this-week`; `fora-de-rodada` = nenhuma.
A `SKILL.md` `hermes-diaria-continuo` (v0.3.2) incorpora esta regra diretamente; a `SKILL.md` original `.claude/skills/diaria-continuo/` usa classificação por prosa (`a`/`b`/`c`) sem referência ao arquivo fonte — divergência confirmada neste ciclo.
