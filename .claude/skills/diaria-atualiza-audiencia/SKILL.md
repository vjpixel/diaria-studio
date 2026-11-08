---
name: diaria-atualiza-audiencia
description: Regera `context/audience-profile.md` combinando CTR comportamental com as respostas do formulário do onboarding (formulario.diar.ia.br). Desde a decisão 10 do editor (#10605, 08/11/2026) a survey da Beehiiv foi descartada — o script `scripts/audience-run.ts` lê o formulário sozinho, sem MCP.
---

# /diaria-atualiza-audiencia

Atualiza o perfil de audiência a partir das respostas do formulário do onboarding.

**Fonte única: o formulário do onboarding (#10605, decisão 10 do editor, 08/11/2026).** As respostas da survey antiga da Beehiiv foram descartadas, e o Tally (#466) nunca virou fonte. O perfil passa a sair só do formulário novo (Worker `workers/onboarding-form`, https://formulario.diar.ia.br), que recebe os convites do D+6 da escada, do e-mail único da base e dos lembretes. Por isso esta skill não chama mais nenhum MCP da Beehiiv: as Fases 1 e 2 antigas (`--resolve-only`, `list_surveys`, `list_survey_responses`, `--responses`) saíram.

## Execução

```bash
npx tsx scripts/audience-run.ts            # regenera o perfil
npx tsx scripts/audience-run.ts --dry-run  # lê e conta, não grava nada
```

O script (`scripts/audience-run.ts`, #5192, reescrito no #10605):
- Lê `GET onboarding.followup.form_responses_url` com o token de `ONBOARDING_FORM_TOKEN` (`.env`/Doppler).
- Converte as respostas para o formato de `data/audience-raw.json` (sem e-mail no id; texto livre só como contagem no perfil).
- Grava `data/audience-raw.json` e roda `update-audience.ts` (spawn), que arquiva o profile atual em `docs/audience-history/{YYYY-MM-DD}.md` e gera o novo `context/audience-profile.md`: CTR (seção 1), seções preferidas e nível (seção 2), área de atuação (seção 3) e interesse em produtos (seção 4).
- Imprime o topo do arquivo gerado (stdout) para confirmação.

Fail-closed: formulário não configurado, leitura falhando (token ausente, HTTP de erro, timeout, payload malformado) ou zero respostas abortam com exit 1 e não tocam em `data/audience-raw.json`. Um `audience-raw.json` antigo com a survey da Beehiiv não volta ao perfil: `update-audience.ts` (que também roda no Stage 0 de toda edição) ignora qualquer resposta que não venha do formulário e avisa quantas descartou.

As flags antigas (`--resolve-only`, `--surveys-json`, `--responses`) abortam com exit 1 e a explicação. `scripts/fetch-tally-audience.ts` ainda busca e conta as respostas do Tally (`--dry-run`), mas não regenera mais o perfil.

**Retenção de `docs/audience-history/` (#7129).** Rodar periodicamente (fora deste fluxo, ex: mensal) `npx tsx scripts/prune-audience-history.ts` — consolida snapshots mais antigos que 90 dias em `docs/audience-history/_consolidated.md` (append-only, nunca perde conteúdo) e remove os arquivos individuais correspondentes; snapshots dentro da janela ficam intocados. Política e implementação: `scripts/lib/audience-history-retention.ts`. Standalone de propósito, não wireado no caminho de escrita acima (que roda a cada edição e é business-crítico).

## Exit codes

- `0` — sucesso (ou dry-run).
- `1` — erro duro: formulário não configurado ou ilegível, 0 respostas, flag antiga da Beehiiv, ou `update-audience.ts` falhou.
- `2` — `platform.config.json` ilegível.

## Notas

- Uma resposta por e-mail: o Worker guarda só a mais recente de cada pessoa.
- Pergunta removida de `FORM_QUESTIONS` tem as respostas antigas descartadas (o script avisa quantas).
- Este fluxo é manual/ad-hoc — não está (e não deve entrar, #5192) na registry de tasks agendadas (`scripts/lib/scheduled-tasks.ts`).
