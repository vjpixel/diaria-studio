---
name: diaria-ads-relatorio
description: Relatório diário do teste de 3 canais pagos (teste 2608) — CAC da janela móvel + contexto de janela (fim/coorte madura/gasto esperado) + achados de gasto acima do esperado. Fonte canônica desta skill, que a task LOCAL do Claude Code `relatorio-diario-teste-2608` (no Neo, fora deste repo) referencia em vez de duplicar em prosa.
---

# /diaria-ads-relatorio

**Origem (#8246):** as instruções desta task viviam só em
`~/.claude/scheduled-tasks/relatorio-diario-teste-2608/SKILL.md`, fora do
git — sem review, sem teste, sem CI. Datas de marco do teste (fim da
janela, coorte madura) foram copiadas do `run-state.json` na hora em que
esse arquivo foi escrito, e ficaram velhas na primeira vez que o
`run-state.json` foi revisado (pausa de veiculação registrada, fim da
janela mudou) sem que a prosa acompanhasse. Esta skill nunca cita uma data
de marco do teste — tudo vem, em tempo de execução, do `--json` das duas
CLIs abaixo, que leem `data/aquisicao/teste-2608/run-state.json` na hora.
`test/no-literal-dates-diaria-ads-relatorio.test.ts` trava isso em CI.

**A task local `relatorio-diario-teste-2608` (Neo, diária 10:07 BRT — ver
`docs/scheduled-tasks-registry.md`) deve ser um PONTEIRO de poucas linhas
pra esta skill**, não uma cópia. Trocar o conteúdo dela pelo ponteiro é
passo manual do editor, feito na máquina Neo — não faz parte desta PR.

## Passo 1 — CAC da janela móvel + contexto de janela

```bash
npx tsx scripts/ads-rolling-cac.ts --json
```

Miolo puro: `scripts/lib/ads-rolling-window.ts` (janela móvel, comparabilidade,
piso de amostra) + `scripts/lib/ads-window-context.ts` (#8246 — o campo
`contextoJanela` do JSON).

Ler do `contextoJanela` do resultado, **nunca de memória ou de uma data
escrita em algum lugar**:

- `contextoJanela.d0` / `contextoJanela.fimJanela` — início/fim da janela
  de veiculação vigentes.
- `contextoJanela.janelaEncerrada` (`true`/`false`/`null`) — `true` só
  quando hoje já passou de `fimJanela`. **Se vier `true`, dizer isso
  explicitamente no relatório e sugerir ao editor desativar a task** (a
  skill nunca desativa a task sozinha — é ação local, fora do repo).
  `null` significa `run-state.json` ausente/sem `d0`/`fim_janela` — tratar
  como ERRO de dado, não como "janela terminou".
- `contextoJanela.coorteMadura` / `contextoJanela.coorteAtingida` — quando
  atingida, mencionar que a apuração formal (`apuracao_snapshot` do
  `run-state.json`) já pode ser calculada quando chegar a data.
- `contextoJanela.gastoEsperadoAteOntemPorBraco` — gasto PLANEJADO
  acumulado até ontem por braço, já descontando pausa e usando o
  diário vigente de cada braço (`orcamento_diario_brl` do run-state,
  quando presente — nunca um valor fixo por braço).

Do restante do JSON (`resultados[]`), narrar: CAC da janela de 3 dias por
braço, se é comparável (`comparavel`/`motivo` — nunca tratar `null` de
`custoPorCadastro` como "pior colocado", é "sem amostra suficiente"; o
piso de amostra é `MIN_CADASTROS_PARA_COMPARAR`, 3 cadastros na janela,
exportado de `scripts/lib/ads-rolling-window.ts`), e a frase de
`descreverEstabilidade` embutida.

## Passo 2 — achados de gasto acima do esperado

```bash
npx tsx scripts/ads-test-watch.ts --dry-run
```

Avalia condição de MORTE (gasto acumulado > 2× o planejado do período,
`evaluateSpendOverageDeathCondition`) e AVISO sem efeito de morte
(`evaluateSpendWarning`, faixa `[SPEND_WARNING_RATIO_THRESHOLD, 2]` —
`SPEND_WARNING_RATIO_THRESHOLD` é 1,25×, exportado de
`scripts/lib/ads-test-watch.ts`) — os dois já descontam pausa e usam o
diário vigente por braço, sem cálculo paralelo aqui. `--dry-run` só
avalia e imprime; não envia e-mail nem grava estado (isso é papel da task
`Diaria-Ads-Test-Watch`, separada desta).

Gasto de cada braço junta CSV manual (`clicks-2608.csv`, reconciliado
§8.3) com a fonte automática (Google/Microsoft/Meta Ads via API — não
navegador) quando disponível; credencial ausente cai pro CSV manual sem
abortar (`resolveArmSpend`). Um braço com mais de uma campanha em voo
(ex: 2 campanhas Microsoft no mesmo braço do teste) é responsabilidade da
fonte automática/`run-state.json` somar — esta skill nunca soma campanhas
por conta própria.

## Passo 3 — compor o relatório

Narrar os dois passos acima numa mensagem só. **Toda execução termina com
texto explícito**, mesmo quando não há nada a reportar (ex: todos os
braços pausados) — nunca terminar só numa chamada de ferramenta sem texto.

Se `contextoJanela.d0` vier `null` (run-state ilegível/ausente), o
relatório para com erro claro — não segue interpretando `resultados[]`
sem saber se a janela ainda está em andamento.

## Regras

- Zero cálculo de data/orçamento/pausa em prosa nesta skill — só leitura
  do `--json` das duas CLIs acima.
- **Nunca EXECUTAR nada que publique/pause campanha** — as duas CLIs deste
  playbook são somente leitura (`ads-rolling-cac.ts` não tem side effect
  nenhum; `ads-test-watch.ts --dry-run` explicitamente não grava/envia).
  Pausar/reativar campanha é sempre ação manual do editor no painel da
  plataforma, ou uma automated rule já configurada — nunca esta skill.
