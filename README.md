# Sora Video Downloader

Sora Video Downloader is a simple desktop app for saving your Sora videos to your computer.

It can download:
- My posts
- My drafts
- Cast-in posts
- Drafts of me
- Posts from a selected character

Built by [topher](https://github.com/cameoed) with huge contributions by [lgcarrier](https://github.com/lgcarrier), [byeson](https://github.com/byeson), [slogonomo](https://github.com/slogonomo), and [alexandria](https://github.com/alexdredmon).

Watermark removal powered by [monson](https://www.paypal.com/paypalme/afiqhamdan/) — please consider donating to them as a thank you for creating the key piece to this puzzle.

## What It Does

- Opens Sora in a built-in browser window so you can sign in
- Lets you back up one scope at a time:
  - My posts
  - My drafts
  - Cast-in posts
  - Drafts of me
  - Posts from a selected character
- Lets you choose:
  - `Video Mode`: `No Watermark` or `With Watermark`
  - `Audio Mode`: `No Audiomark` or `With Audiomark`
  - `Save location`
- Tracks progress while it scans and downloads
- Creates organized download folders based on the scope and output settings you chose

## Using The App

If you are using a packaged app build, you do not need to install Node dependencies.

1. Open the app
2. Click `Open Sora`
3. Sign in in the Sora browser window
4. Choose what you want to back up
5. Choose your `Video Mode`, `Audio Mode`, and `Save location`
6. Click `Start backup`
7. Use `Open folder` after a run to jump to the backup location

## Running From Source

If you are running the repository directly instead of using a packaged app:

1. Install dependencies with `npm install`
2. Start the app with `npm run start:app`

After the app opens, use it the same way as the packaged app flow above.

## Output And Modes

`Video Mode`

- `No Watermark` is the app's no-watermark mode
- `With Watermark` keeps the watermark in the downloaded output

`Audio Mode`

- `With Audiomark` saves the downloaded video as-is
- `No Audiomark` removes the audiomark and writes the final file as `.mov`

## FFmpeg Note

`No Audiomark` requires FFmpeg.

- Packaged app releases bundle FFmpeg for supported macOS and Windows builds, so `No Audiomark` works without a separate FFmpeg install
- If you are running from source instead of using a packaged app, the app will still try to use an existing FFmpeg install first
- On macOS source runs, the app can download FFmpeg automatically if needed
- On Windows source runs, if FFmpeg is not available, switch to `With Audiomark` or install FFmpeg yourself

## Download Folders

Downloads are saved inside a main folder called `Sora Video Downloader`.

Inside that, the app creates folders based on the mode and your selected output settings, for example:
- `My Sora Posts - No Watermark, No Audiomark`
- `My Sora Drafts - No Watermark, Yes Audiomark`
- `@ringcamera Sora Posts - No Watermark, Yes Audiomark`

## Building Packaged Apps

If you want to build distributable app packages from source:

- `npm run dist:mac` builds macOS files
- `npm run dist:win` builds Windows files

## Notes

- This is an unofficial community tool
- Your backup data stays on your machine
- The app is built for macOS and Windows

## License

MIT. See [LICENSE](./LICENSE).
