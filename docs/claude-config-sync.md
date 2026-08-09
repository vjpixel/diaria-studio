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

O que sincroniza: `settings.json`, `commands/`, `agents/`, `CLAUDE.md`
(global, distinto do `CLAUDE.md` de cada repo). O que fica **fora** de
propósito: `.credentials.json` (vazaria credencial pro repo),
`~/.claude.json` (misto preferência+estado+paths locais), e tudo que é
estado/cache por máquina (`projects/`, `file-history/`, `mcp/`, `plugins/`,
`sessions/`, etc.).

**`skills/humanizador`** não entra no `claude-config` — já é um repo git
próprio (`github.com/vjpixel/humanizador`); o bootstrap clona direto, como
já documentado no passo 3a do Setup acima.

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
`skills/humanizador` se ainda não existir nesta máquina.

**Windows:** symlink de *arquivo* exige Modo Desenvolvedor ligado (junction
só cobre diretório). Se o symlink falhar por permissão, o `bootstrap.ps1`
cai num fallback de cópia + aviso — aquele item específico passa a exigir
re-sync manual até o Modo Desenvolvedor ser ligado.

**Depois do bootstrap:** `enabledPlugins` viaja no `settings.json`
sincronizado, mas os arquivos do plugin não — rodar
`/plugin install pr-review-toolkit@claude-plugins-official` +
`/reload-plugins` continua necessário em máquina nova (mesma pegadinha do
item 3b do Setup acima).

## Estado (260809)

Repo criado e com o **mecanismo** (`README.md`, `bootstrap.sh`,
`bootstrap.ps1`) — nasce **vazio de conteúdo real**: a sessão que fez esse
scaffold rodou na máquina servidor Linux (`predator`), cujo `~/.claude` é
mínimo por design (sem `commands/`, `skills/`, `agents/` ou `CLAUDE.md`
global) — exatamente o perfil de "máquina que pode ser sobrescrita"
decidido na issue, não o de fonte de verdade. Fabricar `settings.json`/
`commands/` a partir daí seria inventar conteúdo que o editor não escreveu.

**Pendente (ação do editor, na máquina Windows com a config real — mesma
disciplina do restante deste documento pra tarefas `local`):**
1. Rodar o "Seed inicial" descrito no `README.md` do `claude-config` — copiar
   o `settings.json`/`commands/` reais pro clone do repo, trocar caminhos
   absolutos hardcoded (`/c/Users/vjpix/...`) por `$HOME`, commitar.
2. Rodar `bootstrap.ps1` na mesma máquina pra virar symlink de verdade.
3. Rodar `bootstrap.sh`/`bootstrap.ps1` nas demais máquinas (incluindo
   `predator`) e **confirmar ao vivo** que hook de sprint e statusline
   funcionam depois do symlink (valida a armadilha do caminho hardcoded).
