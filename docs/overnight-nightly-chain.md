# Cadeia noturna: review diário e overnight agendado

Issue: [#10552](https://github.com/vjpixel/diaria-studio/issues/10552)

Todas as noites, às 00:15 BRT, no `300`:

1. `hermes/scripts/opus-daily-diff-review.sh` revisa o diff acumulado do dia e abre as issues `[daily-review]`.
2. Quando o review termina, `/diaria-overnight --agendado` sobe numa sessão `claude --print` e já encontra essas issues na fila.

O passo 2 roda **qualquer que seja o resultado do passo 1**: review limpo, noop, falha ou timeout. O backlog existe de qualquer jeito. O review continua executável sozinho.

## Peças

| Peça | Papel |
|---|---|
| `scripts/overnight/run-nightly-chain.ts` | Runner. Roda o review, depois o overnight, e devolve o exit code da cadeia. |
| Task `Diaria-Nightly-Chain` (`scripts/lib/scheduled-tasks.ts`) | Daily 00:15 BRT. Nasceu `enabled: false`; ligada em 20/10/2026. |
| `/diaria-overnight --agendado` (`.claude/skills/diaria-overnight/SKILL.md`, "Modo agendado") | Zero perguntas, loop estendido ligado, sem teto de horário. |
| `briefing.reason: "agendado-desassistido"` (`scripts/lib/overnight-plan-briefing.ts`) | Registro no `plan.json` (#7497). O gate reprova esse `reason` sem `loop_estendido: true`. |

Decisões do editor (19/10/2026, comentários da #10552): horário 00:15, zero perguntas, loop estendido sempre ligado, **sem teto de horário**. O teto das 08:00 que o corpo da issue propunha foi descartado.

## Como o overnight sobe

O runner monta a sessão no molde de `scripts/overnight/run-scheduled-edicao.ts`:

- Remove `CLAUDE_CLI_STRIPPED_ENV_VARS` do ambiente do `claude`. O unit faz `EnvironmentFile=-.env`, e o `.env` tem `ANTHROPIC_API_KEY`; a sessão autentica sempre pela assinatura claude.ai (#5608/#6714).
- Abre a sessão já em `--model claude-sonnet-5-5 --effort medium`, o par do #9530.
- Liga `DISABLE_AUTOUPDATER=1` só no processo filho (#6891).
- Não passa `--no-session-persistence`, porque a Fase 0 lê o próprio transcript (sonda do #9527 e estimativa de tokens). Também não passa `--max-turns`, porque o editor decidiu que a rodada agendada não tem teto.
- Passa `--add-dir=<alvo real de data/>` quando `data/` resolve pra fora do repo (#10569, o mesmo `dataAddDirArgs` do runner da edição, #9086). No `300`, `data` é link pro OneDrive (`/home/vjpixel/OneDrive/Documentos/diaria-studio-data`), e `--permission-mode acceptEdits` só aceita escrita dentro do diretório de trabalho. Sem o flag, o `plan.json` e o `report.md` da rodada seriam negados sem ninguém para aprovar. Clone sem link (`data/` dentro do repo) não recebe o flag.
- Antes de subir, consulta o `session-registry`. Se já existe uma sessão `overnight` ativa, por exemplo uma rodada aberta à mão que ainda não acabou, o overnight é pulado e a cadeia não abre uma segunda rodada.
- O registro da sessão agendada é feito pela própria skill, com `register --kind overnight --unattended` (#7546). O `session_id` é o do processo `claude`, e só o hook `inject-session-id.mjs` o conhece.

O review recebe o diretório do binário `claude` à frente do `PATH`. Sob systemd o `PATH` é o mínimo, sem `~/.npm-global/bin` (#5549), e o script chama `claude` pelo nome. O review tem teto externo de 2h. O próprio script já limita o `claude -p` dele a 90 min.

## Exit codes

| Exit | Significado | Unit |
|---|---|---|
| 0 | Overnight ok (ou pulado por sessão ativa) e review ok/noop | ok |
| 3 | Review falhou ou estourou o tempo, e o overnight rodou | `failed`, de propósito: o `Diaria-Systemd-Failed-Units-Alarm` avisa |
| 5 | 0 PRs com ≥1 unidade implementada, ou contagem final ausente/inválida (`<!-- overnight-delivery: {"implementedUnits":N,"openedPrs":N} -->` no `report.md` desta run, incluindo fila vazia com zeros). Contagem por unidade, incluindo lotes e mini-rodadas; PRs incluem drafts e já mergeados (#11235). | `failed`: `Diaria-Systemd-Failed-Units-Alarm` |
| 4 | Overnight saiu 0 sem gravar `plan.json` nem `report.md` em `data/overnight/*` durante a run: aborto cedo (#10808) | `failed`, de propósito |
| 2 | Overnight falhou: exit ≠ 0 do `claude`, ou evento `result` com `is_error`. O exit original fica no log | `failed` |
| 1 | Binário `claude` não encontrado; nada rodou | `failed` |

Log da task: `data/overnight/.nightly-chain.log` (gravado pelo task-runner só quando o processo termina). Log incremental, linha a linha na hora em que é emitida: `data/overnight/.nightly-chain.live.log` (#10672) — é ele que sobra quando a cadeia morre no meio (reboot, OOM, `systemctl stop`), com o início e o veredito do review já gravados antes de o overnight subir. O caminho dele deriva do `logPath` da task (`x.log` → `x.live.log`), e a cada run o da run anterior vira `.nightly-chain.live.log.prev` (#10699), então o arquivo não cresce sem limite. Saída incremental do `claude --print` do overnight: `data/overnight/.nightly-chain-last-overnight.json` (desde #10699, **JSONL de eventos `stream-json`**, um objeto por linha; o evento `result` contém o resultado final). stdout do review: `.nightly-chain-last-review.log`, no mesmo diretório; stderr dos dois filhos: `.nightly-chain-last-{review,overnight}.stderr.log`. Os filhos escrevem diretamente nesses arquivos durante a execução, preservando uma geração `.prev` quando cada etapa começa. O review também preserva os eventos Claude durante a execução em `data/continuo/last-daily-review-output.jsonl` (com uma geração `.prev`); só um evento `result` sem erro gera o texto usado pelo gate de resumo e avanço do marco. Transcript final do review: `data/continuo/last-daily-review-output.txt`, que é o mesmo arquivo de antes.

O que cada passo deixa no log da cadeia:

- **Review** (#10779): `review: {status} exit=N resumo=… tail=…`. O `noop` só é reconhecido pela linha exata `[daily-review] nada novo desde o último review (…) — noop`, ancorada por linha: o stderr do review carrega o stream-json inteiro, e um diff que contivesse "— noop" num `tool_result` rotulava um review completo como noop. O `tail` descarta os eventos stream-json e corta cada linha em 500 caracteres. A linha `RESUMO-DAILY-REVIEW:` não sai mais no stderr; com status `ok` ela é lida de `last-daily-review-output.txt` e entra como `resumo=`.
- **Overnight** (#10808): `overnight: resultado subtype=… is_error=… turns=N duracao_s=N tail=…`, com as últimas linhas do texto final do `claude`, ou um `AVISO` explícito quando o stream-json não tem evento `result`. Depois, `overnight: rastro {dir}/plan.json` com o que a rodada gravou. Se nenhum `plan.json`/`report.md` em `data/overnight/*` foi modificado desde o início do passo, a linha é `overnight: SEM RASTRO` e a cadeia sai 4: "fila vazia" grava `plan.json` na Fase 0 (e, no modo agendado, um `report.md` curto), então sair sem nada é aborto cedo, que antes aparecia como `overnight=ok`.

## Armar no `300` (passos manuais do editor)

Executado em 20/10/2026 (passos 1 a 3; o rearme do watchdog pós-#10565 incluso). Ordem original:

1. **Ligar a task no registro.** Remover `enabled: false` da entrada `Diaria-Nightly-Chain` em `scripts/lib/scheduled-tasks.ts` (PR de uma linha). Sem isso o `setup-systemd-timers.ts` não gera o unit, e o `run-task.ts` pula a execução. Ela nasce desligada para o `Remediate-Never-Armed-Tasks` (#8153) não armá-la sozinho antes do passo 3.
2. **Gerar e armar o timer**, no checkout do `300` já atualizado com o merge:
   - `npx tsx scripts/setup-systemd-timers.ts --task Diaria-Nightly-Chain`
   - `npx tsx scripts/arm-systemd-timers.ts --task Diaria-Nightly-Chain`
   - conferir com `systemctl --user list-timers --all | grep nightly-chain`
3. **Tirar o review do cron fixo das 09:00.** O job Hermes `645d5debb7f0` roda o mesmo `opus-daily-diff-review.sh` às 09:00. Pause-o no mesmo dia do arme (`hermes cron pause 645d5debb7f0`; confirme o verbo com `hermes cron --help` e o estado com `hermes cron list --all`, porque sem `--all` o job pausado não aparece). Pausar em vez de remover preserva o caminho de volta. Se os dois ficarem ligados, nada quebra: o marco `data/continuo/last-daily-review-sha` já avançou à meia-noite e o run das 09:00 sai noop, ou revisa só o que entrou de madrugada.
4. **Decidir o aviso no Telegram.** O job Hermes é `no_agent=True` e entregava no Telegram o resumo do review quando havia problema (findings > 0, issue que falhou, resumo ilegível). Pela cadeia, esse resumo vai pro log da task. As issues `[daily-review]` continuam sendo abertas, e é nelas que o trabalho acontece; só a notificação some. Se o editor quiser mantê-la, o caminho é um job Hermes leve que leia a última linha `RESUMO-DAILY-REVIEW:` de `data/continuo/last-daily-review-output.txt` depois das 00:15. Fica fora deste PR.
5. **Primeira noite.** Na manhã seguinte, conferir `data/overnight/.nightly-chain.log`, o `plan.json` da rodada (`briefing.reason: "agendado-desassistido"`, `loop_estendido: true`) e `systemctl --user status diaria-nightly-chain.service`.

Para desarmar, voltar `enabled: false` (o `run-task.ts` passa a pular) ou `systemctl --user disable --now diaria-nightly-chain.timer`, e despausar o job `645d5debb7f0`.

## Limitações conhecidas

- **Watchdog precisa do rearme pós-#10565.** Desde o #10565 o `Diaria-Overnight-Watchdog` roda 24h (antes, só de 18:00 a 09:00 BRT), então uma rodada agendada que passe das 09:00 continua vigiada. Isso só vale na máquina depois de regerar e recopiar o timer (`docs/overnight-watchdog-setup.md`, "Rearme depois do #10565"); com o timer antigo armado, a rodada fica sem detecção externa de stall entre 09:00 e 18:00.
- **Sessão single-turn.** Em `claude --print` não existe turno seguinte, então a skill não pode esperar notificação de tarefa em background. O prompt leva a mesma diretiva `NO_BACKGROUND_DIRECTIVE` dos stages da edição agendada, e o "Modo agendado" da skill tira o passo de sonda que dependia de encerrar o turno.
- **Colisão com a edição.** Se uma edição diária estiver em curso, o guard de colisão editorial (Fase 1 passo 1 da skill) encerra a Fase 1 (`preempted_by: edicao_editorial`) e a rodada segue para 1.5 e relatório. Não existe pausa à espera da edição: numa sessão `--print` não há turno seguinte para retomar (#10570).
- **Permissões.** A sessão roda com `--permission-mode acceptEdits`, igual aos stages da edição agendada. Comando Bash fora da allowlist de `.claude/settings.json` é negado, e não há ninguém para aprovar. Se a primeira noite mostrar negações recorrentes no JSON de saída, o conserto é ampliar a allowlist. Prova de 27/10/2026 logo abaixo.
- **Confiança do workspace.** `claude -p` nunca mostra o diálogo de confiança, e a doc diz que as regras `permissions.allow` de `.claude/settings.json` só valem num diretório já confiado (https://code.claude.com/docs/en/permissions, "Project allow rules and workspace trust"). No `300`, `/home/vjpixel/diaria-studio` tem `hasTrustDialogAccepted: true` em `~/.claude.json`, e worktree herda a confiança do checkout principal. Se essa marca sumir (máquina nova, `~/.claude.json` recriado), toda a allowlist do projeto é ignorada, e o único sinal é uma linha `Ignoring N permissions.allow entries ... this workspace has not been trusted` no stderr (`.nightly-chain-last-overnight.stderr.log`). Foi o que aconteceu com o 1º run da prova num clone fora do repo: 38 negações, inclusive `gh pr view` e `node -e`.

## Prova da allowlist (#11235)

Rodada em 27/10/2026 no `300`, depois dos PRs #11250, #11267 e #11275, num worktree descartável sob o checkout confiável (`.claude/worktrees/probe-11235-allow`, branch `probe/allow-11235-base`, criado de `origin/master` 67de39c23). Comando, com as variáveis de `CLAUDE_CLI_STRIPPED_ENV_VARS` removidas do ambiente e `DISABLE_AUTOUPDATER=1`:

```
claude --print --permission-mode acceptEdits --model claude-sonnet-5-5 --effort medium \
  --no-session-persistence --output-format stream-json --verbose < prompt.txt
```

O prompt pedia cada comando numa chamada Bash própria, sem reescrever. A coluna "negado" vem do `permission_denials` do evento `result`, não do texto do modelo. Push foi sempre `--dry-run`, e escrita no GitHub só com `--help`. `gh pr merge` ficou fora.

**Antes** é a rodada agendada 261027 (03:23Z, antes do #11250), lida de `.nightly-chain-last-overnight.json` (`.prev` para a 261026). "n/o" = não aparece negado naquele log.

| Comando | Antes (261026/261027) | Depois (prova 27/10) |
|---|---|---|
| `git status`, `rev-parse`, `merge-base`, `log`, `show`, `diff`, `branch --show-current`, `worktree list` | n/o (read-only) | rodou |
| `git fetch origin master` | negado | rodou |
| `git checkout -b <branch> origin/master`, `git checkout <branch>` | n/o | rodou |
| `git pull`, `git checkout master && git pull` | negado | rodou |
| `git add <arquivos>` | negado | rodou |
| `git commit -m` (inclusive multilinha), `git commit -F <arquivo>`, `git commit -F - <<'EOF'` | negado | rodou |
| `git add a && git commit ...` | negado | rodou |
| `git reset --soft HEAD~1` | n/o | rodou |
| `git push --dry-run -u origin <branch>`, `git push --dry-run origin --delete <branch>` | n/o | rodou |
| `git worktree add -b ...`, `git worktree prune` | n/o | rodou |
| `mkdir -p data/overnight/...`, `cp`, `touch`, `wc`, `sed -i`, redirect `> arquivo` no worktree | n/o | rodou (acceptEdits) |
| `npm ci`, `npm ci --prefer-offline`, `npm ci --dry-run` | negado | rodou |
| `npx tsc --noEmit` / `npx tsc --version` (inclusive `2>&1 \| tail`) | negado | rodou |
| `npx tsx --test ...`, `NODE_TEST_SNAPSHOTS=1 npx tsx --test ...` | n/o | rodou |
| `npx tsx scripts/lib/gh-pr-safe-edit.ts`, `scripts/resolve-review-threads.ts --check`, `scripts/gh-pr-review-api.ts list-comments` | n/o | rodou |
| `node -e`, `gh auth status`, `gh pr view/checks/list`, `gh pr create --help`, `gh issue view/list`, `gh issue comment/edit/create --help`, `gh run list`, `gh search issues`, `sleep`, `date` | n/o | rodou |
| `git -C <worktree> add/status/fetch/checkout/log` | negado | **negado** |
| `cd <dir> && git ...` | n/o (`cd <dir> && python3`/`grep` negados) | **negado** |
| `git merge --ff-only origin/master` | n/o | **negado** |
| `node --test`, `node --import tsx --test`, `npx --no-install tsx --test`, `node_modules/.bin/tsx --test` | negado | **negado** |
| `for f in a b; do echo $f; done` (variável não verificável) | n/o | **negado** |
| `gh api ...` cru | n/o | **negado** (de propósito) |
| `python3 - <<'EOF'` (edição por script) | negado | não testado; fora do fluxo, editar é pela ferramenta Edit |

Nenhuma forma ainda negada é exigida pelo fluxo documentado, por isso a prova não acrescentou regra ao allow list. Na 261027 elas apareceram como contorno depois que a forma canônica foi negada: sem `npm ci`, os subagentes buscavam o `tsx` do checkout principal; sem `git add`, tentavam `git -C`. As formas canônicas estão em `context/overnight-dispatch-rules.md` (item 9), e `test/overnight-agendado-allow-list-11235.test.ts` trava as duas listas (`OVERNIGHT_REQUIRED_BASH_COMMANDS` e `OVERNIGHT_PROBED_DENIED_FORMS`).

Limites da prova: escrita em `.claude/` não entrou (é a #11255, regra 34 das regras de dispatch). A sessão da prova roda no worktree, sem o `.claude/settings.local.json` do checkout principal (gitignored, com `Bash(npx tsx *)` no `300`), então ela é mais restrita que o coordenador real, não menos. Os subagentes herdam as permissões da sessão do coordenador. A confirmação final continua sendo o `report.md` da próxima rodada agendada.
