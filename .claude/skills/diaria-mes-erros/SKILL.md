---
name: diaria-mes-erros
description: Lista todos os erros intencionais declarados pelo editor nas edições de um mês (concurso "ache o erro, ganhe um número"). Lê o frontmatter `intentional_error` de cada `02-reviewed.md` em `data/editions/{YYMM}*/` e agrega numa tabela markdown com categoria, localização, descrição e valor correto. Identifica edições sem declaração. Argumento — YYMM (ex — 2605 para maio 2026).
---

# /diaria-mes-erros [YYMM]

Lista os erros intencionais declarados nas edições de um mês. Usado pelo editor pra:
- Rodar o sorteio mensal sem garimpar manualmente cada `02-reviewed.md`
- Identificar edições sem declaração (precisam ser corrigidas pra futuro)
- Ver estatística por categoria (factual / numerico / attribution / etc.)

**Quando usar:**
- No final do mês, antes de rodar o sorteio (cross-reference com `/diaria-sorteio draw --month YYYY-MM`).
- A qualquer momento pra auditar declaração no mês corrente.

## Argumentos

- **YYMM** (obrigatório): mês a listar, formato 4 dígitos. Ex: `2605` = maio 2026.

## Execução

1. Rodar o CLI:

```bash
npx tsx scripts/list-month-errors.ts --month {YYMM}
```

2. Output stdout — markdown formatado com:
   - Tabela das edições com erro declarado (Edição | Categoria | Localização | Descrição | Valor correto)
   - Lista de edições sem declaração (com motivo: arquivo ausente, frontmatter ausente, campos faltando, etc.)
   - Estatística por categoria

3. Apresentar o output ao editor (não salvar em arquivo automaticamente — editor pode copiar pra wiki/notas).

4. Se houver edições sem declaração, sugerir ao editor:
   > N edições sem `intentional_error` declarado. Adicione frontmatter retroativamente em cada `02-reviewed.md` pra fechar o histórico.

## Exemplo de output

```markdown
# Erros intencionais — 2026-05 (22 edições)

| Edição | Categoria | Localização | Descrição | Valor correto |
|---|---|---|---|---|
| 260501 | numeric | DESTAQUE 1, parágrafo 2 | "500 milhões" no lugar de "50 milhões" | 50 milhões |
| 260502 | attribution | OUTRAS NOTÍCIAS, item 3 | "Anthropic" no lugar de "DeepMind" | DeepMind |
| 260505 | version_inconsistency | DESTAQUE 2 | V4 no título, V5/V6/V7 no corpo | V5 |

## Edições sem declaração (3)
- **260506**: intentional_error_missing: 02-reviewed.md sem frontmatter
- **260507**: intentional_error_incomplete: campos faltando — correct_value
- **260508**: 02-reviewed.md ausente

## Estatística por categoria
- **numeric**: 8
- **attribution**: 6
- **factual**: 4
- **ortografico**: 3
- **version_inconsistency**: 1
```

## Variantes

- `--json`: output JSON estruturado em vez de markdown (pra encadear com outros scripts).

## Falhas comuns

- **Mês fora do formato YYMM**: CLI sai com exit 2. Confirmar `4 dígitos`.
- **Nenhuma edição encontrada**: mês sem dados em `data/editions/`. Output JSON `{ "month": "YYMM", "editions": [] }`.
