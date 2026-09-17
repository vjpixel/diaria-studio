# Setup completo (1x por máquina)

Movido do `CLAUDE.md` na rodada de enxugamento do #8228 — conteúdo de
instalação/troubleshooting não precisa estar no arquivo carregado
incondicionalmente em toda sessão e todo dispatch de subagente. `CLAUDE.md`
§"Como usar" mantém só a lista de passos + este ponteiro.

1. Exportar `CLARICE_API_KEY` no ambiente do shell. **Uma key serve os dois caminhos** da Clarice: o MCP (`.mcp.json` manda no header `X-Clarice-Api-Key`, via `${CLARICE_API_KEY}`) e o REST fallback (`scripts/clarice-correct.ts` → `cortex.clarice.ai`). Pegue a sua em https://cortex.clarice.ai (cada usuário usa a própria — o servidor é passthrough, não tem key compartilhada). No Windows (persistente, requer reabrir o terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "SEU_TOKEN_AQUI", "User")
   ```
   Sem ela o invariant `clarice-key-set` **halta a pipeline no Stage 0**. Veja `.env.example`.
1a. **Node ≥22.18 (recomendado: Node 24, `.nvmrc` do repo — mesma versão do CI).** Dois pisos distintos, o maior manda: `node:sqlite` (`scripts/lib/clarice-db.ts`, usado pelo dashboard Clarice/Brevo e pelo Studio) é builtin a partir do 22.5; o **type-stripping nativo de TypeScript sem flag** só vem no 22.18 (#7106) — e a `statusLine` de `.claude/settings.json` roda `node scripts/overnight-statusline.ts` direto, sem transpiler, então abaixo disso a barra de progresso simplesmente não sobe. Node do sistema/distro costuma vir mais antigo (achado ao vivo #4823: Ubuntu com Node 20.20.2 via `apt` derrubou o Studio server com erro nativo opaco). Use `nvm use`/`fnm use`/`asdf install` antes de `npm install`.
1b. **(Opcional, recomendado) `.env` completo via Doppler em vez de copiar ~40 chaves à mão (#5149).** O vault do projeto (workspace `diar.ia.br`, plano Developer/grátis) já tem todas as secrets do `.env.example` sincronizadas. Instalar o CLI (https://docs.doppler.com/docs/install-cli), `doppler login` (1x por máquina — o `doppler.yaml` versionado neste repo já aponta pro projeto/config certo, sem precisar de `doppler setup` interativo), depois `npm run sync-env` sempre que precisar puxar o snapshot atual. Sem acesso ao workspace: seguir o passo 1 acima + preencher `.env.example` manualmente (fallback que sempre funcionou). Detalhes: `docs/doppler-env-sync.md`.
2. `npm install` no diretório.
2a. `npm run setup-hooks` — instala hook que regenera `context/sources.md` automaticamente ao editar `seed/sources.csv`.
2b. **`data/` mora no OneDrive, não no repo.** A pasta `data/` é uma *directory junction* local apontando para `~/OneDrive/Documentos/diaria-studio-data` (sync entre máquinas, business-sensitive não vai pro GH). Criar 1x por máquina, **antes de rodar qualquer skill** (`data/` não existe num clone fresco — scripts que tentarem escrever ali vão falhar):
   ```powershell
   # Windows + OneDrive PT-BR (default desta máquina):
   New-Item -ItemType Junction -Path "data" -Target "$env:USERPROFILE\OneDrive\Documentos\diaria-studio-data"
   ```
   **Ajustar o target ao OneDrive local** — varia por OS/idioma:
   - Windows EN: `$env:USERPROFILE\OneDrive\Documents\diaria-studio-data`
   - macOS: `ln -s ~/Library/CloudStorage/OneDrive-Personal/Documents/diaria-studio-data data` (ou path equivalente do app instalado)
   - Linux (rclone/onedriver): `ln -s <mount-point>/Documents/diaria-studio-data data`

   A pasta-alvo no OneDrive precisa existir antes (criar manualmente na 1ª máquina; nas demais, o OneDrive já sincronizou). Toda `data/` está em `.gitignore` blanket — nada lá dentro vai pro repo.
3. `npm run sync-sources` para gerar `context/sources.md`.
3a. **Instalar a skill `humanizador`** (repo separado, instalação global — não é vendorada aqui, ver #1676):
   ```bash
   git clone https://github.com/vjpixel/humanizador.git ~/.claude/skills/humanizador
   ```
   **Não é opcional:** o Stage 2 invoca `Skill("humanizador", …)` 2× (newsletter + social) e, por decisão do #1072, ausência/no-op = **abort do Stage 2** após 3 retries — nunca fallback silencioso. `verify-stage-2` também trata `02-humanized.md ≠ 02-normalized.md` como invariante. Confirme com `/humanizador` ou reabrindo o Claude Code.
3b. **Plugin `pr-review-toolkit`** (agentes do review automatizado, #4234). A habilitação já vem versionada em `.claude/settings.json` (`enabledPlugins`), mas os arquivos do plugin vêm do marketplace por máquina — na 1ª sessão de um clone novo, rodar:
   ```
   /plugin install pr-review-toolkit@claude-plugins-official
   /reload-plugins
   ```
   Confirme com `/agents`: `pr-review-toolkit:code-reviewer` deve aparecer. **É opcional de propósito** — sem ele o hook pós-PR e as Fases 1.5 caem no `general-purpose` com rubrico inline (review pior, nunca review nenhum). Diferente do `humanizador` (3a), que aborta o Stage 2 se faltar.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (HTTP, de `.mcp.json` — header-auth via `${CLARICE_API_KEY}`, **não** OAuth), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`). Para o MCP `google-ads` (opcional): requer `pipx` instalado + `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` via Doppler materializada com `npx tsx scripts/materialize-google-ads-credentials.ts` — ver `docs/google-ads-api-setup.md` (#6450).
6. **Inbox editorial** (`diariaeditor@gmail.com`): nenhum setup necessário — o drain busca direto na pasta Enviados da conta pessoal (ver `docs/gmail-inbox-setup.md`). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).
8. **Config do Claude Code entre máquinas (#4804).** `~/.claude` (settings, comandos, agentes, CLAUDE.md global) é sincronizado via repo privado `github.com/vjpixel/claude-config`, não via OneDrive — nova máquina roda `git clone https://github.com/vjpixel/claude-config.git ~/claude-config && ~/claude-config/bootstrap.sh` (`bootstrap.ps1` no Windows). **A propagação é automática desde o #6310** — antes nada puxava, e config commitada valia só na máquina de origem, em silêncio. Conservador por padrão (nunca força, nunca resolve conflito sozinho); estado do último check em `~/claude-config/.sync-state.json`. Ver `docs/claude-config-sync.md` para o mecanismo completo, o que fica de fora de propósito (credenciais) e o estado pendente do rollout. **`memory/` NÃO fica mais de fora** — a política de "nunca commitar" foi revertida em 06/09/2026 (#7533): sincroniza via repo git próprio e privado (distinto do `claude-config`), `MEMORY.md` passa a ser gerado (nunca editado à mão) por `scripts/extract-memory-index.ts`/`scripts/regenerate-memory-index.ts`, e `scripts/memory-sync.ts` faz o auto-commit + `pull --rebase` — ver `docs/claude-config-sync.md` §"Política de `memory/`" para o setup manual 1x do repo remoto.

   **⚠️ Máquina nova no Windows: ligar o Modo Desenvolvedor e RELOGAR ANTES do bootstrap** — o privilégio de symlink só entra no token no próximo logon, e sem ele o bootstrap cai num fallback de cópia que faz o `git pull` atualizar o repo sem o conteúdo nunca chegar a `~/.claude`. A falha é silenciosa: a máquina roda config velha indefinidamente (era o estado do Neo até 06/09). Conferir depois, sem confiar no "sucesso" que o bootstrap imprime — comando e diagnóstico em `docs/claude-config-sync.md`.
