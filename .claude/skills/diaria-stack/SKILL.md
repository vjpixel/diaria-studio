---
name: diaria-stack
description: Escreve o texto PRÓPRIO do post semanal do Radar de Notícias Stack (comunidade Circle da Stack, #11184) — abertura e descrição de cada item de Lançamentos, Use melhor e Radar, no ângulo de quem constrói com Lovable, Cursor, Claude Code, n8n e Replit, partindo da seleção da semana e das fontes oficiais dessas ferramentas (#10952). Agente `stack-writer` + humanizador + Clarice + validação mecânica, gravado na seleção que `scripts/publish-circle-stack.ts` publica. Termina APROVANDO o ciclo, com confirmação do editor, para o envio automático de segunda 06:00 BRT (task `Diaria-Circle-Stack-Weekly-Publish`, #11778); `--publish` envia na hora (o post sai PUBLICADO, sem rascunho), também só depois da confirmação do editor sobre a prévia. Uso — `/diaria-stack [AAMMDD-da-segunda] [--publish] [--reselect]`.
disable-model-invocation: true
---

# /diaria-stack

Post semanal da diar.ia.br no espaço "Radar de Notícias Stack" da comunidade
Circle da Stack (`plataforma.stack.com.br/c/radar-de-noticias-stack`). O
transporte já existe (#10904): `scripts/publish-circle-stack.ts` monta a
seleção da semana a partir das edições diárias, renderiza a prévia e, só com
`--publish`, envia ao webhook n8n da Stack. A task de sábado 09:25 BRT
`Diaria-Circle-Stack-Weekly-Preview` (servidor `300`) roda esse publicador em
dry-run para a próxima segunda e abre uma issue `bloqueio-execucao` avisando
que a prévia está pronta. A task de segunda 06:00 BRT
`Diaria-Circle-Stack-Weekly-Publish` (#11778) envia o ciclo, mas só se ele foi
aprovado nesta skill (Passo 6), e manda e-mail ao editor com o resultado em
todos os casos.

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
  conteúdo é a de segunda a sexta anteriores). Omitido: resolver com
  `npx tsx scripts/publish-circle-stack.ts --resolve-skill-default-monday`
  (só lê o state local, não grava nada) e usar o `publishMonday` do JSON. A
  regra parte da segunda de hoje ou da anterior, como o publicador (de
  segunda a quinta); de sexta a domingo assume sempre a segunda seguinte,
  publicado ou não o ciclo anterior (#11784, #11868): a task de segunda só
  envia o ciclo da própria segunda, então aprovar a segunda vencida não
  serviria para nada. Envio atrasado do ciclo anterior só com `AAMMDD`
  explícito e `--publish`. Imprimir o `banner` do JSON, que diz por que
  pulou. Nunca parar para confirmar a data. Como a skill
  roda no fim de semana, antes do envio de segunda 06:00 (#11778), o caso
  normal é cair na próxima segunda (a semana anterior já saiu pela task); na
  própria segunda antes do envio, cai na data de hoje. O publicador, chamado
  sem `--publish-monday`, segue com a regra antiga: o catch-up do timer
  depende dela.
- `--publish` — depois da prévia e da confirmação do editor (Passo 7), envia
  o post NA HORA. Sem a flag, a skill termina na aprovação do Passo 6 e o
  envio fica para a task de segunda 06:00.
- `--reselect` — refaz a seleção da semana do zero (repassado ao Passo 1).
  Apaga os ajustes manuais da seleção anterior, inclusive o texto desta skill.

## Guard de execução

- **Nunca** rodar o Passo 7 sem `--publish` passado pelo editor NESTA
  invocação, e nunca rodar o Passo 6 nem o 7 dentro de `/diaria-overnight`,
  `/diaria-continuo` ou `/diaria-develop`: o webhook publica na hora numa
  comunidade de terceiro e não há como apagar pela API, e a aprovação do
  Passo 6 autoriza esse envio na segunda. Rodadas autônomas podem mexer no
  código desta skill, nunca aprovar nem executar o envio.
- Os Passos 1 a 4 só leem e gravam arquivos locais do ciclo
  (`data/weekly/{cycle}/`); o dry-run do publicador não chama a rede além do
  agente de tradução de títulos (#11005). O Passo 5 publica um Artifact, que é
  rede: só a sessão top-level tem a ferramenta, e rodada autônoma sem ela segue
  o fallback do Passo 5. O Artifact nunca envia nada à Stack.

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
   Skill("humanizador", "Leia {C}, humanize SÓ os campos opening e notes[].stackNote (passe completo), calibrando a voz com data/past-editions-recent.md, e salve no mesmo arquivo sem tocar cycle nem url. Tetos: opening curta, alvo ~200 e no máximo 280 caracteres, uma ideia por frase e sem aposto longo; cada stackNote 240 caracteres e no máximo 2 frases. Sem markdown, sem URL, sem emoji, sem seta.")
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

## Passo 5 — Prévia final em Artifact (#11769)

```bash
npx tsx scripts/publish-circle-stack.ts --publish-monday {AAMMDD}
```

Re-renderiza com o texto novo (a seleção é reusada). A prévia vai SEMPRE para
um Artifact, com ou sem `--publish`; o chat leva só o link e um resumo de
uma linha (título e estado do ciclo), nunca o post inteiro.

1. **HTML** em `data/weekly/{cycle}/_internal/circle-stack-preview.html`
   (arquivo local, regravado a cada rodada), página estática com o conteúdo
   de `circle-stack-{cycle}.md` e dos arquivos do ciclo, sem texto novo:
   - o post inteiro, com os links, e o texto escrito para a Stack (abertura e
     `stackNote`) em destaque visual;
   - o título que vai ao webhook (`payload.titulo` em
     `_internal/circle-stack-payload.json`; a prévia já usa esse título, #11237)
     e o estado do ciclo na Stack (`draft`/`published`/`unknown`);
   - os avisos da seleção: títulos traduzidos com o original ao lado
     (`titleOriginal`), título sem sinal de português não revisado (bloqueia o
     `--publish`), link fora das regras, edição faltando;
   - o comando de envio e o aviso de que `--publish` publica o post NA HORA, sem
     rascunho.
2. **Publicar**, na ordem: ler `data/weekly/{cycle}/_internal/circle-stack-artifact.txt`
   ANTES de criar qualquer coisa (é o que vale em sessão nova ou rerrodada).
   Com URL gravada e não vazia, atualizar esse artefato:
   `Artifact(file_path: "{caminho absoluto do HTML}", title: "Stack {cycle}", description: "Prévia do post semanal da Stack", favicon: "📰")`
   apontando para o mesmo artefato. Sem arquivo, com URL vazia, ou se a
   atualização falhar (artefato apagado ou inacessível), criar um novo e
   sobrescrever o `.txt` com a URL retornada. Nunca deixar dois artefatos
   vivos para o mesmo ciclo quando o primeiro ainda atualiza.
3. **Fallback:** `Artifact` indisponível ou falhando (inclusive em sessão sem a
   ferramenta) é warning-only: avisar o editor, mostrar a prévia no chat (caminho
   do `.md` e o post inteiro) e seguir para o Passo 6 (ou 7). A confirmação continua
   sendo do editor, nunca é pulada.
4. Apresentar o link do artefato ao editor ANTES do Passo 6 e do Passo 7.
   Rodar a skill sem `--publish` termina, depois do Passo 6, com esse link.

## Passo 6 — Aprovação para o envio de segunda 06:00 (#11778)

A aprovação autoriza um envio irreversível para terceiros (critério 1 de
"Perguntar é exceção"), então a skill para UMA vez: `AskUserQuestion` com a
prévia do Passo 5 à mão — "Aprovar o ciclo {cycle} para o envio automático de
segunda {AAMMDD} às 06:00?" (opções: aprovar / não aprovar). Com `--publish`,
pular este passo e ir ao Passo 7. `AskUserQuestion` falhando = halt banner
(#3938), nunca aprovar sem a resposta. Com o "aprovar":

```bash
npx tsx scripts/publish-circle-stack-scheduled.ts --approve --publish-monday {AAMMDD}
```

Grava `data/weekly/{cycle}/_internal/circle-stack-approval.json` com o sha256
da seleção atual. Recusa seleção com link fora das regras do canal ou título
sem sinal de português não revisado, ciclo já publicado e segunda que já
passou (#11868: a task nunca a enviaria). Editar a seleção
depois da aprovação a invalida (a task não envia e manda "Não enviado"):
aprovar de novo. Desfazer: `--revoke --publish-monday {AAMMDD}`.

Na segunda às 06:00 a task envia e manda e-mail ao editor com o resultado:
Publicado, Ambíguo (conferir no Radar), Falhou (erro literal) ou Não enviado
(sem aprovação, fora da segunda ou trava da seleção). Ela nunca repete o envio
nem usa `--force`.

## Passo 7 — Envio na hora (só com `--publish`)

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
- Publicação sem aprovação do editor: a task de segunda só envia ciclo aprovado (#11778).
