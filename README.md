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
- Scans the videos available in the mode you choose
- Downloads videos to folders on your computer
- Keeps track of what it has already found and saved
- Lets you choose watermark and audiomark settings for each download folder

## How To Use

1. Install dependencies with `npm install`
2. Start the app with `npm run start:app`
3. Click `Open Sora` and sign in
4. Pick where downloads should be saved
5. Choose a mode
6. Click `Start backup`

## Download Folders

Downloads are saved inside a main folder called `Sora Video Downloader`.

Inside that, the app creates folders based on the mode and your selected output settings, for example:
- `My Sora Posts - No Watermark, No Audiomark`
- `My Sora Drafts - No Watermark, Yes Audiomark`
- `@ringcamera Sora Posts - No Watermark, Yes Audiomark`

## Build

- `npm run dist:mac` builds macOS files
- `npm run dist:win` builds Windows files

## Notes

- This is an unofficial community tool
- Your backup data stays on your machine

## License

MIT. See [LICENSE](./LICENSE).
