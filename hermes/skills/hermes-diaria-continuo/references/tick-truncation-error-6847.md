---
name: tick-truncation-error-6847
description: "Response truncated due to output length limit" pode estar mentindo — 2 causas indistinguíveis no log atual do tick (#6847).
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, pitfall, truncation, observabilidade]
---

Esse `RuntimeError` tem DUAS causas possíveis no harness
(`tests/run_agent/test_partial_stream_finish_reason.py`, classe
`TestCleanStreamEndMidToolCall`, em `~/hermes-agent`, fora deste repo):
(1) truncagem real por limite de output, ou (2) o provedor derrubando o
stream no meio da geração dos argumentos de uma tool call — que o caminho
de rotulagem pode marcar erroneamente como (1). A ação correta diverge:
(1) pede fatiar a saída pedida ao modelo; (2) é instabilidade de provedor,
e mexer em `max_tokens`/tamanho de saída não resolve nada.

Hoje **não há como distinguir os dois a partir do log do tick** —
`~/.hermes/logs/agent.log` registra a mensagem final, não o `finish_reason`
recebido nem se houve tool call parcial (lacuna de observabilidade ainda
aberta, #6847).

Modo de falha vizinho, mesma janela, ainda sem discriminador: `Fire claim
lost; execution was not started`.
