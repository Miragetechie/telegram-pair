const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const express = require('express');

const bot = new TelegramBot('7959549272:AAE6yg3a5EHa_qS-7zf5V7he8yk_x8_7Z1U', { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

function removeFile(filePath) {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
}

function makeid(length = 6) {
  return Array.from({ length }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
}

async function initWhatsApp(sessionDir) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '*Welcome!*\nUse /pair <phone_number> to get a pairing code or /qr to get a QR code.', { parse_mode: 'Markdown' });
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const phoneNumber = match[1].replace(/[^0-9]/g, '');

  if (!/^\+?[1-9]\d{10,14}$/.test(phoneNumber)) {
    return bot.sendMessage(chatId, 'Please send a valid phone number.');
  }

  const sessionDir = path.join(tempDir, makeid());

  try {
    const sock = await initWhatsApp(sessionDir);
    const code = await sock.requestPairingCode(phoneNumber);
    bot.sendMessage(chatId, `Your pairing code is: *${code}*`, { parse_mode: 'Markdown' });

    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        const creds = fs.readFileSync(path.join(sessionDir, 'creds.json'));
        const b64creds = Buffer.from(creds).toString('base64');
        bot.sendMessage(chatId, '*Success!*\nHere is your encoded session data:', { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, b64creds);
        await sock.logout();
        removeFile(sessionDir);
      }
    });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    removeFile(sessionDir);
  }
});

bot.onText(/\/qr/, async (msg) => {
  const chatId = msg.chat.id;
  const sessionDir = path.join(tempDir, makeid());

  try {
    const sock = await initWhatsApp(sessionDir);

    sock.ev.on('connection.update', async ({ connection, qr }) => {
      if (qr) {
        const qrImage = await qrcode.toDataURL(qr);
        bot.sendPhoto(chatId, Buffer.from(qrImage.split(',')[1], 'base64'), { caption: 'Scan this QR code to pair' });
      } else if (connection === 'open') {
        const creds = fs.readFileSync(path.join(sessionDir, 'creds.json'));
        const b64creds = Buffer.from(creds).toString('base64');
        bot.sendMessage(chatId, '*Success!*\nHere is your encoded session data:', { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, b64creds);
        await sock.logout();
        removeFile(sessionDir);
      }
    });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    removeFile(sessionDir);
  }
});

bot.on('polling_error', console.error);

app.get('/', (req, res) => res.send('Telegram Bot is running!'));
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
