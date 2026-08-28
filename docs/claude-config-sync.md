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

## Propagação: automática desde o #6310 (era manual e silenciosa)

**O que mudou:** até 26/08/2026 nada puxava o `claude-config`. Commitar uma
mudança de config a fazia valer **só** na máquina onde foi feita (onde
`~/.claude/settings.json` é symlink pro repo); nas outras ela simplesmente não
existia até alguém rodar `bootstrap` à mão. Nenhum hook, nenhuma task agendada
— verificado.

O modo de falha era silencioso: a máquina não erra, só roda config velha. Já
tinha acontecido uma vez (ver "Atualização (260810)" abaixo: `model`/
`effortLevel` divergentes do committed, sem aviso). O caso que motivou a
correção: 3 commits (`d28b5b6` habilitando o `pr-review-toolkit`, `d6c2fc5`
ligando `remoteControlAtStartup`, `2c96997` gravando `outputStyle`) live no
`helios` e ausentes no Neo e no ZenBook, sem sinal disso em lugar nenhum.

**Como funciona agora:** hook `SessionStart` no `settings.json` do
`claude-config` chama `sync-check.cjs` (também no `claude-config`), que se
auto-destaca e sai em poucas
dezenas de milissegundos — a garantia que importa é que a sessão nunca espera
rede. Como o arquivo que carrega o hook **é** o arquivo sincronizado, instalar
num lugar arma todas as máquinas; um cron
precisaria ser armado máquina a máquina, repetindo o problema.

**Contrato, deliberadamente conservador:**

| situação | o que faz |
|---|---|
| árvore limpa, remoto à frente | `git pull --ff-only` |
| working tree sujo | **avisa e NÃO puxa** — sujo aqui é edição direta em `~/.claude/*`, decisão do editor |
| divergência non-ff | avisa e não força; nunca merge/rebase/stash automático |
| offline, git ausente, repo ausente | registra e segue; exit 0 sempre |
| `~/.claude/X` é **cópia** e não symlink | avisa — é o caso do Windows sem Modo Desenvolvedor |

Aquele último é o que faltava enxergar: `bootstrap.ps1` cai num fallback de
cópia quando o symlink falha, e a partir daí o pull atualiza o repo mas o
conteúdo **nunca chega** a `~/.claude`. A máquina fica permanentemente
defasada mesmo com bootstrap rodado.

**Onde olhar:** `~/claude-config/.sync-state.json` (resultado do último check,
com timestamp) e `.sync-check.log` (o que precisa de ação, mais uma linha
quando um pull traz commits novos — silencioso só quando nada mudou). Ambos
gitignored: sem isso a árvore ficaria permanentemente suja e o próprio script
recusaria puxar, auto-desativando o mecanismo.

**Rollout ainda não confirmado nas 3 máquinas (26/08/2026).** Há um
chicken-and-egg: máquina que ainda não puxou até `90b537c` não tem o
`sync-check.cjs` nem a entrada de hook, então precisa de UM `git pull`/
`bootstrap` manual para receber o próprio mecanismo — a partir daí se propaga
sozinha. Verificado ao vivo só no `helios`; Neo e ZenBook pendentes (o ZenBook
é o que importa, por causa da detecção de cópia).

**Ainda manual:** `memory/` (ver acima) e o `bootstrap` inicial de máquina
nova — o sync automático mantém o repo atualizado, mas não cria symlink que
nunca existiu.

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

