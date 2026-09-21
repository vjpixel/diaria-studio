# Runbook A/B Jev (#8421)

Objetivo: acumular >=5 edições por braço e publicar o relatório no epic #8412.
Braço A = `/diaria-edicao AAMMDD` (sem marcador). Braço B = `/diaria-edicao-jev AAMMDD`
(grava `_internal/.jev-profile.json`, Jev decide com `DIARIA_JEV_PROFILE=all`).
Ambos terminam no fim do Stage 4; Stage 5/6 em sessão nova (`/diaria-5-publicacao`).

## Regras para o dado valer

- Retomar edição B sempre com `/diaria-edicao-jev` (retomar com a skill comum invalida o perfil).
- Marcador ausente = braço A; marcador corrompido, edição inexistente ou sem métrica = excluída (com aviso).
- Métricas: correções do editor no gate 4 (`_internal/editor-requests.jsonl`, gerado por
  `derive-editor-requests.ts` no gate; sem ele o relatório marca a edição como indisponível nessa métrica),
  espera de gate, tokens (`capture-stage-usage.ts`, `_internal/stage-status.json`) e wall-clock do Stage 1.
- Artefato do dedup: `_internal/dedup-grayzone-jev.json` (deve registrar `profile_env=all` no braço B).
- `/clear` entre stages, como de costume, para os tokens ficarem isolados por stage.

## Gerar o relatório (somente leitura)

```
npx tsx scripts/jev-ab-report.ts --editions 260921,260922,260923,260924,260925,260928,260929,260930,261001,261002
npx tsx scripts/jev-ab-report.ts --editions ... --json   # consumo programático
```

Sai com código 1 se não há nenhuma métrica utilizável. O último aviso da saída informa se a
amostra já atinge o critério (>=5 edições com dado por braço).

Estado em 20/09/2026 (dry-run sobre 260901..260918): A=12 edições com dado, B=0. Várias edições
antigas não têm `editor-requests.jsonl` nem `duration_ms`; para o braço A prefira as edições novas
do calendário (mesmas condições do B, controle concorrente).

## Publicar no epic #8412

```
npx tsx scripts/jev-ab-report.ts --editions <lista> > relatorio.md
gh issue comment 8412 --body-file relatorio.md
```

Depois comentar em #8421 com o link e, cumprido o critério (uma edição inteira B + >=5/braço),
fechar a issue e decidir se o perfil Jev vira default de `/diaria-edicao`.

## Calendário proposto (alternando, dias úteis)

| Edição | Braço | Comando |
|---|---|---|
| 260921 | A | `/diaria-edicao` (já em curso) |
| 260922 | B | `/diaria-edicao-jev` |
| 260923 | A | `/diaria-edicao` |
| 260924 | B | `/diaria-edicao-jev` |
| 260925 | A | `/diaria-edicao` |
| 260928 | B | `/diaria-edicao-jev` |
| 260929 | A | `/diaria-edicao` |
| 260930 | B | `/diaria-edicao-jev` |
| 261001 | A | `/diaria-edicao` |
| 261002 | B | `/diaria-edicao-jev` |

Resultado: 5 A + 5 B em duas semanas; relatório após o gate 4 de 261002. Ajuste por feriados
mantendo a alternância.
