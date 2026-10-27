---
name: diaria-stack
description: Escreve o texto PRÓPRIO do post semanal do Radar de Notícias Stack (comunidade Circle da Stack, #11184) — abertura e descrição de cada item de Lançamentos, Use melhor e Radar, no ângulo de quem constrói com Lovable, Cursor, Claude Code, n8n e Replit, partindo da seleção da semana e das fontes oficiais dessas ferramentas (#10952). Agente `stack-writer` + humanizador + Clarice + validação mecânica, gravado na seleção que `scripts/publish-circle-stack.ts` publica. DRY-RUN por padrão; `--publish` envia (o post sai PUBLICADO na hora, sem rascunho) só depois da confirmação do editor sobre a prévia. Uso — `/diaria-stack [AAMMDD-da-segunda] [--publish] [--reselect]`.
disable-model-invocation: true
---

# /diaria-stack

Post semanal da diar.ia.br no espaço "Radar de Notícias Stack" da comunidade
Circle da Stack (`plataforma.stack.com.br/c/radar-de-noticias-stack`). O
transporte já existe (#10904): `scripts/publish-circle-stack.ts` monta a
seleção da semana a partir das edições diárias, renderiza a prévia e, só com
`--publish`, envia ao webhook n8n da Stack. A task de segunda
`Diaria-Circle-Stack-Weekly-Preview` (servidor `300`) roda esse publicador em
dry-run e abre uma issue `bloqueio-execucao` avisando que a prévia está pronta.

Esta skill escreve o que faltava (decisão do editor de 22/10/2026 na #10904:
o público da Stack é específico e o conteúdo é **próprio, diferente do
LinkedIn**):

- a **abertura** do post, para quem constrói (vence o resumo automático com a
  1ª frase de cada destaque, #11186);
- a **descrição** de cada item de Lançamentos, Use melhor e Radar
  (`stackNote`, substitui o texto da newsletter na lista).

Os **destaques não mudam**: título, corpo e "Por que isso importa" saem iguais
aos da diária (pedido do editor de 23/10/2026, poupa revisão). O render ignora
`stackNote` em destaque, e o agente nem recebe destaque como item a escrever.

Peças: `.claude/agents/stack-writer.md` (escrita), `scripts/circle-stack-copy.ts`
(insumo do agente, validação, gravação na seleção; lógica pura em
`scripts/lib/circle-stack-copy.ts`), `scripts/publish-circle-stack.ts` (seleção,
prévia, envio).

## Argumentos

- `AAMMDD` (opcional) — a **segunda-feira de publicação** (a semana de
  conteúdo é a de segunda a sexta anteriores). Omitido: assumir a segunda de
  hoje ou a anterior, a mesma regra do publicador, e imprimir o banner
  `Data não informada — assumindo {AAMMDD} (segunda de publicação). Passe AAMMDD explicitamente para outra semana.`
  Nunca parar para confirmar a data.
- `--publish` — depois da prévia e da confirmação do editor (Passo 6), envia
  o post. Sem a flag, a skill para na prévia e imprime o comando de envio.
- `--reselect` — refaz a seleção da semana do zero (repassado ao Passo 1).
  Apaga os ajustes manuais da seleção anterior, inclusive o texto desta skill.

## Guard de execução

- **Nunca** rodar o Passo 6 sem `--publish` passado pelo editor NESTA
  invocação, e nunca dentro de `/diaria-overnight`, `/diaria-continuo` ou
  `/diaria-develop`: o webhook publica na hora numa comunidade de terceiro e
  não há como apagar pela API. Rodadas autônomas podem mexer no código desta
  skill, nunca executar o envio.
- Os Passos 1 a 5 só leem e gravam arquivos locais do ciclo
  (`data/weekly/{cycle}/`); o dry-run do publicador não chama a rede além do
  agente de tradução de títulos (#11005).

## Passo 1 — Seleção e prévia de partida (dry-run)

```bash
npx tsx scripts/publish-circle-stack.ts --publish-monday {AAMMDD}
```

(com `--reselect` se a skill recebeu a flag). Monta ou reusa
`data/weekly/{cycle}/_internal/circle-stack-selection.json`, traduz títulos em
inglês (o editor revisa na seleção) e grava a prévia. Os avisos (`⚠`) que ele
imprime entram no resumo do Passo 5.

Seleção com título sem sinal de português ainda não revisado (#11161) não
impede esta skill de escrever; só bloqueia o `--publish` lá na frente.

## Passo 2 — Texto próprio (agente `stack-writer`)

```bash
npx tsx scripts/circle-stack-copy.ts --publish-monday {AAMMDD} --manifest > {scratchpad}/stack-manifest-{cycle}.json
```

```
Agent(subagent_type="stack-writer", prompt="Manifest: {scratchpad}/stack-manifest-{cycle}.json")
```

O agente grava `data/weekly/{cycle}/_internal/circle-stack-copy.json` com
`{cycle, opening, notes: [{url, stackNote}]}`. Os itens com `tool` no manifest
vêm das fontes oficiais das ferramentas dos cursos (#10952) e ganham o ângulo
de uso daquela ferramenta.

## Passo 3 — Humanizador e Clarice

Na ordem da diária. `{C}` = o `circle-stack-copy.json`.

1. Humanizador, passe completo, sobre os textos:
   ```
   Skill("humanizador", "Leia {C}, humanize SÓ os campos opening e notes[].stackNote (passe completo), calibrando a voz com data/past-editions-recent.md, e salve no mesmo arquivo sem tocar cycle nem url. Tetos: opening 600 caracteres, cada stackNote 240 caracteres e no máximo 2 frases. Sem markdown, sem URL, sem emoji, sem seta.")
   ```
2. Clarice: `mcp__clarice__correct_text` sobre a abertura e sobre cada
   `stackNote`, uma chamada por vez (serial, #4952). Aplicar as sugestões
   (aceitar as sugestões da Clarice é o padrão do projeto) e regravar `{C}`.
   Clarice indisponível = halt banner (#738), nunca seguir em silêncio.

## Passo 4 — Validar e gravar na seleção

```bash
npx tsx scripts/circle-stack-copy.ts --publish-monday {AAMMDD} --apply
```

Valida o arquivo inteiro contra a seleção (um texto para cada item de lista,
nenhuma URL a mais, mesmo ciclo, tetos, sem markdown/URL/emoji/seta,
"agêntico") e só então grava `opening` e `stackNote` na seleção. `exit 1`
lista os problemas e não aplica nada: corrigir `{C}` (à mão para ajuste
pontual, ou de volta ao Passo 2 com os problemas no prompt do agente) e
rodar de novo. Nunca editar a seleção direto para contornar a validação.

## Passo 5 — Prévia final

```bash
npx tsx scripts/publish-circle-stack.ts --publish-monday {AAMMDD}
```

Re-renderiza com o texto novo (a seleção é reusada). Mostrar ao editor:

- o caminho de `data/weekly/{cycle}/circle-stack-{cycle}.md` e o post inteiro;
- o título que vai ao webhook (`payload.titulo` em
  `_internal/circle-stack-payload.json`; a prévia já usa esse título, #11237);
- os avisos da seleção (títulos traduzidos, link fora das regras, edição
  faltando) e o estado do ciclo na Stack (`draft`/`published`/`unknown`).

Sem `--publish`: terminar aqui, imprimindo o comando de envio
(`npx tsx scripts/publish-circle-stack.ts --publish-monday {AAMMDD} --publish`)
e lembrando que o post sai publicado na hora.

## Passo 6 — Envio (só com `--publish`)

Publicar é irreversível para terceiros (critério 1 de "Perguntar é exceção"),
então a skill para UMA vez: `AskUserQuestion` com a prévia do Passo 5 à mão —
"Publicar agora no Radar de Notícias Stack?" (opções: publicar / não
publicar). `AskUserQuestion` falhando = halt banner (#3938), nunca publicar
sem a resposta. Com o "publicar":

```bash
npx tsx scripts/publish-circle-stack.ts --publish-monday {AAMMDD} --publish
```

O publicador recusa sozinho ciclo já publicado ou ambíguo (só `--force`,
que esta skill nunca passa sem pedido explícito do editor), link não oficial
em Lançamentos/Use melhor e título sem sinal de português não revisado. Erro
dele vai literal ao editor. Depois do envio, conferir o estado com o resolver
determinístico (#573) antes de dizer "publicado":
`_internal/circle-stack-published.json` com `published_at` = confirmado pelo
webhook; sem `published_at` = ambíguo, conferir no Radar.

## Fora de escopo

- Formato do corpo aceito pela Stack e tratamento do `titulo` no n8n (#11237
  item 1): dependem de resposta da Stack.
- Capa por destaque: o webhook não aceita imagem no texto (#11186).
- Publicação automática: segue manual até o editor decidir automatizar.
