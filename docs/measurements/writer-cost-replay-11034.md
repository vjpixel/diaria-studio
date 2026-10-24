# writer-destaque: replay de custo do candidato #11007

Medição de 24/10/2026 para a [issue #11034](https://github.com/vjpixel/diaria-studio/issues/11034). Nenhum prompt foi alterado e nenhum gasto recorrente foi aprovado.

## Método

- Replay LIVE pela assinatura claude.ai Max (autenticação verificada), sem API paga. D1 somente, três repetições por lado, baseline antes do candidato, mesmo input congelado. O harness reutiliza o diretório de cada lado entre repetições; elas não são ambientes independentes.
- Baseline: `f6ad6e2ea1582fa8de54e848c556cb79cf0389ec` (base do #11007). Candidato em disco idêntico ao arquivo `writer-destaque.md` do head `a329c517b5430a57175382d49955085775c5a257`. Harness/checkout: `201fc5463`.
- Ambos usam `claude-opus-5-5`, effort `low`, conforme frontmatter. Quatro novas edições consecutivas disponíveis (261019–261022), 24 execuções novas. As 18 execuções originais de 23/10 foram apenas relidas.
- Tokens = input + output + cache creation + cache read. O total não pondera preços nem equivale a dólares ou aumento da cobrança da assinatura. O artefato não preserva a decomposição para calcular preço por categoria. Turnos = `num_turns` do CLI, registrado no campo legado `tool_uses`. Duração = soma de `duration_ms`.
- Os graders verificam regras mecânicas, não a qualidade editorial do impacto social. Amostra pequena, ordem não aleatorizada e alta variabilidade: não permite atribuir causalidade ou extrapolar para D1–D3, edição inteira ou custo mensal. O harness atual amplia a amostra, sem reproduzir integralmente o ambiente de 23/10.

## Resultados

Totais das três repetições por lado. B = baseline; C = candidato.

| Edição | Amostra | Tokens B | Tokens C | Delta | Turnos B/C | Duração B/C (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 260713 | original | 659,310 | 730,038 | +10.73% | 12/14 | 105.6/143.5 |
| 260715 | original | 516,626 | 590,630 | +14.32% | 11/11 | 77.1/96.6 |
| 260911 | original | 591,778 | 1,274,861 | +115.43% | 12/26 | 86.1/154.6 |
| 261019 | nova | 713,476 | 588,591 | -17.50% | 15/12 | 104.0/97.6 |
| 261020 | nova | 650,273 | 794,610 | +22.20% | 13/16 | 93.4/114.0 |
| 261021 | nova | 646,088 | 507,834 | -21.40% | 13/12 | 95.3/106.3 |
| 261022 | nova | 851,004 | 1,409,434 | +65.62% | 20/22 | 123.7/216.6 |

| Amostra | Tokens B | Tokens C | Delta agregado | Edições com aumento |
| --- | ---: | ---: | ---: | ---: |
| Original | 1,767,714 | 2,595,529 | +46.83% | 3/3 |
| Nova | 2,860,841 | 3,300,469 | +15.37% | 2/4 |
| Combinada (descritiva) | 4,628,555 | 5,895,998 | +27.38% | 5/7 |

O aumento não é universal: duas das quatro novas edições ficaram mais baratas em tokens. O agregado cresce nas duas amostras, mas a magnitude varia bastante. Em 261022, o candidato variou de 128.966 a 813.326 tokens entre repetições; não há fundamento para tratar o delta como taxa fixa de custo recorrente.

### Tokens por repetição (ordem de execução em cada lado)

| Edição | Baseline | Candidato |
| --- | --- | --- |
| 260713 | 197311, 331319, 130680 | 199124, 198769, 332145 |
| 260715 | 255739, 130454, 130433 | 131272, 329020, 130338 |
| 260911 | 197135, 196697, 197946 | 325367, 683038, 266456 |
| 261019 | 332287, 190544, 190645 | 195790, 197661, 195140 |
| 261020 | 260456, 259570, 130247 | 195716, 402358, 196536 |
| 261021 | 263224, 254963, 127901 | 200560, 110036, 197238 |
| 261022 | 196618, 325952, 328434 | 128966, 467142, 813326 |

### Graders das quatro novas edições

- 0 regressões, 0 melhorias, 11 deltas `unchanged` e 5 `inconclusive`.
- `banned-lexicon`: aprovado nos dois lados das quatro edições.
- `newsletter-lint-gate-blocking`: falha nos dois lados das quatro edições. `unchanged` não significa aprovado; o fragmento D1 não satisfaz o lint de uma newsletter completa.
- `carousel-text-overflow`: inconclusivo nas quatro edições (este agente não produz carrossel).
- `title-length-52-chars`: unchanged/aprovado em 261019, 261021 e 261022; inconclusivo em 261020 por inconsistência entre repetições. Nenhum desses resultados demonstra ganho editorial.

## Reprodução e evidência

O candidato deve ser o arquivo do head do #11007 indicado acima. Rodar LIVE consome quota da assinatura; nenhuma execução recorrente foi criada. Sem `--live`, apenas prepara fixtures.

```sh
npx tsx scripts/eval-prompt-regression.ts --agent writer-destaque \
  --baseline-ref f6ad6e2ea1582fa8de54e848c556cb79cf0389ec \
  --reference-editions 261019,261020,261021,261022 --repetitions 3 \
  --live --out /tmp/11034-writer-cost-live.json
```

Artefatos locais não versionados: `/tmp/11034-writer-cost-live.json` e `data/editions/replay-writer-destaque-{AAMMDD}-{baseline|candidate}/_internal/` (cost.json, replay-manifest.json e outputs). Evidência original: `data/reports/agent-eval/pr-11007.md` e [comentário do eval original](https://github.com/vjpixel/diaria-studio/pull/11007#issuecomment-6358026078).

SHA-256 do `_internal/01-approved.json` congelado em cada fixture; igualdade baseline/candidato verificada:

| Edição | SHA-256 |
| --- | --- |
| 261019 | `a8952ab3b0f4abe4fa674d1e8a5ea10ae1867922e40384f34d96fc0dc638c15f` |
| 261020 | `488e73f28757ad61af03e1904a93aa4d9c55c64cc691d2b4d33df1e882078ed2` |
| 261021 | `550ad4b598acdf2bf57d12b115b7d02c655a3d0beee7b7966cf3e97f6eadc828` |
| 261022 | `ff47ca3d812a56431c507b67c2c5f2eaa6c4a8ee2ef6747795f59f9a0e1cc391` |

## Decisão restante / bloqueio

A medição mecânica está concluída. O editor precisa avaliar pares de textos e decidir se o ganho em impacto social justifica a variação de tokens, se pede ajuste pontual ou outra amostra. Não há critério documentado que converta tokens em qualidade editorial. A issue permanece aberta para essa decisão; este relatório não autoriza gasto recorrente nem reverte a decisão editorial do #10980.

Validação: 52 testes do harness passaram (`test/eval-prompt-regression.test.ts` e `test/prompt-regression-eval.test.ts`). Os 24 outcomes novos têm usage e output produzido. Entrega de medição/documentação, sem bugfix ou código executável novo.
