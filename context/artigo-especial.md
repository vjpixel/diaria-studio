# Artigo Especial — Playbook

> Superfície de referência para o artigo especial mensal da diar.ia.br
> (`especial.diar.ia.br/{ano}/{slug}`), gerado pela Etapa 2 do
> `/diaria-mensal` via `writer-monthly`.

## 1. Objetivo

O artigo especial é o texto **longo** do projeto — ~2.200 palavras, leitor
nível 2 (de 1 a 5 sobre IA). Diferente do digest diário (rápido, scannable),
o especial exige **densidade baixa de referência**: o leitor aprende por
exemplo, não por princípio.

## 2. Pré-gate: checklist (5926)

Rodar **`scripts/lint-density.ts --file draft.md`** antes de gravar. O
output inclui a linha fixa obrigatória:

> 💭 o mecanismo aparece num EXEMPLO concreto, ou só é explicado?

Se a resposta for "só é explicado", **não publicar** — acrescente um exemplo.

### Métricas do lint (tetos base para 2000 palavras, escalados linearmente)

| Métrica | Teto base | Benchmark (Superinteressante) | Como reduzir |
|---|---|---|---|
| Frases > 30 palavras | 3 | raras; uma ideia por frase | Quebrar em frases de 1 ideia; usar conectivos curtos |
| Nomes próprios no corpo | 2 | zero — vão para Fontes | Passar para footnote numérica; author/institution/conference → Fontes |
| Siglas em caixa alta | 1 | — | Expandir na primeira ocorrência: "GPT-4 (Generative Pre-trained Transformer)" |
| Estatísticas soltas | 3 | 2–3, ancoradas | Sempre "X% (fonte)" ou "X em cada Y (fonte: Z)" |

> **Allowlist** — produtos/brand conhecidos não contam como nome próprio:
> ChatGPT, Claude, Gemini, Anthropic, OpenAI, Google, Microsoft, Apple, Meta,
> Amazon, NVIDIA, Hugging Face, etc.
> GPT-N, EUA, ONU, IA são excluídos de siglas.

### Checklist pré-gate

- [ ] `lint-density.ts` rodado, todos dentro do teto (ou justificativa registrada)
- [ ] Zero author/conference no corpo — todos em Fontes (footnote numérica)
- [ ] ≤1 técnica/benchmark nomeado no corpo
- [ ] Números ancorados: cada stat com fonte inline ou "segundo estudo X"
- [ ] 1 cena/evento noticioso antes da explicação do mecanismo
- [ ] **1 exemplo inofensivo de ~5 linhas mostrando o mecanismo em ação**
- [ ] 1 analogia do cotidiano que carregue a peça (não uma metáfora astraca)
- [ ] Humanizador + Clarice aplicados ao texto INTEIRO (não só trecho novo)
- [ ] URL publicada em `workers/artigos/public/{ano}/{slug}/` com `sitemap lastmod == dateModified` (guard: `test/artigos-cross-refs-5924.test.ts`)

## 3. Estrutura recomendada

```
[APRESENTAÇÃO — pré-amble Clarice × diar.ia.br]

[INTRO — 1 parágrafo: o problema em 1 frase]

---

[EXEMPLO CONCRETO — 1 cena de ~5 linhas mostrando o mecanismo]

---

[EXPLICAÇÃO — o mecanismo, com analogia do cotidiano]

---

[APERFEIÇOAMENTO — como o estado da arte evoluiu]

---

[PERSPETIVA — impacto prático para o leitor brasileiro]

---

[ENCERRAMENTO]
```

## 4. Regras de densidade no `writer-monthly.md`

O agente `writer-monthly` já incorpora as regras de densidade (linha ~60):
- Sem author/conference no corpo — vão para Fontes
- ≤1 técnica nomeada por destaque
- Números ancorados com fonte inline
- Cada destaque: 1 cena antes da explicação, 1 exemplo concreto, 1 analogia

## 5. Frequência de rodada

- `lint-density.ts` roda na Etapa 2b-2 e resumido na Etapa 4c-2 do
  `/diaria-mensal`.
- Advisory por padrão (exit 0). `--strict` (exit 1) apenas em CI de release
  ou quando o editor marca explícita o gate.
