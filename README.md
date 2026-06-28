# Media Sensei

A private, local-first video compressor and converter for MP4, MOV, MKV, WebM, AVI and M4V files. It converts to MP4, WebM, or MOV and is designed to handle large inputs without loading the whole video into browser memory.

The cozy pixel-art interface has two clear workshop modes: Compress with Momo, the red-panda compressor, or Convert with Kapa, the capybara converter. Their four-frame game loops follow the selected operation while the progress bar updates.

## Run it

```powershell
npm.cmd install
npm.cmd start
```

Then open <http://127.0.0.1:4173>.

The FFmpeg executable is bundled by the `ffmpeg-static` package. Uploaded and compressed working files remain in `.media-compress-work` on this computer and are automatically deleted after six hours or when the server restarts.

## Compression profiles

- **Maximum shrink:** CRF 31, up to 720p, 80 kbps audio
- **Balanced:** CRF 26, up to 1080p, 112 kbps audio
- **Keep quality:** CRF 22, up to 4K, 160 kbps audio

Actual savings depend on the input codec, bitrate, resolution and visual complexity. Already-compressed videos may not become smaller.
