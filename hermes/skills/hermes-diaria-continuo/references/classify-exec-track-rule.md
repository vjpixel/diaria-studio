# Regra `classifyExecTrack` — fonte única é o CÓDIGO, nunca este arquivo

Fonte: `scripts/lib/issue-exec-track.ts` — `classifyExecTrackWithRule` (retorna
`{track, matched}`) e o wrapper `classifyExecTrack` (só o track). O tipo
`ExecTrack` tem **6 categorias**: `overnight` / `develop` / `agendada` /
`bloqueada` / `epica` / `fora-de-rodada` (a 6ª, `epica`, entrou no #6201).

**NÃO descrever a regra aqui.** A versão anterior deste arquivo congelava um
snapshot (5 categorias, números de linha, contagem de chars) que envelheceu em
silêncio e virou o exemplo canônico do bug que a SKILL.md v0.5.0 corrige.
Números de linha e contagens mudam a cada refactor — quem precisa da regra
executa o código (receita no §2 da SKILL.md) ou lê o arquivo fonte de hoje.

Nota histórica corrigida: `.claude/skills/diaria-continuo/SKILL.md` (deste
repo) TAMBÉM chama `classifyExecTrack` direto desde #6204/#6205 (26/08) — a
"divergência por prosa a/b/c" que a versão anterior deste arquivo reportava
já estava fechada lá.
