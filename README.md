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

## Using The App

For most people, use the latest packaged Release from the right side of this GitHub page. You do not need to install Node dependencies.

1. Download the latest Release from the right side of this GitHub page
2. On macOS, open the `.dmg` that matches your Mac and drag `Sora Video Downloader.app` into `Applications`
3. If macOS says the app is damaged or cannot be opened, that is the unsigned-app security warning rather than a broken build. Open Terminal and run:

   ```bash
   sudo xattr -rd com.apple.quarantine "/Applications/Sora Video Downloader.app"
   ```

4. Open the app
5. Click `Open Sora`
6. Sign in in the Sora browser window
7. Choose what you want to back up
8. Choose your `Video Mode`, `Audio Mode`, and `Save location`
9. Click `Start backup`
10. Use `Open folder` after a run to jump to the backup location

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
- **Not affiliated with Sora or OpenAI**
- Your backup data stays on your machine
- The app is built for macOS and Windows

## License

MIT. See [LICENSE](./LICENSE).
