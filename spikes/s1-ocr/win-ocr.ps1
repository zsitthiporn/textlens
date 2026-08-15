# S1 spike (throwaway): run Windows.Media.Ocr over a folder of images.
# Emits one JSON object per image to <out>.
param(
    [Parameter(Mandatory = $true)][string]$ImageDir,
    [Parameter(Mandatory = $true)][string]$OutJson
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$lang = New-Object Windows.Globalization.Language "en-US"
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) { throw "No OCR engine for en-US" }

Write-Host "engine max dimension: $([Windows.Media.Ocr.OcrEngine]::MaxImageDimension)"

$results = @()
$files = Get-ChildItem -Path $ImageDir -File | Sort-Object Name

foreach ($f in $files) {
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()

        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $decodeMs = $sw.ElapsedMilliseconds

        $swOcr = [System.Diagnostics.Stopwatch]::StartNew()
        $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $swOcr.Stop()
        $sw.Stop()

        $lines = @()
        foreach ($l in $ocr.Lines) {
            $words = @($l.Words)
            $minX = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
            $minY = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
            $maxX = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
            $maxY = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
            $lines += [pscustomobject]@{
                text = $l.Text
                bbox = @([int]$minX, [int]$minY, [int]($maxX - $minX), [int]($maxY - $minY))
            }
        }

        $results += [pscustomobject]@{
            file      = $f.Name
            width     = [int]$decoder.PixelWidth
            height    = [int]$decoder.PixelHeight
            decodeMs  = [int]$decodeMs
            ocrMs     = [int]$swOcr.ElapsedMilliseconds
            lineCount = $lines.Count
            charCount = ($ocr.Text -replace '\s', '').Length
            text      = $ocr.Text
            lines     = $lines
        }

        $stream.Dispose()
        $bitmap.Dispose()
        Write-Host ("{0,-28} {1,5}x{2,-5} ocr={3,5}ms lines={4,3} chars={5,5}" -f $f.Name, $decoder.PixelWidth, $decoder.PixelHeight, $swOcr.ElapsedMilliseconds, $lines.Count, ($ocr.Text -replace '\s', '').Length)
    }
    catch {
        Write-Host "FAIL $($f.Name): $($_.Exception.Message)"
        $results += [pscustomobject]@{ file = $f.Name; error = $_.Exception.Message }
    }
}

$results | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "wrote $OutJson  ($($results.Count) results)"
