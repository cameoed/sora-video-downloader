# Sora Video Downloader

Desktop app for saving your Sora videos and draft prompts! [**Get the app here!**](https://github.com/cameoed/sora-video-downloader/releases/tag/v1.0.0)

![Sora Video Downloader app preview](./icons/preview.png)

## Features

- Sign in through the built-in `Open Sora` flow
- Save from:
  `My Posts`, `My Drafts`, `My Draft Prompts`, `Cast-in Posts`, `Drafts of Me`, and `Character`
- No-watermark mode with provider failover
- AI label controls:
  `No AI Label` or `With AI Label`
- Crop controls:
  `Default Crop` or `16:9 for Social`
- Progress UI with page-aware scan updates
- `Open folder` shortcut after a run
- `Clear cache` for remembered download history
- Prompt CSV export with similar draft prompts de-duplicated

Built by [topher](https://github.com/cameoed) with huge contributions by [lgcarrier](https://github.com/lgcarrier), [byeson](https://github.com/byeson), [slogonomo](https://github.com/slogonomo), [alexandria](https://github.com/alexdredmon).

Watermark removal powered by [monson](https://kontenai.net?ref=topher) and [soravdl](https://soravdl.com).

## Install

Use the latest GitHub Release if you just want the app.

macOS:
1. Download the correct `.dmg`
2. Drag `Sora Video Downloader.app` into `Applications`
3. If macOS blocks it, run:

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Sora Video Downloader.app"
```

Windows:
1. Download the latest `.exe`
2. Run the installer

## Use

1. Open the app
2. Click `Open Sora`
3. Sign in
4. Pick a backup type
5. Pick your settings and save location
6. Click `Start backup` or `Save prompts`

## Backup Types

- `My Posts`
  Downloads your published Sora posts.

- `My Drafts`
  Downloads your draft videos.

- `My Draft Prompts`
  Saves a CSV of draft prompts.
  Similar prompts are de-duplicated before export.

- `Cast-in Posts`
  Downloads posts where you appear.

- `Drafts of Me`
  Downloads drafts where you appear.

- `Character`
  Downloads posts for the handle entered in the character box.

## Settings

- `Video Mode`
  `No Watermark` tries to save a no-watermark version.
  `With Watermark` keeps the original version.

- `AI Label`
  `No AI Label` removes the audiomark and strips C2PA manifest data.
  `With AI Label` keeps the original labeling.

- `Crop`
  `Default Crop` keeps the source framing.
  `16:9 for Social` exports social-ready framing.

- `Save location`
  Chooses where downloads and prompt CSVs are written.

## Output

Everything is saved inside a `Sora Video Downloader` folder in your chosen save location.

Video runs create folders based on the selected backup type and export settings.

`My Draft Prompts` writes a CSV file named `my-prompts.csv` inside `Sora Video Downloader/My Sora Prompts`.
The CSV starts with:

`All draft prompts with similar prompts de-duplicated!`

## Cache

`Clear cache` resets remembered download history for selected modes or characters.
It does not delete files already saved on disk.

## Run From Source

```bash
npm install
npm run start:app
```

## Build

```bash
npm run dist:mac
npm run dist:win
```

## Notes

- Unofficial community tool
- Not affiliated with Sora or OpenAI
- Data stays on your machine
- Built with Electron for macOS and Windows

## License

MIT. See [LICENSE](./LICENSE).
