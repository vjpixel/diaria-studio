# Regeneração automática das páginas de entidade (`especial.diar.ia.br/entidades/`)

Issue: [#5125](https://github.com/vjpixel/diaria-studio/issues/5125) — condição inegociável do editor pra publicar a 1ª página de entidade fora da rodada original de 3 (Apple, 15/08/2026): "a página nasce com regeneração automática — senão vira mais um artefato que degrada sozinho, é literalmente o que já acontece com os hubs" (ver #5123, #5124).

`scripts/regenerate-entity-pages.ts` faz as **duas metades** dessa condição para toda entidade em `ENTITY_LOADERS` (`scripts/build-entity-page.ts`):

## Parte 1 — regen mecânica do HTML (sempre roda, sem depender do corpus)

Para cada entidade, re-renderiza o HTML (`renderEntityPage`) a partir do módulo `scripts/lib/entities/{slug}.ts` já commitado e sobrescreve `workers/artigos/public/entidades/{slug}/index.html` **se divergir** do que já está em disco (ex: `entity-page.ts`/`curadoria-page.ts`/design tokens mudaram e ninguém rodou `build-entity-page.ts --all` à mão depois). Determinístico, sem risco editorial — quando nada mudou é puro no-op (mesma garantia que `test/build-entity-page.test.ts` já valida em CI, agora também auto-corrigida fora do caminho de PR).

## Parte 2 — detecção com aging da defasagem de CONTEÚDO

Escrever uma `EntityMention` nova exige ler `content.free.web` da edição inteira e sintetizar 1-3 frases próprias (critério anti-thin-content, ver `scripts/lib/shared/entity-page.ts`) — julgamento editorial, não mecânico. Auto-commitar prosa sintetizada sem revisão tem o mesmo blast radius que `hub-staleness-check.ts` (#5123) já identificou pro problema irmão dos hubs, e a mesma decisão do editor se aplica aqui: **só alarmar, nunca auto-escrever nem auto-commitar `mentions`**.

Mecanismo, espelhando `hub-staleness-check.ts` (#5123, já em produção) função por função:

1. **Detecção** (`findStaleEntityMentions`, `scripts/lib/entity-staleness-check.ts`) — roda `collectHubSources` (mesmo mecanismo de match de `HUB_KEYWORD_PATTERNS`/`generate-hub-sources.ts`) contra `ENTITY_KEYWORD_PATTERNS[slug]` (`scripts/lib/entities/patterns.ts`) e devolve edições confirmadas que casam o padrão mas cujo `editionSlug` não está nem em `mentions` nem em `ENTITY_EXCLUDED_EDITIONS[slug]` (exclusões editoriais já registradas — ex: 3 dos 10 matches de Apple foram lidos e descartados de propósito, redundantes com outra menção já incluída).
2. **Aging** (`computeFirstSeenMap`/`computeAgedStale`) — a data de 1ª detecção é persistida entre execuções (`data/entities/staleness-state.json`); uma edição detectada hoje não alarma imediatamente.
3. **Limiar** (`filterOverdue`, default 3 dias, mesmo default de `hub-staleness-check.ts`) — só entradas com `ageDays >= threshold` justificam e-mail.
4. **Alarme idempotente** (`shouldAlarmEntityStaleness`/fingerprint) — mesmo conjunto ainda não resolvido não reenvia todo dia; conjunto mudando (nova entrada cruzou o limiar, ou uma foi corrigida) alarma de novo.

Snapshot diário sempre escrito em `data/entities/staleness-{YYYY-MM-DD}.json` (confirma que a task de fato rodou, mesmo sem pendência).

## Uso

```bash
npx tsx scripts/regenerate-entity-pages.ts               # roda as 2 partes, alarma se vencido
npx tsx scripts/regenerate-entity-pages.ts --dry-run       # avalia + imprime, não escreve/persiste/alarma
npx tsx scripts/regenerate-entity-pages.ts --threshold-days 5
npx tsx scripts/regenerate-entity-pages.ts --to email@x
```

## Fail-soft (#2643, label `local`)

A Parte 1 (regen mecânica) só depende de código já commitado — roda mesmo em sessão cloud/clone fresco. A Parte 2 precisa do junction `data/` (`data/beehiiv-cache/posts`, populado por `beehiiv-sync.ts`) — se ausente, é pulada com aviso em stderr e exit 0 (nunca bloqueia a Parte 1). `data/.credentials.json` com o scope `gmail.send` só é necessário quando há pendência vencida pra de fato alarmar.

## O que fazer quando o alarme dispara

1. Ler `content.free.web` da(s) edição(ões) listada(s) no e-mail (`data/beehiiv-cache/posts/`).
2. Se a menção é substantiva: editar `scripts/lib/entities/{slug}.ts`, adicionar a `EntityMention` (síntese própria, nunca paráfrase da manchete — ver critério anti-thin-content), e rodar `npx tsx scripts/build-entity-page.ts --entity {slug}` (ou deixar a próxima execução diária desta task regenerar o HTML sozinha, uma vez commitado).
3. Se a menção foi vista e descartada de propósito (redundante, sem desenvolvimento próprio no corpo): adicionar o `editionSlug` a `ENTITY_EXCLUDED_EDITIONS[slug]` (`scripts/lib/entities/patterns.ts`) com uma nota curta do motivo — sem isso, o alarme repete pra sempre pela mesma edição já revisada.

## Setup (ação local one-time do editor — feito em 17/08/2026, ver abaixo)

Requer Linux/systemd + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme; a Parte 1 (regen mecânica) não depende de nenhuma credencial.

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Entity-Pages-Regen   # gera os units em .systemd-units/
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Entity-Pages-Regen     # copia + daemon-reload + enable --now
```

Os dois passos são separados de propósito (#4805 Fase 3 / #4807): o gerador nunca chama `systemctl`, garantia travada por `test/systemd-units.test.ts`. `arm-systemd-timers.ts` (#4828) é o único lugar que arma — preferir a ele sobre `cp` + `systemctl` à mão.

Isso registra a task `Diaria-Entity-Pages-Regen` (diária, 09:40 — entre `Diaria-Home-Meta-Check` 09:35 e `Diaria-Apoios-Diff-Alarm` 09:45, sem colisão com nenhuma outra daily do registro). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-entity-pages-regen.timer`.

**ARMADA em 17/08/2026** na checkout compartilhada (`/home/vjpixel/diaria-studio`, Linux/systemd): units copiados de `.systemd-units/` pra `~/.config/systemd/user/`, `daemon-reload` + `enable --now`. `systemctl --user list-timers` confirma `diaria-entity-pages-regen.timer` com próximo disparo em 18/08 09:40 BRT (sem catch-up imediato — nenhuma ocorrência devida no carimbo). Validação ao vivo no mesmo dia: `--dry-run` devolveu `nada divergiu (no-op)` e `0 entrada(s) stale, 0 vencida(s)`. *(Antes disso, a task tinha sido gerada em worktree isolado e nunca armada — mesma disciplina do #4320/#4382/#4490/#4534/#4723/#5123.)* A Parte 1 (regen mecânica) **foi validada ao vivo** nesta unidade (`npx tsx scripts/regenerate-entity-pages.ts --dry-run` e sem `--dry-run`, rodando contra o `data/` real via junction OneDrive — confirmou `nada divergiu (no-op)` para as 5 entidades já publicadas, incluindo a Apple recém-gerada, e `0 entrada(s) stale`); a Parte 2 (alarme) só via testes da lógica pura (`test/entity-staleness-check.test.ts`, `test/regenerate-entity-pages-script.test.ts`), sem rede/Gmail real.