**Pendente em 260809 (ação do editor):**
1. Re-rodar `bootstrap.ps1` na máquina Windows — **feito e confirmado ao
   vivo pelo editor** ainda em 260809 (ver issue #4804): symlink antigo de
   `commands/` removido, `re-plan` populando `~/.claude/commands/`,
   `/sprint-start`/`/day-plan`/etc. e a statusline funcionando após reiniciar
   o Claude Code.
2. Rodar `bootstrap.sh`/`bootstrap.ps1` nas demais máquinas (incluindo
   `helios`) e **confirmar ao vivo**.

## Atualização (260810 — sessão `/diaria-develop`; fechamento em 260811 — overnight)

`helios` confirmado ao vivo: `bootstrap.sh` re-rodado, todos os itens já
symlinkados (`settings.json`, `agents/`, `statusline-wrapper.cjs`), `re-plan`
popula `~/.claude/commands/` com os 5 comandos, `ccusage` instalado,
`statusline-wrapper.cjs` executado manualmente contra um payload de
statusline válido e respondeu sem erro. Item 2 acima está satisfeito para
as duas máquinas conhecidas do editor (Windows + `helios`); resta apenas
se houver uma terceira máquina no futuro.

**Achado no caminho, corrigido:** o `settings.json` local em `helios`
tinha `model`/`effortLevel` divergentes do valor committed no
`claude-config`, sem nenhum aviso — como o arquivo é um symlink direto pro
repo git, qualquer edição ao vivo da sessão escreve através do symlink pro
working tree do repo, e `git pull --ff-only` não detecta (nem alerta sobre)
working tree dirty quando o remoto não tem commit novo — a divergência
ficaria invisível indefinidamente. `bootstrap.sh`/`bootstrap.ps1` agora
rodam `git status --porcelain` no repo antes do pull e avisam (sem
bloquear) com o diff resumido e as duas ações possíveis: commit+push (vira
config permanente, compartilhada) ou `git checkout -- .` (descarta,
mantém a máquina de origem como única fonte de verdade).

O drift específico achado em `helios` (260810) foi verificado como
resolvido organicamente numa sessão overnight posterior (260811) —
`git status --porcelain` em `~/claude-config` veio limpo, sem working tree
dirty. Não houve decisão explícita a tomar; o `git pull --ff-only` de uma
sessão seguinte parece ter resolvido sozinho (ou o editor já tinha feito
`git checkout -- .`/commit manualmente).

**Política de `memory/`, decidida pelo editor em 260811: nunca commitar.**
Confirma o comportamento já vigente (exclusão de propósito, ver seção
acima) — não é mudança de mecanismo, é o fechamento formal da decisão que
estava marcada como "não revisitada"/pendente. `memory/` segue de sync
manual (copiar o arquivo à mão quando precisar levar uma memória
específica pra outra máquina); a alternativa de um mecanismo assistido
(diff + confirmação antes de empurrar) continua não implementada, sem
urgência.

## Auto-arme via `diaria-studio` (260828 — fecha o rollout do #6310)

**O ovo-e-galinha que sobrou:** o mecanismo acima (`sync-check.cjs` + hook
`SessionStart` no `settings.json` do PRÓPRIO `claude-config`) só dispara
depois que `~/.claude/settings.json` já é symlink pro repo. Numa máquina que
nunca rodou `bootstrap` — ou que caiu no fallback de cópia do Windows sem
Modo Desenvolvedor — o mecanismo nunca chega a se armar sozinho. É
exatamente o estado medido ao vivo no Neo e no ZenBook em 28/08/2026
(comentários de #6310): a implementação existia e funcionava no `helios`,
mas não tinha como chegar às outras duas máquinas sem alguém rodar o
bootstrap manualmente — o mesmo passo que dependia de lembrar, que é o
problema original da issue.

**Decisão do editor (28/08/2026):** em vez de depender de mais um passo
manual por máquina, vendorar um SEGUNDO hook `SessionStart` — este dentro do
`.claude/settings.json` do repo **`diaria-studio`** (não do `claude-config`).
A diferença crucial: `diaria-studio` é um repo público de trabalho diário,
puxado por `git pull` normal em toda sessão de edição — chega em qualquer
máquina que já usa o projeto, independente do estado do `claude-config`
nela. É essa inversão que fecha o ovo-e-galinha: a máquina se arma ao abrir
o `diaria-studio`, não ao já ter o `claude-config` armado.

Arquivos:
- `diaria-studio/.claude/hooks/session-start-claude-config-sync.mjs` — o
  hook em si, self-contained (mesmo padrão dos hooks irmãos deste repo —
  nunca importa `.ts` estático). Auto-destacamento (spawn detached + exit 0
  imediato no pai, mesmo truque de `sync-check.cjs`), fail-soft total
  (try/catch em volta de tudo, nunca lança, nunca bloqueia a sessão),
  debounce de 1h por timestamp (`~/claude-config/.diaria-studio-autosync-
  state.json`) pra não reclonar/rebootstrapar a cada sessão nova aberta em
  sequência.
- `diaria-studio/scripts/lib/claude-config-autosync.ts` — a lógica de
  DECISÃO pura (clonar? bootstrapar? pular?), testada isoladamente em
  `test/claude-config-autosync.test.ts`. O hook `.mjs` duplica essa lógica
  em JS puro (não importa o `.ts`) — ao mudar a decisão, editar os dois e
  conferir que continuam batendo.

Contrato de decisão (primeira regra que casa vence):

| estado observado | ação |
|---|---|
| debounce ativo (rodou há < 1h nesta máquina) | pula, sem log — caminho feliz recorrente |
| `~/claude-config/.git` ausente | `git clone` + roda o bootstrap da plataforma certa |
| repo presente, `~/.claude/settings.json` NÃO é symlink pro repo | roda só o bootstrap (que já faz `git pull --ff-only` por conta própria) |
| repo presente, `~/.claude/settings.json` JÁ é symlink pro repo | pula — a partir daqui `sync-check.cjs` (agora alcançável pelo symlink) assume o pull recorrente |

Detecção de plataforma: `process.platform === "win32"` → `bootstrap.ps1`
(via `powershell.exe -File`), qualquer outro valor → `bootstrap.sh` (via
`bash`). Log e estado em `~/claude-config/.diaria-studio-autosync.log` /
`.diaria-studio-autosync-state.json` — arquivos NOVOS, distintos de
`.sync-check.log`/`.sync-state.json` (que continuam sendo o registro do
mecanismo do `claude-config` em si).

**Verificado nesta sessão (worktree isolado, sem `~/claude-config` real
disponível):** smoke test manual do hook contra um `claude-config` fake
(`CLAUDE_CONFIG_DIR`/`CLAUDE_CONFIG_HOME_DIR` sobrescrevendo os defaults) —
os três casos (repo ausente, presente-mas-não-armado, já-armado) todos
saíram com `exit 0` no pai, nunca lançaram, e o estado gravado bateu com a
decisão esperada. **O que este PR NÃO pôde verificar:** o `git clone`/
bootstrap reais contra o `claude-config` de verdade, em nenhuma das 3
máquinas (helios/Neo/ZenBook) — isso é efeito de rede/IO fora do alcance de
um worktree isolado de subagente; fica para confirmação ao vivo do editor
(mesmo padrão dos demais itens desta issue marcados "verificado ao vivo").
