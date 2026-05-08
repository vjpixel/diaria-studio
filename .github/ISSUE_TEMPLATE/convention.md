---
name: Convention / Invariant
about: Estabelece regra do projeto que não pode ser violada (registrada em CLAUDE.md, agent prompt, ou script)
labels: convention
---

## Regra

<!-- Imperativo curto, uma linha. Ex: "Lançamentos só com link oficial." -->

## Justificativa

<!-- Por que essa regra existe? Qual problema ela previne? Cite incidente específico se houver. -->

## Onde será codificada

- [ ] CLAUDE.md (linha aprox: __)
- [ ] Agent prompt: __
- [ ] Script TS: __
- [ ] Pre-flight check em `scripts/check-invariants.ts`
- [ ] Outro: __

## Verificação

<!-- Como saber que a regra está sendo seguida? Que teste/check valida? -->

## Definition of Done

Esta issue só fecha quando:
1. Pelo menos um item de "Onde será codificada" tem checkbox marcado
2. O link/linha está colado em comentário de fechamento
3. Se aplicável, `scripts/check-invariants.ts` recebeu o check correspondente
