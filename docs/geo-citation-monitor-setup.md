# Monitor semanal de citação por assistente de IA

Issue: [#4558](https://github.com/vjpixel/diaria-studio/issues/4558) (Parte C).

Pergunta a cada provedor de LLM com API key configurada as perguntas fixas de
`GEO_QUESTIONS` (ex: "Qual a melhor newsletter diária sobre inteligência
artificial em português?") e registra se a diar.ia.br foi citada — série de
tendência sobre GEO (Generative Engine Optimization).

## Por que a task existe

O monitor foi mergeado no #4616 e ficou sem NUNCA ter rodado — `data/geo-citations/`
não existia no disco até 07/ago, e nenhum `.ps1`/workflow/task o invocava,
enquanto todas as outras tasks agendadas do repo já seguiam esse padrão. Sem
cadência o histórico nunca acumula.

## Baseline medido em 07/ago

**0 de 16 consultas citaram** — 8 perguntas × OpenAI + Gemini, sendo 15
respondidas + 1 erro de rede; `ANTHROPIC_API_KEY` ausente do `.env`, provedor
pulado por fail-soft. Zero não é veredito: o hub tinha 3 dias e ficou órfão
de link interno até o #4749.

## Cadência: semanal, não diário

Citação por assistente muda em escala de semanas e a série só vale como
tendência — diário gastaria 7× pra ler ruído. Roda **segundas 10:30**. Não
colide com `Diaria-SEO-Weekly` (segundas 04:10).

Custo por execução **nunca foi medido**; OpenAI/Anthropic cobram por token,
mas a Gemini tem free tier que 8 chamadas/semana plausivelmente não estouram.
Conferir fatura antes de afirmar custo.

## Exit code honesto sob `--strict` (#4754)

Rodado **na mão**, o monitor continua saindo 0 mesmo sem key configurada —
"sem key" é estado válido, decisão deliberada do #4616 que não foi revertida.

Rodado **pela task** (o wrapper passa `--strict`):
- sai **2** se nenhum provider está configurado (caminho que não escreve nada
  em `history.jsonl`).
- sai **1** se 100% das consultas falham (ali o exit 0 seria mentira, a task
  marcaria verde para sempre enquanto a série congelava).
- falha **parcial** continua 0 nos dois modos (o fail-soft por provedor é
  desenhado).
- **exceção**: 100% de HTTP **429** sai 0 com aviso, não 1 — as 8 perguntas
  de um provider saem em sequência com um único retry de 1,5s, e num free
  tier de RPM baixo (o Gemini é o caso concreto) isso pode dar 429 em todas
  TODA semana sem nada estar quebrado; alarme falso recorrente treina o
  editor a ignorar o alarme.

Erro de outra natureza nomeia a causa dominante (`HTTP 401 (8)`,
`network (8)`) em vez de um genérico "verifique as keys". A decisão vive em
`resolveStrictOutcome`, função pura exportada e testada — não embutida no
`main()`, que não tem ponto de injeção.

## Log

`data/geo-citations/.monitor.log` (append-only).

## Staleness

O guard `test/pending-scheduled-tasks.test.ts` descobre esta task pelo nome,
mas cobre só o registro inicial — não checa `State`/`LastTaskResult`. Uma
task registrada e depois **desabilitada** passa nele em silêncio. O alarme
que fecha essa lacuna é a #4755 — ver `docs/geo-citation-staleness-alarm-setup.md`.

## Painel temático, alarme de queda de provedor, aviso de conflito OneDrive (#4900)

Três defeitos achados na auditoria de 10/ago, endereçados por código nesta
issue (a documentação completa do achado — incluindo o paper que embasa a
cadência semanal — vive no corpo da própria issue, não duplicada aqui):

- **`--panel geral|hubs`** (default `geral`, comportamento inalterado). O
  painel `hubs` (`GEO_HUB_QUESTIONS`) cobre o que as páginas
  `arquivo.diar.ia.br/temas/{slug}` respondem (Anthropic/Claude, OpenAI/
  ChatGPT, Google/Gemini) — série SEPARADA de `GEO_QUESTIONS`, nunca uma
  substituição (trocar as perguntas originais depois de já ter série medida
  invalidaria o baseline de 07/ago). **Deliberadamente fora do cron por
  enquanto** — ativar antes de fechar o duplo escritor (item abaixo / épica
  #4798) multiplicaria o registro perdido a cada rodada nova.
- **Aviso de queda de provedor.** Se a rodada atual roda com menos providers
  configurados que a rodada anterior do mesmo painel (ex: `GEMINI_API_KEY`
  ficou vazia nesta máquina), o log imprime um `AVISO` explícito — antes,
  "rodou sem esse provedor" só era recuperável contando linha por linha em
  `history.jsonl` a mão. Não muda o exit code; é sinal, não alarme por
  e-mail (ver issue #4900 item b pro desenho completo do alarme, ainda não
  implementado).
- **Aviso de conflito de escrita OneDrive.** Se `data/geo-citations/`
  contiver algum arquivo `*-safeBackup-*` (padrão do cliente OneDrive Linux
  quando 2 máquinas escrevem `history.jsonl` na mesma janela — achado ao
  vivo: `history-predator-safeBackup-0001.jsonl`, 8 registros órfãos), o
  monitor avisa a cada execução. **Só detecta, não reconcilia** — mesclar o
  arquivo órfão de volta é operação manual sobre dado real de produção. A
  causa raiz (2 máquinas rodando a mesma task) fecha com a épica #4798.

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + ao menos UMA de
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-geo-citation-monitor-schedule.ps1
```

Isso registra a task `Diaria-Geo-Citation-Monitor` (segundas 10:30).
Idempotente — re-executar atualiza a task. Remover: mesmo comando com
`-Unregister`.

**Registro da task não feito em nenhuma unidade de worktree isolado** (mesma
disciplina do #4320/#4382/#4490/#4534/#4723) — mas, diferente daquelas, a
**1ª execução do monitor em si já rodou ao vivo** (baseline acima, comentado
na #4558); o que falta é só a cadência.
