<#
.SYNOPSIS
    Molde compartilhado dos wrappers run-*.ps1 do Task Scheduler (#4756).

.DESCRIPTION
    10 wrappers run-*.ps1 (scripts/run-cursos-kv-sync.ps1 e outros) repetiam
    o mesmo molde de ~90 linhas: guard de $LASTEXITCODE=$null pre-chamada
    nativa (#4343 -- sob Set-StrictMode, npx falhando a resolver deixa
    $LASTEXITCODE genuinamente indefinido, nao $null, e ler essa variavel
    lanca), log temporario FORA de data/ pra escapar do lock do OneDrive
    (#4047), retry com backoff no append final, e exit code honesto que
    reprova a run quando so o log falhou.

    Um fix (caso de teste "script falha -> wrapper propaga exit 1", achado
    do review #4552) foi aplicado em 2 wrappers mas nunca chegou a um 3o,
    porque nao havia modulo compartilhado pra propagar o fix uma vez. Este
    modulo fecha esse gap -- corrigir aqui corrige todo wrapper que o usa.

    GOTCHA de escopo (verificado empiricamente antes de escrever este
    modulo, nao por suposicao): dentro de uma FUNCAO, um `$LASTEXITCODE =
    $null` sem qualificador de escopo cria uma copia LOCAL que sombra a
    variavel de verdade -- o comando nativo em seguida atualiza o
    $LASTEXITCODE global de fato, mas ler `$LASTEXITCODE` (sem qualificador)
    depois, ainda dentro da funcao, devolve a copia local (ainda $null),
    nunca o codigo real. Isso e diferente do comportamento em script solto
    (script scope == unico escopo em jogo), onde o padrao original
    funcionava. Por isso esta funcao usa `$global:LASTEXITCODE`
    explicitamente nos dois lados (pre-init e leitura) -- nao
    `$LASTEXITCODE` puro.

    O CALLER (cada run-*.ps1) resolve $RepoRoot via
    $MyInvocation.MyCommand.Path -- o MESMO mecanismo que os wrappers ja
    usavam antes desta extracao -- e importa este .psm1 por um path relativo
    a esse $RepoRoot/$ScriptDir, nao por path relativo ao working directory
    do processo. Working directory sob o Task Scheduler nao e garantido ser
    o repo root, entao qualquer import relativo ao cwd quebraria ali mesmo
    funcionando na mao.

.NOTES
    Issue: #4756.
#>

Set-StrictMode -Version Latest

function Invoke-DiariaScheduledWrapper {
    <#
    .SYNOPSIS
        Roda um script `npx tsx` com log resiliente + exit code honesto.

    .PARAMETER RepoRoot
        Diretorio pra onde o processo faz cd antes de invocar o script.

    .PARAMETER ScriptPath
        Path do script .ts a rodar via `npx tsx`.

    .PARAMETER ScriptArgs
        Argumentos extras passados ao script (ex: --incremental, --push,
        --strict). Default: nenhum.

    .PARAMETER LogPath
        Log final (dentro de data/, sujeito a lock do OneDrive).

    .PARAMETER TempLogPath
        Log temporario (fora de data/, escrito primeiro, sem risco de lock).

    .PARAMETER Label
        Texto do cabecalho do log ("===== <timestamp> - <Label> =====").

    .PARAMETER ExitCodeKey
        Nome da chave no rodape do log ("===== fim (<ExitCodeKey>=<codigo>) =====").
        Preserva o texto historico de cada wrapper (ex: "sync", "alarm",
        "check", "evaluate", "monitor") -- alguns testes de regressao
        travam esse texto literal.

    .PARAMETER PreCheck
        Scriptblock opcional rodado ANTES da chamada nativa. Retornar
        $null/string vazia = ok, segue normalmente. Retornar uma string
        NAO-vazia aborta com essa string como motivo (logada com prefixo
        "AVISO: "), SEM invocar ScriptPath -- usado por wrappers com guard
        proprio (ex: run-evaluate-brevo-diaria.ps1, contacts.json ausente).
        O scriptblock roda no escopo onde foi DEFINIDO (closure lexica
        padrao do PowerShell) -- consegue ler variaveis do script chamador
        (ex: -ContactsJsonPath) sem precisar delas como parametro aqui.

    .OUTPUTS
        Int -- exit code que o wrapper deve usar (`exit $code`).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$ScriptPath,
        [string[]]$ScriptArgs = @(),
        [Parameter(Mandatory)] [string]$LogPath,
        [Parameter(Mandatory)] [string]$TempLogPath,
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [string]$ExitCodeKey,
        [scriptblock]$PreCheck
    )

    Set-Location $RepoRoot

    function Write-TempLogLine {
        param([string]$Value)
        Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
    }

    Write-TempLogLine ""
    Write-TempLogLine "===== $(Get-Date -Format o) - $Label ====="

    $scriptCode = $null
    $trailerValue = $null

    if ($PreCheck) {
        $abortReason = & $PreCheck
        if ($abortReason) {
            Write-TempLogLine "AVISO: $abortReason"
            $scriptCode = 1
            $trailerValue = "skip-guard"
        }
    }

    if ($null -eq $trailerValue) {
        # Pre-inicializa $global:LASTEXITCODE=$null ANTES da chamada nativa
        # (#4343): mesmo guard historico de cada wrapper, agora usando o
        # qualificador :global explicito -- ver GOTCHA de escopo no
        # .DESCRIPTION acima do modulo.
        $global:LASTEXITCODE = $null
        & npx tsx $ScriptPath @ScriptArgs 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
        $scriptCode = $global:LASTEXITCODE

        if ($null -eq $scriptCode) {
            Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
            $scriptCode = 1
        }
        $trailerValue = $scriptCode
    }

    Write-TempLogLine "===== fim ($ExitCodeKey=$trailerValue) ====="

    # Anexa o log temporario (fora de data/, sem risco de lock OneDrive) ao
    # log final dentro de data/, com retry curto -- o lock do OneDrive
    # costuma liberar em milissegundos (#4047).
    $logAppendOk = $false
    $lastLogError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $logDir = Split-Path -Parent $LogPath
            if (-not (Test-Path -LiteralPath $logDir)) {
                New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
            }
            $tempContent = Get-Content -LiteralPath $TempLogPath -Raw -ErrorAction Stop
            Add-Content -LiteralPath $LogPath -Encoding utf8 -Value $tempContent -ErrorAction Stop
            $logAppendOk = $true
            break
        } catch {
            $lastLogError = $_
            if ($attempt -lt 3) {
                Start-Sleep -Milliseconds (300 * $attempt)
            }
        }
    }

    if ($logAppendOk) {
        Remove-Item -LiteralPath $TempLogPath -ErrorAction SilentlyContinue
    } else {
        Write-Host "AVISO: falha ao gravar o log final em $LogPath apos 3 tentativas ($lastLogError). Log temporario preservado em $TempLogPath."
    }

    # Exit code honesto: falha de log tambem reprova a run, mesmo que o
    # script embrulhado tenha ido bem -- sem isso, o Task Scheduler poderia
    # achar que esta tudo ok sem nenhum log da run ter sido persistido.
    $code = if ($scriptCode -ne 0) { $scriptCode } elseif (-not $logAppendOk) { 1 } else { 0 }
    return $code
}

Export-ModuleMember -Function Invoke-DiariaScheduledWrapper
