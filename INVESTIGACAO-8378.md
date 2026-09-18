Investigação #8378 — watch-continuo-health: ticks sem registro kind=continuo

Resultado: BLOQUEIO — não há correção autônoma segura sem acesso ao log do tick no 300.

Evidência local:
- 210 tick-sidecars em data/continuo/tick-sidecars/ (desde 260814), 2 sessões tipo continuo em data/sessions/ (última 20:25 hoje).
- scripts/check-continuo-session-registration.ts (#7890) implementa item 2 (detector aditivo), NÃO item 1 (wrapper no cron do Hermes antes do modelo) — ver docstring linha 38-39: "não muda o contrato do protocolo do tick nem o wrapper genérico claude-delegate.sh, reusado por outras skills do Hermes".
- Corpo #8378 exige "conferir o log do tick correlacionado no 300 para entender por que o registro não aconteceu — tipicamente uma falha cedo no passo 1".

Causa provável: falha no passo 1 do tick (auth, rede, guard de colisão) que impede `register --kind continuo`. Não está documentada no repo nem acessível aqui.

Decisão: NÃO implementar correção automática (o próprio PR #7890 escolheu item 2 sobre item 1 por ser puramente aditivo). Comentado como bloqueio na issue.

Referências: .claude/skills/diaria-continuo/SKILL.md (passo 1.3 / contrato do tick); scripts/check-continuo-session-registration.ts; test/continuo-infra-consumidor-externo.test.ts.
