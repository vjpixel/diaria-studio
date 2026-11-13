# Publica-video: diagnóstico e fluxo híbrido (#12622)

Levantamento em 10/11/2026, a partir do corpo e comentário OWNER da issue via REST API. As filhas entregaram os guards: #12654 (autorização vinculada ao hash do plano) e #12655 (execução híbrida, telemetria por fase, isolamento de custo e o refresh do A4). A execução vigente está na seção "Fluxo híbrido" de `.claude/skills/diaria-publica/SKILL.md`; o que foi implementado e as premissas estão em "Implementação (#12655)" no fim deste documento.

## Medição disponível

Últimas quatro edições com Stage 5 e 6 concluídos no checkout: 261104, 261105, 261106 e 261110. 261111 ainda está no Stage 4 e foi excluída. Fonte: `data/editions/2611/{edição}/_internal/stage-status.json`, campos `start`, `end`, `duration_ms`, `gate_at`, `pipeline_ms`. Tempos arredondados ao segundo; inclui espera e retrabalho.

| Edição | Stage 5 | Stage 6 | Stage 6 até gate | Gate até fim Stage 6 |
|---|---:|---:|---:|---:|
| 261104 | 10m54s | 6m58s | 14s | 6m45s |
| 261105 | 11m12s | 14m27s | 19s | 14m08s |
| 261106 | 9m19s | 35m21s | 1m56s | 33m25s |
| 261110 | 3h22m23s | 9m43s | 21s | 9m23s |

O intervalo após o gate inclui revisão humana, execução e fechamento: **não é medida pura de espera do editor**. Medianas: Stage 5 11m03s, Stage 6 12m05s. O outlier 261110 não deve virar estimativa de execução normal nem promessa de economia.

Reprodução somente leitura, sem recapturar custo nem modificar dados:

```python
import json
from pathlib import Path
from datetime import datetime
for edition in ["261104", "261105", "261106", "261110"]:
    doc = json.loads(Path(f"data/editions/2611/{edition}/_internal/stage-status.json").read_text())
    for row in doc["rows"]:
        if row["stage"] in [5, 6]:
            print(edition, row["stage"], row["start"], row["end"], row["duration_ms"])
            if row.get("gate_at"):
                dt = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))
                print("até gate / após gate (s)", row.get("pipeline_ms", 0) / 1000,
                      (dt(row["end"]) - dt(row["gate_at"])).total_seconds())
```

`capture-stage-usage.ts` captura tokens/custo na janela start/end; não cronometra upload, Codex ou espera por si só. Os quatro registros usam `session_filter: current_session` nos Stages 5/6. 261106 tem `parse_errors: 5`: a duração de relógio permanece disponível, mas isso limita a confiança da captura de uso.

Inspeção complementar do `data/run-log.jsonl`: 3 linhas não JSON, ignoradas explicitamente na leitura; não há pares completos início/fim para capa/Codex, upload e espera nas quatro edições. Na 261106 há início de Stage 5 às 02:59:33.589Z e Stage 6 às 03:09:40.475Z, consent-off para YouTube (sem vídeo), e Schedule às 03:43:58.164Z. Ela é baseline das etapas, não do vídeo. Na 261110 o registro horizontal tem uploadedAt 06:03:22.909Z e rereadAt 06:03:31.806Z (8,897s entre esses eventos, não duração do upload); o Stage 5 começou às 02:55:10.467Z, antes desse registro, e o primeiro registro vertical é 06:35:11.036Z, depois do Stage 6. Não atribuir as 3h22 só a upload/capa ou ao código atual: a rodada cruza a mudança #12591. Registros de destino dos timers, horas depois, também não medem a duração da sessão.

**Resultado por fase:** Stage 5/6 medidos acima; download, dry-run, capa/Codex, espera humana, duração integral de upload e vertical guiado indisponíveis separadamente. Não subtrair timestamps de publicações para inventar esses tempos. #12655 inclui a instrumentação necessária para comparar o caminho crítico antes/depois.

## Dependências verificadas no código

