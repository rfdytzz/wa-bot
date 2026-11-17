// index.js - WhatsApp bot (Baileys) with sticker maker and Gemini AI
// Run: node index.js
//
// Install first:
//   npm init -y
//   npm pkg set type=module
//   npm i @whiskeysockets/baileys pino qrcode-terminal wa-sticker-formatter sharp
//
// AI feature (Gemini): create a .env file containing
//   GEMINI_API_KEY=your_api_key_here
// then run with:  node --env-file=.env index.js
// (get an API key from https://aistudio.google.com/apikey)
//
// Stickers from VIDEO/GIF require ffmpeg to be installed:
//   Ubuntu/Debian : sudo apt install ffmpeg
//   Termux        : pkg install ffmpeg
//   Windows       : https://ffmpeg.org/download.html (add it to PATH)

import pino from 'pino'
import qrcode from 'qrcode-terminal'
import sharp from 'sharp'

// Import that works for both Baileys v6 (CJS) and v7 (ESM)
const B = await import('@whiskeysockets/baileys')
const lib = B.default?.useMultiFileAuthState ? B.default : B
const makeWASocket = B.default?.default ?? B.default ?? B.makeWASocket
const {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    fetchLatestBaileysVersion,
} = lib

const WSF = await import('wa-sticker-formatter')
const { Sticker, StickerTypes } = WSF.Sticker ? WSF : WSF.default

// ================== CONFIG ==================
const PREFIXES = ['.', '!', '/']
const PACK_NAME = 'Bot Stiker'          // default pack name
const AUTHOR_NAME = 'Dibuat dengan Baileys' // default author name
const MAX_VIDEO_SECONDS = 10            // max video length for animated stickers
const MAX_AGE_SECONDS = 60              // ignore old messages (e.g. right after reconnecting)

// --- AI (Gemini) ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
const AI_COOLDOWN_MS = 5000             // minimum delay between .ai uses per user (protects the free quota)
const AI_MAX_HISTORY = 8                // number of Q&A turns remembered per chat
const AI_SYSTEM_PROMPT =
    'Kamu adalah asisten di WhatsApp. Jawab dalam bahasa yang dipakai pengguna (default Bahasa Indonesia), ' +
    'singkat, jelas, dan ramah. Gunakan format WhatsApp (*tebal*, _miring_) seperlunya, jangan pakai tabel atau heading markdown.'
// =================================================

const logger = pino({ level: 'silent' })

// ---------- Helper ----------

const unwrapEphemeral = (m) => m?.ephemeralMessage?.message || m

function getText(message) {
    const m = unwrapEphemeral(message)
    return (
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        ''
    )
}

// Find media (image/video/sticker) inside a message
function findMedia(message) {
    const m = unwrapEphemeral(message)
    if (!m) return null
    for (const type of ['imageMessage', 'videoMessage', 'stickerMessage']) {
        const media = m[type]
        if (media && !media.viewOnce) return { type, media }
    }
    return null
}

// Media from the message itself (image + .s caption) or from the replied message
function getTargetMedia(msg) {
    const own = findMedia(msg.message)
    if (own) return own

    const m = unwrapEphemeral(msg.message)
    const ctx =
        m?.extendedTextMessage?.contextInfo ||
        m?.imageMessage?.contextInfo ||
        m?.videoMessage?.contextInfo
    return findMedia(ctx?.quotedMessage)
}

async function downloadMedia({ type, media }) {
    const stream = await downloadContentFromMessage(media, type.replace('Message', ''))
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
}

const reply = (sock, msg, text) =>
    sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg })

const react = (sock, msg, emoji) =>
    sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }).catch(() => { })

// ---------- Commands ----------

