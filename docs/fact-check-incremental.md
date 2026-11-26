# Fact-check incremental por unidade (#14035)

Decisão do editor de 25/11/2026. O passo 1 do §4c.6 da Etapa 4
(`npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/`) imprime
`Escopo do fact-check (#14035): ...` e grava `_internal/fact-check-scope.json`,
comparando o texto e as fontes atuais com o carimbo por unidade do
`fact-check.json` existente. Unidades: `d1`..`d3` = o bloco do destaque na
newsletter + o social do destaque + as fontes dele (URL, status e o texto
baixado de `d{N}.txt` e `d{N}-extra-{k}.txt`); `pool` = o resto da newsletter +
`## um`, com as fontes lidas de `_internal/pool-sources/`. Código:
`scripts/lib/fact-check-units.ts`.

Seguir o que o passo 1 disser:

- `COMPLETO` (1ª passada, `fact-check.json` sem carimbo por unidade, social
  mudou fora de `d{N}`/`um`, conjunto de destaques mudou, partição ambígua, ou
  `--full`): o dispatch do fact-checker sem `units`, e o passo 2 como está. O
  passo 2 carimba com os hashes do PLANO, não do conteúdo depois do agente:
  edição feita no Studio durante a rodada do agente sai DEFASADA e entra no
  próximo re-run.
- `PARCIAL — rechecar dN, ...`: o mesmo dispatch com `units: [...]` (a lista
  impressa) e `out_path: "{EDITION_DIR}/_internal/fact-check.partial.json"`; o
  passo 2 vira `npx tsx scripts/run-fact-checker.ts --edition-dir
  {EDITION_DIR}/ --input-json {EDITION_DIR}/_internal/fact-check.partial.json
  --merge-partial --check-blocking`. O merge descarta todo claim antigo das
  unidades rechecadas e mantém o das demais; carimba com os hashes do plano,
  então texto mexido entre o plano e o merge sai DEFASADO.
- `NENHUMA unidade mudou`: não despachar o fact-checker; rodar só o passo 2
  como está.

O merge parcial é recusado (exit 1) quando o parcial não cobre o plano: o
agente não ecoou `units` igual à lista do plano, algum `d{N}` do plano saiu sem
o claim `headline` (obrigatório por destaque, #9383), ou há claim de unidade
fora do escopo. Também recusa sem plano parcial, sem `fact-check.json` anterior
ou com parcial anterior ao plano. Recusado: `npx tsx scripts/run-fact-checker.ts
--edition-dir {EDITION_DIR}/ --full` e refazer completo.

O `--check-blocking`, o DEFASADO e o exit 2 valem iguais nos três casos,
sempre sobre o conteúdo final. Na dúvida sobre um claim que cruza destaques,
`--full`.

Limitação conhecida: o bloco do destaque também fecha num `---` dentro do
corpo do destaque; o texto depois dele cai no `pool`. Mudança ali recheca o
`pool`, não o destaque.
