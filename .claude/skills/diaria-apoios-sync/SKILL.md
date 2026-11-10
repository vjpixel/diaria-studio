---
name: diaria-apoios-sync
description: Sincroniza o nível de recompensa de apoio (apoia.se) com o custom field `apoio_nivel` no Kit, projeta as tags de audiência e atualiza os caches do painel Apoios. Dry-run por padrão; `--push` grava de verdade. Não precisa de navegador. Uso — `/diaria-apoios-sync [--push] [--allow-partial] [--force-blast-radius]`.
---

# /diaria-apoios-sync

Fecha o loop entre o CRM de Apoios (apoia.se) e o Kit: escreve o nível de
recompensa (Amigo/Apoiador/Mantenedor/Patrono) no custom field `apoio_nivel` de
cada assinante apoiador. Sem argumento de data: roda sobre o estado atual.

Até o #11225 a skill gravava na Beehiiv e corrigia segmentos pelo Chrome. A
Beehiiv virou só arquivo: o script, o drift check e o refresh dos segmentos
saíram. No Kit, a audiência de envio é tag, nunca segmento (ver
`.claude/skills/diaria-mensal-apoiadores/SKILL.md`, "Audiência é TAG").

## Passo 1 — dry-run

```
npx tsx scripts/sync-apoio-nivel-kit.ts
```

Sem `--push`, nada é escrito no Kit. Pode escrever LOCALMENTE
(`contacts.jsonl`, `pending-promises.jsonl`), porque roda antes dois mecanismos
automáticos (#4490): reconsulta entradas do mês com mais de 8h e reconcilia
promessas pendentes, promovendo a contato quem confirmou pagamento. Falha nessa
reconciliação é aviso, exceto chave apoia.se rejeitada, que aborta.

Apresentar ao editor o diff impresso em stderr:
- adições e trocas de nível (`toApply`);
- remoções (`toRemove`), e se estão bloqueadas por dados parciais;
- contatos `sem_dados` pulados (nível desconhecido, nunca "sem apoio");
- apoiadores que não casaram por e-mail exato, com candidatos heurísticos;
- o veredito do guard de blast radius (limiar de 30%).

## Passo 2 — gate de decisão

**Mantido pelo #5321 ("Perguntar é exceção"), critério 1: escreve em massa em
assinantes reais, sem staging reversível equivalente a rascunho.** Perguntar ao
editor se aplica. Opções:
- **Aplicar** → rodar com `--push`.
- **Não aplicar** → pular para o Passo 5, que ainda atualiza o painel; nada foi
  escrito no Kit.
- Guard de blast radius "EXCEDIDO": avisar que ele recusa o `--push` inteiro,
  adições inclusive, e que só `--force-blast-radius` passa. Perguntar se é isso
  mesmo.
- `sem_dados` bloqueando remoções: avisar que `--allow-partial` as força, e que
  sem a flag as adições e trocas são aplicadas e só as remoções ficam pendentes.

```
npx tsx scripts/sync-apoio-nivel-kit.ts --push [--allow-partial] [--force-blast-radius]
```

Nunca rodar `--push` sem o editor ter visto o diff do Passo 1.

## Passo 3 — esperar o nível convergir

A releitura de `--push` confere cada escrita pelo GET singular, mas o endpoint de
lista do Kit serve `fields` defasado por um tempo, e os syncs de tag leem essa
lista. Projetar antes de convergir usa o nível antigo.

Repetir o dry-run do Passo 1 até os e-mails gravados saírem do diff. Enquanto
não saem, não reaplicar: esperar minutos e rodar de novo. Pulado se nada foi
gravado.

## Passo 4 — projetar as tags

As tags de audiência são projeção de `apoio_nivel`. Em dry-run primeiro, com
`--push` depois de mostrar o diff:

```
npx tsx scripts/sync-apoio-mensal-tag-kit.ts [--push]
npx tsx scripts/sync-apoio-especial-tag-kit.ts [--push]
npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts [--push]
npx tsx scripts/sync-apoio-stack-tag-kit.ts [--push]
```

A última é a audiência do e-mail do post semanal da Stack (só Núcleo, #12538).

## Passo 5 — atualizar o painel Apoios

Roda sempre, também no ramo "Não aplicar", e depois da convergência:

```
npx tsx scripts/sync-apoio-segments-kit.ts
```

Só lê do Kit e grava `data/apoia-se/kit-segments.json` e
`data/apoia-se/kit-vinculo.json`. Leitura vazia sai não-zero sem sobrescrever.

## Passo 6 — relatório final

Apresentar ao editor:
- Quantas mutações foram aplicadas e quantas falharam, em cada sync.
- Apoiadores que **não casaram por e-mail exato** (`diff.notSubscribed`, #4490
  causa 3): pagam, mas o e-mail da apoia.se não bate com nenhum assinante ativo.
  **Não é necessariamente "não assina a newsletter"**, pode assinar com outro
  endereço. Cada entrada traz `candidates`
  (`scripts/lib/apoio-email-heuristics.ts`) para confirmação manual; **nunca casar
  um e-mail sozinho** a partir de um candidato.
- Promessas promovidas a contato nesta rodada (#4490 causa 4), se houver.

## Regras invioláveis desta skill

- **Dry-run é o default.** `--push` é sempre explícito, nunca implícito por
  contexto ("roda de novo" não vira `--push`).
- **Carência de 1 mês e guards são do código** (`scripts/lib/apoio-nivel-sync.ts`).
  Esta skill só invoca, apresenta o resultado e faz o gate humano.
- **Nunca usar `--force-blast-radius` ou `--allow-partial` sem confirmação
  explícita do editor.**

## Cadência (#4485 item 2)

Invocação manual. A task `Diaria-Apoios-Diff-Alarm` (systemd,
`scripts/lib/scheduled-tasks.ts`) roda todo dia só o DRY-RUN contra o Kit
(`scripts/apoios-diff-alarm.ts`) e manda e-mail ao editor quando há diff pendente.
Nunca dá `--push`: o gate do Passo 2 é a única forma de gravar.
