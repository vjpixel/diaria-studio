# Sync de configuração do Claude Code entre máquinas (#4804)

O editor usa Claude Code em mais de uma máquina. `~/.claude` é local por
máquina — sem isso, preferências (modelo, hooks, statusline, comandos,
skills, agentes) divergem em silêncio: cada máquina acumula sua própria
config e ninguém percebe até um hook não disparar ou algo faltar do outro
lado.

## Mecanismo

Repo privado [`vjpixel/claude-config`](https://github.com/vjpixel/claude-config)
+ symlinks de `~/.claude` apontando pra dentro dele. **Git, não OneDrive**
(apesar de `data/` deste repo já usar OneDrive) — arquivos de config são
editados nas duas máquinas, e o OneDrive resolve colisão criando
`settings-PC2.json` em silêncio; com git o conflito aparece e é resolvido
explicitamente.

O que sincroniza: `settings.json`, `agents/`, `CLAUDE.md` (global, distinto
do `CLAUDE.md` de cada repo), `statusline-wrapper.cjs` (script real que o
`statusLine.command` do `settings.json` invoca). O que fica **fora** de
propósito: `.credentials.json` (vazaria credencial pro repo),
`~/.claude.json` (misto preferência+estado+paths locais), e tudo que é
estado/cache por máquina (`projects/`, `file-history/`, `mcp/`, `plugins/`,
`sessions/`, etc.).

**`skills/humanizador`** não entra no `claude-config` — já é um repo git
próprio (`github.com/vjpixel/humanizador`); o bootstrap clona direto, como
já documentado no passo 3a do Setup do `CLAUDE.md` deste repo.

**`commands/` (day-plan.md, day-wrap.md, sprint-*.md) também não entra** —
correção feita 260809 depois de um seed inicial ter vendorado esses
arquivos por engano. Eles não são config estática: são a **saída do
instalador** de [`github.com/vjpixel/re-plan`](https://github.com/vjpixel/re-plan)
(`npm run install-skills`, escreve direto em `~/.claude/commands/`; `npm
install` arma git hooks que reinstalam sozinhos a cada `git pull` do
re-plan). O bootstrap clona o repo `re-plan` (destino `~/Projects/Re-plan`,
não o mesmo diretório do `humanizador`) e roda o instalador dele — mesmo
**princípio** do `humanizador` (clonar o repo real em vez de vendorar a
saída dele), não o mesmo path. Vendorar os `.md` aqui os deixaria
estáticos pra sempre, o oposto do que o mecanismo do re-plan já garante
sozinho.

**`projects/{slug}/memory/`** também fica de fora, de propósito, apesar de
ser o que mais dói perder entre máquinas (é o único que muda dentro de
sessão). Memória pode conter decisão de negócio/custo sensível — mesma
classe de dado que `data/` deste repo, que nunca vai pro GitHub sem
revisão. Por ora a sincronização de memória é **manual** (copiar o arquivo
à mão quando precisar levar uma memória específica pra outra máquina); a
alternativa de um mecanismo assistido (diff + confirmação antes de
empurrar) fica pra quando isso doer na prática.

## Setup numa máquina nova

```bash
# Linux/macOS
git clone https://github.com/vjpixel/claude-config.git ~/claude-config
~/claude-config/bootstrap.sh
```
```powershell
# Windows
git clone https://github.com/vjpixel/claude-config.git $HOME\claude-config
& "$HOME\claude-config\bootstrap.ps1"
```

O bootstrap nunca sobrescreve config local em silêncio: item ausente/vazio
no repo é pulado com aviso; item presente localmente vira backup
(`.bak-<timestamp>`) antes do symlink ser criado. Também clona
`skills/humanizador` e `~/Projects/Re-plan` se ainda não existirem nesta
máquina, rodando `npm install && npm run install-skills` no segundo (é
isso que popula `~/.claude/commands/`).

**Windows:** symlink de *arquivo* exige Modo Desenvolvedor ligado (junction
só cobre diretório). Se o symlink falhar por permissão, o `bootstrap.ps1`
cai num fallback de cópia + aviso — aquele item específico passa a exigir
re-sync manual até o Modo Desenvolvedor ser ligado.

**Depois do bootstrap:** `enabledPlugins` viaja no `settings.json`
sincronizado, mas os arquivos do plugin não — rodar
`/plugin install pr-review-toolkit@claude-plugins-official` +
`/reload-plugins` continua necessário em máquina nova (mesma pegadinha do
item 3b do Setup do `CLAUDE.md` deste repo).

## Estado (260809)

Repo criado, seed rodado na máquina Windows (fonte de verdade), symlinks
ativos. No caminho, um erro de design real foi encontrado e corrigido:
o seed inicial vendorou `~/.claude/commands/*.md` (day-plan, day-wrap,
sprint-start/close/update) como se fossem config estática — mas são a
saída do instalador de [`re-plan`](https://github.com/vjpixel/re-plan)
(projeto renomeado de `claude-sprint-review`), que já tem seu próprio
mecanismo de auto-reinstall via git hooks. Vendorar esses `.md` os
congelaria pra sempre, e um hook `SessionStart` antigo em `settings.json`
que tentava copiá-los de `~/claude-sprint-review/.sprints/` (path
pré-rename, nunca existiu de verdade nesta máquina) estava inerte havia
tempo sem ninguém perceber — só apareceu ao tentar confirmar "como sei que
o hook funciona" nesta issue. Corrigido: `commands/` saiu do que o
`claude-config` sincroniza, o hook obsoleto foi removido de `settings.json`,
e o bootstrap passou a clonar `re-plan` em `~/Projects/Re-plan` + rodar
`npm install && npm run install-skills`, mesmo padrão do `humanizador`.

**Pendente (ação do editor, mesma disciplina do restante deste documento
pra tarefas `local`):**
1. Re-rodar `bootstrap.ps1` na máquina Windows — precisa remover o symlink
   antigo `~/.claude/commands` (apontava pro `claude-config`, que não tem
   mais essa pasta) e deixar o `re-plan` popular `~/.claude/commands/` de
   verdade via `npm run install-skills`.
2. Rodar `bootstrap.sh`/`bootstrap.ps1` nas demais máquinas (incluindo
   `predator`) e **confirmar ao vivo** que os comandos de sprint e a
   statusline continuam funcionando.
