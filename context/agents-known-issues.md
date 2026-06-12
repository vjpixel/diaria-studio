# Agents — known issues e mitigations

Documenta bias/limitações conhecidas dos subagentes que rodam na pipeline.
Orchestrator deve aplicar mitigations descritas aqui antes de tomar decisões
baseadas nos outputs desses agents.

## review-test-email (Haiku 4.5)

### Bias de encoding em WSL/locale — #1421

Agent rodando em Haiku 4.5 (WSL/Windows context) tem viés sistemático ao ler
emails com caracteres não-ASCII:

- Acentos em URL slugs (`karpathy-entra-no-time-de-pre-treino-da-anthropic` —
  Beehiiv normaliza acentos em slugs) são interpretados como corruption do
  body.
- Entities HTML-encoded (`&amp;edition=`) lidos como separador errado
  (`&edition&`).
- Merge tags Beehiiv (`{{poll_sig}}`) ocasionalmente reportadas como
  "stripped" mesmo presentes no HTML.

**Mitigation** (#1421): orchestrator-stage-5.md §5f.5 chama
`scripts/lib/agent-issue-validator.ts::filterAgentIssues()` antes de disparar
fix-mode. Tipos `encoding_drop`, `poll_sig_missing`, `vote_edition_malformed`
são cross-checked contra HTML local — se ground truth confirma OK, dropped.

**Quando reabrir**: se a base do review-test-email mudar de modelo (Sonnet
4.6+ provavelmente resolve o bias) OU se filterAgentIssues começar a ter
falso-positivos próprios (drop issues legítimos). Caso 260520 teve ~16 FPs
ao longo de 4 iterações antes do filter ser introduzido.

### Status "inconclusive" não é "OK" — #1212

Quando o email não chega ao Gmail em 30s, agent retorna
`status: "inconclusive"`. Pre-#1212 isso virava `email_not_found` que o
orchestrator tratava como "review limpo" — falso negativo estrutural.

**Mitigation**: §5f passo 3 — `inconclusive` faz orchestrator sair do loop
com `review_status: "inconclusive"`, NÃO `review_completed: true`. Editor
revisa visualmente no gate.

## source-researcher / discovery-searcher (Haiku 4.5)

### Domain bias em queries genéricas

Discovery agent às vezes retorna mesmo conjunto pequeno de sites
(theverge, techcrunch) mesmo em queries específicas. Tracked em #650 (sem
fix definitivo — mitigation editorial é variar prompt seed).

---

## Quando adicionar entry

Quando descobrir que um agent tem comportamento sistemático que requer
cross-check OU workaround pelo caller. Inclua:

1. **Sintoma** (o que o agent retorna que está errado/enganoso)
2. **Issue/caso real** (referência editorial)
3. **Mitigation** (código ou prompt que o caller usa)
4. **Quando reabrir** (condição que faria a mitigation se tornar dispensável
   ou contraproducente)
