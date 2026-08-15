# Drift-check do system prompt do plugin `pr-review-toolkit`

Issue: [#5311](https://github.com/vjpixel/diaria-studio/issues/5311).

`REVIEW_AGENT = "pr-review-toolkit:code-reviewer"` (`.claude/hooks/pr-create-review.mjs`) resolve pra um arquivo do **marketplace**, fora deste repo:

```
~/.claude/plugins/marketplaces/claude-plugins-official/plugins/pr-review-toolkit/agents/code-reviewer.md
```

Esse arquivo (e os outros 4 que `DEFAULT_EFFORT = "max"` dispara — `silent-failure-hunter`, `pr-test-analyzer`, `comment-analyzer`, `type-design-analyzer`) é **per-máquina**, versionado pelo marketplace — pode mudar numa atualização sem aviso, e nada neste repo saberia. O #5304 achou que `code-reviewer.md` contém uma diretiva de limiar de confiança ("Only report issues with confidence ≥ 80") que a instrução do hook precisa SOBREPOR por especificidade — mas essa sobreposição é uma mitigação observada funcionando, não uma garantia versionada. Decisão do editor (14/08/2026): implementar um smoke-test que alarme quando esse texto (ou o equivalente nos outros 4 agentes) mudar de forma relevante.

## O que ele checa

Para cada um dos 5 agentes (`scripts/lib/plugin-review-drift-check.ts` → `PLUGIN_REVIEW_AGENTS`, lista fixa — não descoberta por varredura, porque o plugin também empacota `code-simplifier.md`, que este repo nunca dispatcha via o hook):

1. **Lê o arquivo** em `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/pr-review-toolkit/agents/{agente}.md` (`pluginAgentsDir`, `scripts/plugin-review-drift-check.ts`).
2. **Extrai o sinal relevante** (`extractRelevantSignal`) — só as linhas que contêm vocabulário de filtro de confiança/severidade (`confidence`, `only report`, `filter aggressively`, `high-confidence`, `severity threshold`, `minimum confidence`, case-insensitive). Edição cosmética do marketplace (reformatação, exemplo reescrito) nunca entra nesse sinal — só a linguagem que de fato decide o que o agente reporta ou omite.
3. **Compara com o baseline persistido** (`data/plugin-review-drift-check/state.json`) — 1ª vez que um agente é observado estabelece o baseline sem alarmar (`no_baseline`); sinal igual ao baseline é `unchanged`; sinal diferente é `changed` (o achado que dispara o e-mail).

Hoje, só `code-reviewer.md` tem essa linguagem — os outros 4 nunca foram auditados sob esse ângulo (achado original do #5311). O check roda igual nos 5: um sinal vazio é um resultado válido ("este agente não filtra por confiança/severidade hoje"), e se um deles GANHAR essa linguagem numa atualização futura, o sinal deixa de ser vazio e o `no_baseline` → `changed` da execução seguinte já captura isso.

## Plugin ausente = skip, nunca falha

Sessão cloud / clone fresco não tem `~/.claude/plugins/` — o script detecta o diretório ausente e sai limpo (`console.log` + `return`), sem tocar estado nem alarmar. O hook `pr-create-review.mjs` já cai no `general-purpose` com rubrico inline nesse mesmo cenário (comportamento correto documentado no `CLAUDE.md`, seção "Effort do review automatizado") — este check não deveria soar alarme sobre uma ausência que já tem fallback tratado.

## Por que é uma task agendada, não um teste de CI

O arquivo do plugin não é versionado neste repo — o runner de CI nunca tem `~/.claude/plugins/` instalado, então um teste de CI sempre pularia (skip perpétuo, zero valor de detecção). Rodando localmente/no servidor onde o plugin de fato está instalado (a máquina que dispatcha `gh pr create` + o hook de review), este script é o que detecta o drift de verdade — mesmo padrão de `Diaria-Worker-Drift-Check`/`Diaria-Hub-Drift-Check` (ambos também checam estado externo ao repo/versionamento normal).

## Idempotência

Fingerprint do conjunto de agentes `changed` (`data/plugin-review-drift-check/state.json`, mesmo padrão de `worker-drift-check.ts`):

- o **mesmo** drift persistindo entre execuções não gera um novo e-mail a cada rodada.
- o sinal de um agente **mudando de novo** (ex: limiar indo de 80 pra 90 e depois pra 95) gera um fingerprint novo — alarma de novo.
- o drift **resolvido** (marketplace reverte, ou o editor atualiza a mitigação) tira esse agente do conjunto pendente — o cursor "re-arma"; se ele voltar a driftar depois, alarma de novo mesmo partindo de um cursor re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando algum agente tem sinal alterado.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```bash
  npx tsx scripts/plugin-review-drift-check.ts --dry-run
  ```
- **Log da task agendada**: `data/plugin-review-drift-check/.drift-check.log`.

## O que fazer quando o alarme dispara

1. Ler o diff do sinal no corpo do e-mail (antes/depois) — confirma exatamente qual linha mudou, sem precisar abrir o arquivo do plugin manualmente.
2. Revisar se `.claude/hooks/pr-create-review.mjs` (`buildReviewInstruction`) ainda sobrepõe adequadamente a nova diretiva — ver #5304/#5251 pro racional da sobreposição por especificidade/recência.
3. Se a mudança for uma REDUÇÃO da cobertura (ex: limiar de confiança subindo, ou uma diretiva nova de "reporte só P0/P1"), considerar reforçar a instrução do hook (opção B do #5311) ou promover o caminho `general-purpose` a primário (opção A) — decisão do editor, não automática.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há drift; a leitura do arquivo em si não precisa de credencial nenhuma (leitura local de disco, sem rede). Requer o plugin `pr-review-toolkit` instalado na máquina que roda a task (ver `CLAUDE.md`, passo 3b do setup) — sem ele, a task roda e sai limpo (skip), sem erro.

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Plugin-Review-Drift-Check
systemctl --user daemon-reload
systemctl --user enable --now diaria-plugin-review-drift-check.timer
```

Isso registra a task `Diaria-Plugin-Review-Drift-Check` (diária, 10:20 — logo depois de `Diaria-Robots-Txt-Drift-Check`, mesmo cluster matinal de drift-checks). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-plugin-review-drift-check.timer`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado) — validado via testes da lógica pura (`test/plugin-review-drift-check.test.ts`) + I/O em diretório temporário (`test/plugin-review-drift-check-script.test.ts`), e confirmado manualmente com `--dry-run` contra o plugin real instalado no worktree (todos os 5 agentes resolveram `no_baseline` corretamente — 1ª leitura, sem `state.json` prévio), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750.
