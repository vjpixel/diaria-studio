# Lane de piloto em modelo de gateway (#6930) — ENCERRADA (#10387)

**Encerrada em 18/10/2026 (#10387).** Decisão do editor: "não estou mais
usando modelos pagos no OpenRouter". A lane existia para medir um modelo PAGO
de gateway (`z-ai/glm-5.3-flash`, depois `deepseek/deepseek-v4-flash` desde o
#10367), então deixou de ter objeto. Este arquivo é o registro do
encerramento que o `CLAUDE.md` aponta (regra #5608/#6714); não autoriza nada.
Reabrir exige nova decisão do editor revertendo o #10387.

## O que era

Um lane de piloto decidido em 01/09/2026 para drenar issues de aceite
mecânico e medir o custo do modelo de gateway sob volume real. Despachava 1
unidade por vez via `hermes/scripts/claude-delegate.sh` (`ANTHROPIC_BASE_URL`
+ `ANTHROPIC_AUTH_TOKEN` escopados ao subprocesso), como produtor apenas
(`--tools` sem `gh pr merge`/`gh pr review`/`gh issue close|edit`), com teto
de 10 unidades e critérios de morte mecânicos. Só 2 unidades reais rodaram,
com o glm em 01/09/2026: #6928 (US$ 0,0108, acertou) e #6950 (US$ 0,2407,
review com 3 findings).

## O que saiu

- #10431: o harness inteiro (`check-glm-lane-gate.ts`, `lib/glm-lane-gate.ts`,
  `record-glm-lane-unit.ts`, `lib/glm-lane-headref-guard.sh` e os testes), e o
  corpo de `scripts/dispatch-glm-lane-unit.sh`, que virou lápide (exit 3);
- #14059: a lápide `scripts/dispatch-glm-lane-unit.sh`, o npm script
  `glm-lane-dispatch`, `scripts/glm-lane-credits.ts` (leitura de
  `/api/v1/credits` do OpenRouter, sem consumidor) e o teste dele. O código
  completo do piloto está no histórico do git.

## O que ficou

- `hermes/scripts/claude-delegate.sh` recusa `--model` que não seja `:free`
  nem o elo de assinatura (exit 2), e a cadeia default não tem elo pago
  (travado em `test/no-paid-openrouter-10387.test.ts`);
- quem vigia custo é o alarme de billing
  (`scripts/openrouter-billing-leak-check.ts`: qualquer cobrança > 0 no
  OpenRouter acusa). Risco aceito (#10431): o portão confia no sufixo
  `:free`, e um `:free` que passe a ser cobrado só aparece no alarme do dia
  seguinte;
- luna fica fora de `EXPECTED_PAID_MODELS`: a rota real é `openai-codex`
  (`SUBSCRIPTION_ROUTE_MODELS` no relatório Python do Hermes).

## Achado que continua valendo (#6947)

Sessão de Claude Code autenticada por gateway não registra peer: medido no
`300` em 01/09/2026, ela nunca criou socket em `/run/user/1000/cc-socks/` nem
apareceu em `ListAgents`, enquanto as sessões da assinatura claude.ai
apareceram na hora. A mensageria entre sessões (`SendMessage`/`ListAgents`)
cai junto com os conectores claude.ai. Um modelo de gateway só recebe
trabalho por invocação (`claude -p`), nunca como sessão de vida longa
despertada por `SendMessage`.

## Relacionadas

#6930 (proposta e desenho), #6941 e #6954 (reviews do harness), #6947 (sessão
por gateway sem peer), #10367 (troca para o deepseek), #10387 (encerramento),
#10431 (remoção do harness), #14059 (remoção da lápide e do leitor de
crédito), #5608 e #6714 (a regra a que a lane abria exceção).
