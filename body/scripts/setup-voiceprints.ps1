$ErrorActionPreference = 'Stop'
# Her ear for voices: sherpa-onnx (speaker embeddings) plus a 16 kHz English speaker model. Uses the
# Parakeet Python environment when it exists (same library), otherwise its own under LOCALAPPDATA.
$botDir = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $botDir 'models\voiceprints'
$modelFile = Join-Path $modelDir 'wespeaker_en_voxceleb_CAM++.onnx'
$modelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx'
$parakeetPython = Join-Path $env:LOCALAPPDATA 'NewChamp\Parakeet\venv\Scripts\python.exe'
if (Test-Path -LiteralPath $parakeetPython) {
  $python = $parakeetPython
} else {
  $runtime = Join-Path $env:LOCALAPPDATA 'NewChamp\Voiceprints'
  $python = Join-Path $runtime 'venv\Scripts\python.exe'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  if (-not (Test-Path -LiteralPath $python)) {
    python -m venv (Join-Path $runtime 'venv')
    if ($LASTEXITCODE) { throw 'Python environment creation failed' }
  }
}
& $python -m pip install 'sherpa-onnx==1.13.8' 'numpy>=2,<3'
if ($LASTEXITCODE) { throw 'sherpa-onnx installation failed' }
New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $modelFile)) {
  curl.exe -L --fail --show-error -o $modelFile $modelUrl
  if ($LASTEXITCODE) { throw 'Speaker model download failed' }
}
if ((Get-Item -LiteralPath $modelFile).Length -lt 1MB) { throw "The downloaded model looks wrong (too small): $modelFile" }
Write-Output "Voiceprints ready: model at $modelFile, Python $python."
if ($python -ne $parakeetPython) { Write-Output "Add to .env: VOICEPRINT_PYTHON=$python" }
Write-Output 'Amy was not restarted; she picks it up on her next start.'
