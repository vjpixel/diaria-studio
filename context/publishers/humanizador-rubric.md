# Humanizador — rubric inline (fallback para `clarice-plugin:humanizador` indisponível)

> Usar quando a skill `clarice-plugin:humanizador` retornar `Unknown skill` após 3 retries.
> Aplicar diretamente como prompt ao LLM sobre o arquivo alvo, salvando in-place.

---

## Etapa 0 — Tradução (somente newsletter, não social)

- Itens de seções secundárias com DESCRIÇÃO marcada `[TRADUZIR]` estão em inglês. Traduza **apenas a descrição** (2ª linha) para PT-BR natural e remova o prefixo `[TRADUZIR]`.
- O TÍTULO/link do item **nunca** é traduzido — preserve o nome original do recurso (PT ou EN).
- Se um item não tiver `[TRADUZIR]` mas a descrição estiver em inglês, traduza a descrição também (mantendo o título original).

## Etapa 1 — Rascunho

1. Leia o arquivo, identifique padrões de IA:
   - Travessão excessivo (>1 por 5 parágrafos)
   - Gerúndio em cascata
   - Inflação de importância ("revolucionário", "sem precedentes", "transformador")
   - Fechamentos genéricos ("Em um mundo em constante mudança…")
   - Negação paralela ("não apenas X, mas também Y")
   - Gancho editorial emendado via ", e": "<fato>, e [diz mais sobre / é tão relevante quanto / o que mais pesa / vai além de]" — mover o gancho pro corpo ou cortar a oração (#2658)
   - Conectores repetitivos ("além disso", "nesse sentido", "por outro lado" ≥3× seguidas)
   - Verbos pomposos ("capitanear", "catalisar", "impulsionar" em contexto trivial)
   - Anglicismos desnecessários quando existe equivalente PT-BR natural
2. Reescreva os trechos problemáticos.
3. Salve com Write.
4. Liste os resquícios restantes (bullets curtos, seja crítico).

## Etapa 2 — Versão final

5. Reescreva os resquícios listados na Etapa 1.
6. Salve a versão final com Write.

## Etapa 3 — Resumo

7. Liste as principais mudanças realizadas.

## Regras de preservação (obrigatório)

- Sem markdown (nada de `**`, `#`, `- `) no output final.
- Preservar template: seções, estrutura, links, listas de notícias.
- **Não alterar URLs.**
- Para social: preservar hashtags, emojis, estrutura de seções (`# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3`).
- Meta quantitativa: **zero travessões** no output (exceção: diálogo e meia-risca numérica).
