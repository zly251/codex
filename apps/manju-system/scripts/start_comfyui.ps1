$ErrorActionPreference = "Stop"
$comfyDir = "E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI"
$python = Join-Path $comfyDir ".venv\Scripts\python.exe"
$yaml = "E:\AIProjects\manju-system\config\extra_model_paths.yaml"
$logDir = "E:\AIProjects\manju-system\data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "comfyui.out.log"
$stderr = Join-Path $logDir "comfyui.err.log"
Remove-Item -Force $stdout, $stderr -ErrorAction SilentlyContinue
$args = "main.py --listen 127.0.0.1 --port 8188 --lowvram --disable-auto-launch --extra-model-paths-config `"$yaml`""
Start-Process -FilePath $python -ArgumentList $args -WorkingDirectory $comfyDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Write-Host "ComfyUI starting on http://127.0.0.1:8188"