async function cmdSticker({ sock, msg, from, argText, prefix }) {
    const target = getTargetMedia(msg)
    if (!target) {
        return reply(
            sock, msg,
            `Kirim gambar/video dengan caption *${prefix}s*, atau balas gambar/video/stiker dengan *${prefix}s*.\n\n` +
            `Opsi:\n` +
            `• *${prefix}s crop*  → stiker dipotong kotak\n` +
            `• *${prefix}s round* → stiker bulat\n` +
            `• *${prefix}s nama pack|author* → ganti nama pack & author\n` +
            `Contoh: ${prefix}s crop Stikerku|Budi`
        )
    }

    if (target.type === 'videoMessage' && (target.media.seconds || 0) > MAX_VIDEO_SECONDS) {
        return reply(sock, msg, `❌ Video terlalu panjang. Maksimal ${MAX_VIDEO_SECONDS} detik.`)
    }

    // Separate flags (crop/round) from "pack|author"
    let type = StickerTypes.FULL
    const words = argText.split(/\s+/).filter(Boolean)
    while (words.length && ['crop', 'round', 'circle', 'full'].includes(words[0].toLowerCase())) {
        const flag = words.shift().toLowerCase()
        if (flag === 'crop') type = StickerTypes.CROPPED
        else if (flag === 'round' || flag === 'circle') type = StickerTypes.CIRCLE
        else type = StickerTypes.FULL
    }
    const [packRaw, authorRaw] = words.join(' ').split('|')
    const pack = packRaw?.trim() || PACK_NAME
    const author = authorRaw?.trim() || AUTHOR_NAME

    await react(sock, msg, '⏳')
    try {
        const buffer = await downloadMedia(target)
        const sticker = new Sticker(buffer, {
            pack,
            author,
            type,
            categories: ['🤩'],
            quality: 50,
        })
        const out = await sticker.toBuffer()
        await sock.sendMessage(from, { sticker: out }, { quoted: msg })
        await react(sock, msg, '✅')
    } catch (err) {
        console.error('Gagal membuat stiker:', err)
        await react(sock, msg, '❌')
        const hint = target.type === 'videoMessage' ? ' Pastikan ffmpeg sudah terpasang.' : ''
        await reply(sock, msg, `❌ Gagal membuat stiker.${hint}`)
    }
}

async function cmdToImg({ sock, msg, from, prefix }) {
    const target = getTargetMedia(msg)
    if (!target || target.type !== 'stickerMessage') {
        return reply(sock, msg, `Balas sebuah stiker dengan *${prefix}toimg*.`)
    }
    if (target.media.isAnimated) {
        return reply(sock, msg, '❌ Stiker animasi belum didukung, hanya stiker biasa.')
    }
    try {
        const buffer = await downloadMedia(target)
        const png = await sharp(buffer).png().toBuffer()
        await sock.sendMessage(from, { image: png, caption: '✅ Berhasil diubah ke gambar' }, { quoted: msg })
    } catch (err) {
        console.error('Gagal toimg:', err)
        await reply(sock, msg, '❌ Gagal mengubah stiker ke gambar.')
    }
}

async function cmdMenu({ sock, msg, prefix }) {
    return reply(
        sock, msg,
        `*📋 Menu Bot*\n\n` +
        `*${prefix}s* — buat stiker dari gambar/video/stiker\n` +
        `   opsi: crop, round, atau nama pack|author\n` +
        `*${prefix}toimg* — ubah stiker jadi gambar\n` +
        `*${prefix}ai* — tanya AI (bisa balas pesan/gambar)\n` +
        `*${prefix}aireset* — hapus memori percakapan AI\n` +
        `*${prefix}menu* — tampilkan menu ini`
    )
}

// ---------- AI (Gemini) ----------

const aiHistory = new Map()   // chat jid -> [{ role, parts }]
const aiLastUse = new Map()   // sender -> last use timestamp

function getQuotedText(msg) {
    const m = unwrapEphemeral(msg.message)
    const ctx =
        m?.extendedTextMessage?.contextInfo ||
        m?.imageMessage?.contextInfo ||
        m?.videoMessage?.contextInfo
    return ctx?.quotedMessage ? getText(ctx.quotedMessage).trim() : ''
}

