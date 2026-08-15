# S1 spike (throwaway): crop a dialogue-panel region and measure OCR cost vs full frame.
param([Parameter(Mandatory = $true)][string]$Dir)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($t, $rt) {
    $netTask = $asTaskGeneric.MakeGenericMethod($rt).Invoke($null, @($t))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language "en-US"))

# Dialogue/subtitle-sized regions, hand-picked from the images.
$crops = @(
    @{ src = 'discoelysium_4.jpg'; x = 1240; y = 405; w = 520; h = 430; note = 'dialogue panel' },
    @{ src = 'discoelysium_5.jpg'; x = 1240; y = 300; w = 540; h = 600; note = 'dialogue panel' },
    @{ src = 'pentiment_1.jpg'; x = 300; y = 250; w = 800; h = 400; note = 'text panel' },
    @{ src = 'discoelysium_4.jpg'; x = 360; y = 830; w = 1200; h = 150; note = 'subtitle-strip geometry' }
)

New-Item -ItemType Directory -Force -Path "$Dir\crops" | Out-Null

$i = 0
foreach ($c in $crops) {
    $i++
    $srcPath = "$Dir\images\$($c.src)"
    $img = [System.Drawing.Image]::FromFile($srcPath)
    $rect = New-Object System.Drawing.Rectangle $c.x, $c.y, $c.w, $c.h
    $bmp = New-Object System.Drawing.Bitmap $c.w, $c.h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $c.w, $c.h), $rect, [System.Drawing.GraphicsUnit]::Pixel)
    $outPath = "$Dir\crops\crop$i`_$($c.src -replace '\.jpg','').png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $img.Dispose()

    # OCR the crop three times; report the best (warm) time.
    $times = @()
    $text = ''
    for ($k = 0; $k -lt 3; $k++) {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($outPath)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $sw.Stop()
        $times += $sw.ElapsedMilliseconds
        $text = $ocr.Text
        $stream.Dispose(); $bitmap.Dispose()
    }
    $best = ($times | Measure-Object -Minimum).Minimum
    Write-Host ("{0,-34} {1,4}x{2,-4} best={3,4}ms (runs: {4}) chars={5}" -f "$($c.src) [$($c.note)]", $c.w, $c.h, $best, ($times -join ','), ($text -replace '\s', '').Length)
    Write-Host "   -> $($text -replace '\r?\n',' ' )"
    Write-Host ''
}
