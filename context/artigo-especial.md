# Artigo Especial — Densidade de Referência

> **Contexto (#5926):** O artigo mensal da diar.ia.br é um texto explicativo
> (narrativa de mecanismo), não uma notícia. Ele precisa ser leve o suficiente
> para ler em 5 minutos, sem sacrificar a profundidade técnica. A **densidade
> de referência** mede quanto o texto se apega a nomes próprios, siglas e
> estatísticas no corpo — em vez de confiar na prosa explicativa.

## Métricas medidos por `scripts/lint-density.ts`

| Métrica | Artigo (antes do #5926) | Benchmark (Superinteressante) |
|---|---|---|
| Frases > 30 palavras | 14 (a maior com 69) | raras; uma ideia por frase |
| Nomes de autor / instituição / conferência no corpo | ~14 | zero — vão para Fontes |
| Siglas em caixa alta | (não medido antes) | — |
| Percentuais / "N pontos percentuais" soltos | 8 | 2–3, ancoradas |

**Tetos** (escalados por `palavras/2000`): frases longas ≤ 2, nomes próprios no
corpo = 0 (não abre frase), siglas ≤ 1, stats ≤ 3. Acima do teto = warning
advisory (exit 0); com `--strict` = exit 1.

## Como reduzir a densidade

### 1. Frases longas → uma ideia por frase
- **Quebrar** nas logical units: cada `mas`, `porque`, `entretanto`, `assim`,
  `por exemplo` vira nova frase.
- **Exemplo:** `"O mecanismo, que foi desenvolvido por Vaswani em 2017, usa
  atenção..."` → `"O mecanismo usa atenção. Ele foi desenvolvido por Vaswani
  em 2017."`

### 2. Nomes próprios no corpo → passar para Fontes
- Toda menção a autor, instituição, conferência no **corpo** vira referência
  na seção **Fontes** (link de rodapé numérico ou `[^1]`).
- **Exceção (allowlist):** produtos/brand que o leitor já conhece não contam:
  ChatGPT, Claude, Gemini, Anthropic, OpenAI, Google, Microsoft. Não listar
  autores menores ou instituições de nicho no texto.
- **Exemplo:** `"Smith et al. (2024) mostraram..."` → `"Um estudo mostrou
  que..."` + `[^1]: Smith et al. (2024), ICML.`

### 3. Siglas em caixa alta → lowercase ou allowlist
- GPT-4, GPT-3, EUA, ONU, IA são excluídos do limite. Outras siglas (ANN,
  CNN, RL, LM) devem vir numa footnote e o nome por extenso no texto:
  `"reinforcement learning (RL)"`.
- Evitar mais de 1 sigla não-allowlist no texto.

### 4. Estatísticas soltas → ancorar sempre
- Todo percentual / número precisa de fonte inline: `"95% [ref]"` ou
  `"95% — segundo estudo X [ref]"`.
- "N pontos percentuais" sem fonte = violação.
- Máximo 2–3 estatísticas por destaque (escalado pro mês inteiro: 3 × número
  de destaques ≈ 9 no máximo).

### 5. Exemplo concreto do mecanismo
- **Nunca só explicar o mecanismo** — sempre mostrar ele acontecendo.
- **Estrutura obrigatória:**
  ```
  O mecanismo funciona assim: <explicação curta>.
  Exemplo: <cenário concreto, 2-3 frases>.
  ```
- O `lint-density.ts` sempre pergunta no final: **"o mecanismo aparece num
  EXEMPLO concreto, ou só é explicado?"** — responder antes de publicar.

## Como funciona o lint

```bash
# Advisory (exit 0 mesmo se exceder — warning no output)
npx tsx scripts/lint-density.ts --file data/monthly/$CYCLE/draft.md

# Strict (exit 1 se algum teto for excedido — bloqueia publicação)
npx tsx scripts/lint-density.ts --file data/monthly/$CYCLE/draft.md --strict
```

## Fixture de teste

- `test/fixtures/density-dense-sample.md` — texto denso (excede tetos)
- `test/fixtures/density-clean-sample.md` — texto limpo (dentro dos tetos)
