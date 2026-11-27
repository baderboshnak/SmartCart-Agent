$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]

$fixtures = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'approved-voice-fixtures.json') -Raw -Encoding utf8 | ConvertFrom-Json
$outputPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../reports/evaluation/approved-voice-inputs'))
$null = [IO.Directory]::CreateDirectory($outputPath)
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
if (-not $asTask) { throw 'Windows async speech adapter is unavailable.' }
$streamTask = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

foreach ($entry in $fixtures) {
    if ($entry.id -notmatch '^VOICE-[A-Z-]+$') { throw 'Unexpected audio fixture ID.' }
    $voice = $voices | Where-Object Language -eq $entry.locale | Select-Object -First 1
    if (-not $voice) { throw "No local Windows speech voice is installed for $($entry.locale)." }
    $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
    $synth.Voice = $voice
    $operation = $synth.SynthesizeTextToStreamAsync([string]$entry.request)
    $task = $streamTask.Invoke($null, @($operation))
    $speech = $task.GetAwaiter().GetResult()
    $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($speech.GetInputStreamAt(0))
    $file = [IO.File]::Create((Join-Path $outputPath ($entry.id + '.wav')))
    try { $input.CopyTo($file) }
    finally { $file.Dispose(); $input.Dispose(); $speech.Dispose(); $synth.Dispose() }
    Write-Output "$($entry.id) generated locally with $($voice.DisplayName)"
}
