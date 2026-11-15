# Info-gap chatbot server (no installs needed - uses built-in Windows PowerShell).
# - Serves the web page on http://localhost:PORT/
# - Keeps your OpenAI API key on this computer and hands the browser a
#   short-lived (ephemeral) key for each conversation.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$web  = Join-Path $root 'public'

# ---- Settings from .env (or environment variables) ----
$cfg = @{}
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $cfg[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
        }
    }
}
function Get-Setting($name, $default) {
    if ($cfg[$name]) { return $cfg[$name] }
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v) { return $v }
    return $default
}

$apiKey        = Get-Setting 'OPENAI_API_KEY' ''
$model         = Get-Setting 'REALTIME_MODEL' 'gpt-realtime-2.1'
$transcribe    = Get-Setting 'TRANSCRIBE_MODEL' 'gpt-4o-mini-transcribe'
$maxQuestions  = [int](Get-Setting 'MAX_QUESTIONS' '3')
$port          = [int](Get-Setting 'PORT' '8080')

$static = @{
    '/'              = @('index.html', 'text/html; charset=utf-8')
    '/index.html'    = @('index.html', 'text/html; charset=utf-8')
    '/app.js'        = @('app.js', 'application/javascript; charset=utf-8')
    '/styles.css'    = @('styles.css', 'text/css; charset=utf-8')
    '/stories.json'  = @('stories.json', 'application/json; charset=utf-8')
}

function Send-Bytes($ctx, [int]$status, [string]$type, [byte[]]$bytes) {
    $ctx.Response.StatusCode = $status
    $ctx.Response.ContentType = $type
    $ctx.Response.Headers.Add('Cache-Control', 'no-store')
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}
function Send-Json($ctx, [int]$status, $obj) {
    $json = $obj | ConvertTo-Json -Depth 10 -Compress
    Send-Bytes $ctx $status 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function New-RealtimeKey($ctx) {
    if (-not $apiKey -or $apiKey -like 'sk-PASTE*') {
        Send-Json $ctx 500 @{ error = 'Falta la clave de OpenAI. Abre el archivo .env y pega tu OPENAI_API_KEY.' }
        return
    }
    $reader = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
    $req = $reader.ReadToEnd() | ConvertFrom-Json

    # Re-read files each time so edits to stories/prompt apply without restarting.
    $data = Get-Content (Join-Path $web 'stories.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $story = $data.historias | Where-Object { $_.id -eq $req.storyId } | Select-Object -First 1
    if (-not $story) { Send-Json $ctx 400 @{ error = 'Historia no encontrada.' }; return }
    $persona = $story.personas | Where-Object { $_.id -eq $req.personaId } | Select-Object -First 1
    if (-not $persona) { Send-Json $ctx 400 @{ error = 'Persona no encontrada.' }; return }

    $instructions = (Get-Content (Join-Path $web 'persona-prompt.txt') -Raw -Encoding UTF8).
        Replace('{{NOMBRE}}', $persona.nombre).
        Replace('{{TITULO}}', $story.titulo).
        Replace('{{ROL}}', $persona.rol).
        Replace('{{HISTORIA}}', $persona.historia).
        Replace('{{NO_SABE}}', $persona.noSabe).
        Replace('{{MAX}}', [string]$maxQuestions)

    $payload = @{
        session = @{
            type         = 'realtime'
            model        = $model
            instructions = $instructions
            audio        = @{
                input  = @{
                    transcription  = @{ model = $transcribe; language = 'es' }
                    # semantic VAD with low eagerness = gives learners time to think mid-sentence
                    turn_detection = @{ type = 'semantic_vad'; eagerness = 'low' }
                }
                output = @{ voice = $persona.voz }
            }
        }
    }
    $body = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 10))

    try {
        $resp = Invoke-RestMethod -Method Post -Uri 'https://api.openai.com/v1/realtime/client_secrets' `
            -Headers @{ Authorization = "Bearer $apiKey" } `
            -ContentType 'application/json; charset=utf-8' -Body $body
        Send-Json $ctx 200 @{ value = $resp.value; maxQuestions = $maxQuestions }
    } catch {
        $msg = $_.ErrorDetails.Message
        if (-not $msg) { $msg = $_.Exception.Message }
        Write-Host "OpenAI error: $msg" -ForegroundColor Red
        Send-Json $ctx 502 @{ error = "OpenAI: $msg" }
    }
}

function Invoke-Request($ctx) {
    $path = $ctx.Request.Url.AbsolutePath
    $method = $ctx.Request.HttpMethod
    if ($method -eq 'POST' -and $path -eq '/api/session') { New-RealtimeKey $ctx; return }
    if ($method -eq 'GET' -and $path -eq '/api/config') { Send-Json $ctx 200 @{ maxQuestions = $maxQuestions; hasKey = [bool]$apiKey }; return }
    if ($method -eq 'GET' -and $static.ContainsKey($path)) {
        $file = Join-Path $web $static[$path][0]
        Send-Bytes $ctx 200 $static[$path][1] ([IO.File]::ReadAllBytes($file))
        return
    }
    Send-Bytes $ctx 404 'text/plain' ([Text.Encoding]::UTF8.GetBytes('No encontrado'))
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host ""
Write-Host "  Info-gap chatbot running at  http://localhost:$port/" -ForegroundColor Green
Write-Host "  Model: $model   Questions per person: $maxQuestions"
if (-not $apiKey) { Write-Host "  WARNING: no OPENAI_API_KEY found in .env" -ForegroundColor Yellow }
Write-Host "  Close this window (or press Ctrl+C) to stop."
Write-Host ""
if ((Get-Setting 'OPEN_BROWSER' '1') -ne '0') { Start-Process "http://localhost:$port/" }

try {
    while ($listener.IsListening) {
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(250)) { }   # lets Ctrl+C work
        $ctx = $task.GetAwaiter().GetResult()
        try { Invoke-Request $ctx }
        catch {
            Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
            try { Send-Json $ctx 500 @{ error = $_.Exception.Message } } catch { }
        }
    }
} finally {
    $listener.Stop()
}
