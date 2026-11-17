# WhatsApp Sticker & AI (Personal Project)

A WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys). It turns images and videos into stickers and answers questions with Google Gemini.

> **Disclaimer:** Baileys is an unofficial library and is not affiliated with or endorsed by WhatsApp. Using it may violate WhatsApp's Terms of Service and can get an account restricted or banned. Use a secondary number, not your main one.

## Features

- **Sticker maker** from images, videos/GIFs, or existing stickers
  - Optional styles: `crop` (square cut) and `round` (circle)
  - Custom pack name and author
- **Sticker to image** converter
- **AI chat** powered by Gemini (default model: `gemini-3.1-flash-lite`)
  - Per-chat conversation memory
  - Understands replied messages (summarize, translate, explain)
  - Image analysis
  - Per-user cooldown to protect your API quota
- Commands work with the prefixes `.`, `!` and `/`

## Requirements

- Node.js **20.6 or newer** (needed for `--env-file`)
- A WhatsApp account to link as a device
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (only for the AI feature)
- [ffmpeg](https://ffmpeg.org/download.html) (only for stickers made from videos/GIFs)

## Installation

```bash
git clone https://github.com/rfdytzz/wa-bot.git
cd wa-bot
npm install
```

Your `package.json` should contain `"type": "module"` and an `overrides` block that forces a single, up-to-date `sharp` (the version bundled with `wa-sticker-formatter` is old and has known vulnerabilities):

```json
{
  "type": "module",
  "dependencies": {
    "@whiskeysockets/baileys": "latest",
    "pino": "latest",
    "qrcode-terminal": "latest",
    "sharp": "latest",
    "wa-sticker-formatter": "latest"
  },
  "overrides": {
    "sharp": "$sharp"
  }
}
```

Recent npm versions may print an `allow-scripts` warning after install. Approve the packages that need install scripts:

```bash
npm approve-scripts sharp protobufjs @whiskeysockets/baileys
```

## Configuration

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_api_key_here
# Optional: override the default model
# GEMINI_MODEL=gemini-3.1-flash-lite
```

Other settings (prefixes, default pack name, video length limit, AI cooldown, memory size) are at the top of `index.js`.

## Running

```bash
node --env-file=.env index.js
```

On the first run a QR code appears in the terminal. Scan it in WhatsApp under **Linked Devices**. The session is saved in `./auth`, so you only need to scan once.

## Commands

| Command | Description |
| --- | --- |
| `.s` | Create a sticker. Send an image/video with the caption `.s`, or reply to an image/video/sticker with `.s` |
| `.s crop` | Square-cropped sticker |
| `.s round` | Circular sticker |
| `.s Pack Name\|Author` | Set a custom pack name and author (e.g. `.s crop My Pack\|John`) |
| `.toimg` | Reply to a (non-animated) sticker to convert it to an image |
| `.ai <question>` | Ask the AI. Aliases: `.gemini`, `.tanya` |
| `.ai` (as a reply) | Ask the AI about the replied message, e.g. `.ai translate to English` |
| `.ai <question>` (with an image) | Analyze an image |
| `.aireset` | Clear the AI memory for the current chat |
| `.menu` | Show the command list |

Bot replies are written in Indonesian.

## Running 24/7

This bot needs a long-running process with persistent storage for `./auth`, so serverless platforms such as Vercel will not work. Good options:

- A small **VPS**, managed with `pm2`:
  ```bash
  npm i -g pm2
  pm2 start index.js --node-args="--env-file=.env" --name wa-bot
  pm2 save
  ```
- A container platform (Railway, Render, Fly.io, Koyeb, ...) **with a persistent volume** mounted at `./auth`
- **Termux** on Android, using `termux-wake-lock` and `tmux` (less reliable than a VPS)

## Limitations

- **View-once media is not supported.** WhatsApp does not deliver view-once content to linked devices, so a Baileys bot never receives it.
- Animated stickers cannot be converted with `.toimg`.
- AI memory is kept in RAM and is lost when the bot restarts.
- Videos used for stickers are limited to 10 seconds by default.

## Security

- **Never commit `auth/` or `.env`.** The `auth/` folder grants full access to the linked WhatsApp account, and `.env` contains your API key. Both are listed in `.gitignore`.
- If an API key is ever committed or leaked, revoke it and create a new one.
- Run `npm audit` occasionally. A few remaining findings come from `wa-sticker-formatter`'s dependencies; avoid `npm audit fix --force`, since it downgrades that package and may break stickers.

## License

Add a license of your choice (for example MIT) before making the repository public.