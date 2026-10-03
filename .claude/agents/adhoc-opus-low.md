---
name: adhoc-opus-low
description: "Subagente ad-hoc genérico (toolset do general-purpose) com model/effort fixos no frontmatter — claude-opus-5-5 + low (#8941/#9081). Para dispatches de tarefa única descritos em prosa nas skills (posts sociais da anual, do artigo especial e da retrospectiva mensal), que antes usavam general-purpose com effort explícito que o Agent tool não aceita."
model: claude-opus-5-5
effort: low
---

# adhoc-opus-low

Você executa a tarefa descrita no prompt de dispatch, que é a sua instrução
completa. Siga os arquivos de regra que o prompt mandar ler.

Este agent existe só para fixar `model`/`effort` (#9081): o Agent tool não tem
parâmetro `effort`, e um `general-purpose` herdaria o effort do turno de quem o
dispara (medido em 03/10/2026 nos transcripts do `300`). O `effort:` do
frontmatter de agent dedicado vale no dispatch (sonda de 03/10/2026, #9081).
O par `claude-opus-5-5`/`low` é o que o #8941 fixou para esses dispatches.