- Social da Etapa 5 também depende do link: `publish-facebook.ts` e `publish-threads.ts` leem `readD1VideoUrlForPosts`; o playbook de `/diaria-5-publicacao` Passo 0b documenta também X. O gate `check-video-before-publish.ts` vale para **todos os escopos**, inclusive social. Não antecipar dispatch social nem Brevo. Preparar arquivos localmente é distinto de agendar posts.
- Horizontal: A1 e A2 produzem os insumos da confirmação. Capa do Drive/local dispensa geração quando previsto. Não perguntar aprovação de capa inexistente.
- Vertical: B1/B2 e preparação da capa podem começar cedo. `publish-shorts.ts` usa o título do registro horizontal ou o D1 como fallback (#12191). Fixar previamente o título aprovado; se o upload/fallback mudar metadados do vertical, o plano mudou e exige nova aprovação. Respeitar também vídeo relacionado e horários de #10831; não supor independência total A/B.
- Stage 6 depende do rascunho Kit e do teste. Escolher horário antecipadamente não aprova um e-mail ainda inexistente. Conservar a olhada no teste **antes** do Schedule (#8205); não introduzir um novo modo no-gates nem revisão após agendar.
- A3 já relê estado via API e grava o link mesmo com aviso de possível indisponibilidade (#12598), exceto falha/rejeição/deleção. A4 é fallback para link externo: `link-video-d1.ts` hoje lê registro local e aplica `gateVideoLink`, sem refrescar status remotamente. API oficial autenticada pode substituir a pergunta quando comprovar estado; sem credencial, timeout, privado ou resultado inconclusivo, manter o fallback humano. Pergunta preventiva não comprova estado futuro, e nunca autoriza `--assume-public` automaticamente.

## Fluxo proposto após as filhas

```mermaid
flowchart TD
    G[Stage 4 aprovado; sessão nova] --> P[Background: fetch A/B, planos, capas, preflight local]
    G --> Q[Primeiro plano: decisões abertas sem insumos]
    P --> C[Bateria única: capa/gancho e pode publicar A e B]
    Q --> C
    C --> H[Upload horizontal autorizado]
    H --> L[Link D1; guard obrigatório]
    L --> S[Etapa 5: newsletter e social]
    S --> T[Stage 6: teste disponível]
    T --> E[Olhada no teste; Schedule]
    L --> V[Vertical autorizado; owners e horários próprios]
    V --> J[Join e relato com pendências]
    E --> J
```

1. Iniciar tarefas reversíveis com `run_in_background`/worker **antes** de AskUserQuestion, que bloqueia o turno. Sem worker disponível, fazer preparação serial e declarar a limitação, sem fingir concorrência. Não executar publicação nem criar timers nesta fase.
2. Enquanto preparam, coletar apenas decisões realmente abertas sem insumos: horário excepcional do Schedule, overrides de plano. Reusar `--skip` e defaults existentes (#5321); não ressuscitar um menu obrigatório por canal. A resposta pode invalidar um dry-run já iniciado: regenerá-lo antes de mostrar.
3. Quando planos e capa estiverem prontos, mostrar uma bateria com escolhas independentes: capa/gancho e confirmação explícita de A e de B. Recusa de B não aprova B por associação com A. Confirmar capa nova muda o plano: congelar os bytes finais antes de autorizar upload. Silêncio não vale.
4. Executar A → link → guard → Stage 5/6, com B em paralelo a Stage 5/6 depois das dependências de metadados. A aprovação de B permanece válida só pelo protocolo da #12654. Mudança de plano ou interrupção exige revalidação e nova confirmação conforme #11741.
5. Única parada residual prevista no caminho normal: olhar o teste e autorizar Schedule. Falhas reais, ambiguidades de Drive ou guiados sem Chrome podem exigir intervenção adicional; a bateria inicial não elimina esses bloqueios. Chrome tem um único dono por vez (capa Shorts, Instagram e demais guiados); APIs e preparação local continuam em paralelo. Não oferecer a mesma conta/destino a dois owners.

## Guards e medição necessários

#12654 implementa manifesto canônico e SHA-256 junto da confirmação: edição/parte, hashes dos bytes de vídeo/capa/SRT, título/descrição, destinos, horários/fuso e owners/comandos. Publisher recalcula antes de efeito externo; diff exige nova confirmação. Timestamp volátil de dry-run pode ser excluído, conteúdo editorial não. Interrupção/rejeição continua invalidando autorização, consultando `video-publish-registry-status.ts` antes de retry; nenhum hash recupera um consentimento rejeitado. Até isso existir, não ampliar a validade da confirmação na skill.

#12655 implementa execução híbrida, refresh determinístico de A4 e eventos por fase com edição, tentativa, session/task-id, parte/stage, início/fim/erro e hash. Separar tempo ativo de espera (pergunta/resposta), upload de processamento e guiado de API. Ausência de evento é indisponível, não zero. Comparar caminho crítico por união dos intervalos, não soma de tarefas sobrepostas.

**Janelas de custo sobrepostas hoje contaminariam a atribuição:** `capture-stage-usage.ts` filtra por sessão e tempo; o vertical dentro da mesma sessão/janela de Stage 5/6 seria contado ali. Isolar transcript/sessão dos workers e provar a atribuição em fixtures antes de ativar paralelo; não usar `--all-sessions` para contornar. Custos das partes de vídeo ficam separados, sem inventar stage 7 (o capturador só rastreia 0–6). Stage 5/6 preservam start/end e `.step-5-done.json`/`.step-6-done.json`; nenhum sentinel é emitido por antecipação, e o join relata B pendente mesmo com 5/6 concluídos.

As filhas devem testar plano alterado/edição errada/sem confirmação, interrupção com processo sobrevivente, retomada com somente Stage 5 concluído, ausência de link em qualquer escopo, API inconclusiva, conflito de owners/Chrome e atribuição de custo em sobreposição. Sem publicação real ou gastos nos testes. #12588, #11741, #5578/#6171 e os sentinels permanecem invariantes. Aliases e `--so`/`--sem-publicacao` conservam seus limites.

## Implementação (#12655)

- **Telemetria por fase:** `scripts/publica-phase.ts` (lógica pura em `scripts/lib/diaria/publica-phases.ts`) grava `start`/`end`/`error`/`interrupted` em `_internal/publica-phases.jsonl` e no run-log, com edição, fase, parte, stage, tentativa, `session_id`, `task_id`, PID/máquina do processo e `plan_sha256`. O `report` dá a duração por fase (`null` quando falta o par início/fim, nunca zero), o caminho crítico pela união dos intervalos, a soma ingênua só para contraste, e a execução separada da espera do editor.
- **Travas de início:** dono único do Chrome e um escritor por registro; fase do vídeo no thread principal recusada com a Etapa 5/6 rodando, e a Etapa 5/6 recusada com fase do vídeo aberta no thread principal; retry de `upload`, `vertical-api` ou `vertical-guiado` depois de erro, interrupção ou órfã só depois de uma releitura do registro gravada depois do fim da tentativa e cobrindo o início dela; linha ilegível no JSONL recusa fase externa ou que segura recurso (a linha perdida pode ser o `start` de uma tentativa interrompida); tarefa aberta por `start` manual não tem PID e nunca vira órfã (fechar com `interrupted` à mão); tarefa do `run` aberta em outra máquina (o PID de lá não se confere daqui) vira órfã quando o último evento dela passa de 3 h (`CROSS_HOST_STALE_MS`, #12883), e até lá a recusa diz quando ela expira; 1ª pergunta bloqueante só depois de algum preparo em background, ou com a limitação declarada (`--serial-reason`).
- **Retomada de upload registrado (#12883):** com o vídeo já em `05-youtube-published.json`, o `publish-youtube.ts --upload` sem `--force` só refaz podcast, legenda e playlists. Esse caminho passa pelo wrapper com `run --phase upload --part horizontal --resume-existing`, que dispensa a autorização ativa e a regra de retry do #11741 e recusa sem registro `done` (ausente, ilegível, de outra edição ou marcador de estado incerto) ou com `--force` no comando.
- **Gate de efeito externo** (`scripts/lib/diaria/publica-effect-gate.ts`): upload e vertical só com autorização ativa, desta máquina, do plano em disco agora (plano alterado invalida; consumida ou invalidada não serve); os guiados do vertical, com uma aprovação não invalidada do plano atual (não confere se o `--publish` rodou); Etapa 5 e Schedule com o pré-requisito do #12588 em todos os escopos até o sentinel da Etapa 5 (depois dele o `check-video-before-publish` não bloqueia). O `link` passa pelo gate: quem decide é o `link-video-d1.ts`. Reforça, não substitui, a conferência por destino que os publishers fazem antes do 1º efeito.
- **Join:** nenhuma sessão concluída com fase pendente (inclusive em background), órfã ou sentinel antecipado; a parte de vídeo pendente aparece mesmo com as Etapas 5/6 concluídas. Os sentinels `.step-5-done.json`/`.step-6-done.json` seguem com os playbooks de sempre.
- **Isolamento de custo:** o vertical em paralelo roda como processo em background (sem transcript de LLM). O `capture-stage-usage.ts` das Etapas 5/6 tira da janela os intervalos em que o thread principal da mesma sessão trabalhou no vídeo (`excludeIntervals` em `collectUsageInWindow`, campo `excluded_other_parts`, com `parse_problems` quando o JSONL tem linha ilegível; tarefa sem fim gravado conta só até o próximo `start` do thread principal), testado com transcript de fixture sobreposto à janela. Limite: o turno que emite o `start` precede o evento, e a resposta à notificação do background cai na janela; as duas fatias são pequenas e ficam no stage.
- **A4:** `scripts/lib/diaria/youtube-link-refresh.ts`, chamado pelo `link-video-d1.ts`, relê `videos.list?part=snippet,status` e atualiza o registro só com id e canal conferidos; falha de API nunca vira público; `failed`/`rejected`/`deleted` é terminal e fica gravado no registro (`terminal_upload_status`), recusado pelo `gateVideoLink` também numa execução seguinte inconclusiva ou com `--no-refresh-status`; com o `05-video-url.txt` desse vídeo já gravado, o `check-video-before-publish` devolve `video-terminal` e bloqueia a Etapa 5 e o Schedule, inclusive depois do sentinel da Etapa 5 e com `--skip youtube` (#12965); `--assume-public` continua só depois da confirmação humana atual.

**Premissas registradas:** a aprovação do vertical não entra na bateria do horizontal: o plano do vertical inclui o link do horizontal (hash do #12654), que só existe depois do upload. A pergunta de B vem logo depois do link, antes da Etapa 5, e o `--publish` por API roda em paralelo às Etapas 5/6; os passos guiados (Chrome, Buffer) ficam para depois do Stage 6, serializados. A medição antes/depois depende de uma rodada real com as fases completas (follow-up), sem promessa de ganho antes disso.