async function askGemini(contents) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
            contents,
            generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
        }),
        signal: AbortSignal.timeout(45000),
    })

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`)
        err.status = res.status
        throw err
    }

    const data = await res.json()
    if (data.promptFeedback?.blockReason) {
        const err = new Error('blocked: ' + data.promptFeedback.blockReason)
        err.blocked = true
        throw err
    }
    const parts = data.candidates?.[0]?.content?.parts || []
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
    if (!text) {
        const err = new Error('empty response, finishReason=' + data.candidates?.[0]?.finishReason)
        err.empty = true
        throw err
    }
    return text
}

async function cmdAi({ sock, msg, from, argText, prefix }) {
    if (!GEMINI_API_KEY) {
        return reply(sock, msg, '❌ GEMINI_API_KEY belum diset. Lihat petunjuk di bagian atas index.js.')
    }

    const media = getTargetMedia(msg)
    const image = media?.type === 'imageMessage' ? media : null
    const quotedText = getQuotedText(msg)

    let question = argText.trim()
    if (!question && image) question = 'Jelaskan gambar ini.'
    if (!question && quotedText) question = 'Jelaskan atau tanggapi pesan ini.'
    if (!question) {
        return reply(
            sock, msg,
            `Tanya apa saja: *${prefix}ai pertanyaanmu*\n` +
            `• Balas sebuah pesan dengan *${prefix}ai* untuk meminta tanggapan/ringkasan/terjemahan\n` +
            `• Kirim atau balas gambar dengan *${prefix}ai apa ini?* untuk analisis gambar\n` +
            `• *${prefix}aireset* untuk menghapus memori percakapan`
        )
    }

    // Per-user cooldown
    const who = msg.key.fromMe ? 'me' : (msg.key.participant || msg.key.remoteJid)
    const wait = AI_COOLDOWN_MS - (Date.now() - (aiLastUse.get(who) || 0))
    if (wait > 0) {
        return reply(sock, msg, `⏳ Tunggu ${Math.ceil(wait / 1000)} detik lagi ya.`)
    }
    aiLastUse.set(who, Date.now())

    const promptText = quotedText && !image
        ? `Konteks (pesan yang dibalas):\n"""${quotedText}"""\n\nPermintaan: ${question}`
        : question

    const userParts = []
    if (image) {
        const buffer = await downloadMedia(image)
        if (buffer.length > 15 * 1024 * 1024) return reply(sock, msg, '❌ Gambar terlalu besar.')
        userParts.push({ inlineData: { mimeType: image.media.mimetype || 'image/jpeg', data: buffer.toString('base64') } })
    }
    userParts.push({ text: promptText })

    const history = aiHistory.get(from) || []
    await react(sock, msg, '⏳')
    try {
        const answer = await askGemini([...history, { role: 'user', parts: userParts }])

        // Save to memory (images are not stored, only a text marker)
        history.push(
            { role: 'user', parts: [{ text: image ? `[gambar] ${promptText}` : promptText }] },
            { role: 'model', parts: [{ text: answer }] }
        )
        while (history.length > AI_MAX_HISTORY * 2) history.splice(0, 2)
        aiHistory.set(from, history)

        await sock.sendMessage(from, { text: answer }, { quoted: msg })
        await react(sock, msg, '✅')
    } catch (err) {
        console.error('Gagal memanggil Gemini:', err?.message || err)
        await react(sock, msg, '❌')
        if (err.status === 429) return reply(sock, msg, '❌ Batas pemakaian Gemini sedang penuh. Coba lagi beberapa saat lagi.')
        if (err.status === 400 || err.status === 403) return reply(sock, msg, '❌ Permintaan ditolak Gemini. Cek API key dan nama model di konfigurasi.')
        if (err.status === 404) return reply(sock, msg, `❌ Model "${GEMINI_MODEL}" tidak ditemukan. Cek nama model.`)
        if (err.blocked) return reply(sock, msg, '❌ Permintaan diblokir oleh filter keamanan Gemini.')
        if (err.empty) return reply(sock, msg, '❌ Gemini tidak memberi jawaban. Coba ubah pertanyaannya.')
        return reply(sock, msg, '❌ Terjadi kesalahan saat menghubungi Gemini.')
    }
}

async function cmdAiReset({ sock, msg, from }) {
    aiHistory.delete(from)
    return reply(sock, msg, '🧹 Memori percakapan AI di chat ini sudah dihapus.')
}

const commands = {
    s: cmdSticker,
    sticker: cmdSticker,
    stiker: cmdSticker,
    toimg: cmdToImg,
    ai: cmdAi,
    gemini: cmdAi,
    tanya: cmdAi,
    aireset: cmdAiReset,
    menu: cmdMenu,
    help: cmdMenu,
}

// ---------- Bot ----------

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['Sticker Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('Scan QR berikut dengan WhatsApp (Perangkat Tertaut):')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'open') console.log('✅ Terhubung sebagai', sock.user?.id)
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            console.log('❌ Koneksi terputus, kode:', code)
            if (code !== DisconnectReason.loggedOut) startBot()
            else console.log('Sesi logout. Hapus folder ./auth lalu jalankan ulang.')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message) continue
                const from = msg.key.remoteJid
                if (!from || from === 'status@broadcast') continue

                // Ignore old messages
                const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0)
                if (ts && Date.now() / 1000 - ts > MAX_AGE_SECONDS) continue

                const text = getText(msg.message).trim()
                const prefix = PREFIXES.find((p) => text.startsWith(p))
                if (!prefix) continue

                const [cmdName, ...rest] = text.slice(prefix.length).split(/\s+/)
                const handler = commands[cmdName.toLowerCase()]
                if (!handler) continue

                await handler({ sock, msg, from, prefix, argText: rest.join(' ') })
            } catch (err) {
                console.error('Error memproses pesan:', err)
            }
        }
    })
}

startBot()