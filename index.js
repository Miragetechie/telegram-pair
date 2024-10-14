const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const figlet = require('figlet');
const express = require('express');

// Replace 'YOUR_BOT_TOKEN' with your actual Telegram bot token
const bot = new TelegramBot('7959549272:AAE6yg3a5EHa_qS-7zf5V7he8yk_x8_7Z1U', { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

function removeFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { recursive: true, force: true });
}

function makeid(length = 6) {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function fancyText(text) {
  return new Promise((resolve, reject) => {
    figlet(text, { font: 'Standard' }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve('```\n' + data + '\n```');
      }
    });
  });
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcomeText = await fancyText('Welcome! to ᴋᴏʀᴅ-ᴀɪ - ᴘᴀɪʀɪɴɢ');
  bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
  bot.sendMessage(chatId, 'Use /pair <phone_number> to get a pairing code or /qr to get a QR code.');
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const phoneNumber = match[1];

  if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
    return bot.sendMessage(chatId, 'Please send a valid phone number.');
  }

  bot.sendMessage(chatId, 'Generating pairing code...');

  const id = makeid();
  const sessionDir = path.join(tempDir, id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
      browser: ['Chrome (Linux)', '', ''],
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      const fancyCode = await fancyText(code);
      bot.sendMessage(chatId, `Your pairing code is:\n${fancyCode}`, { parse_mode: 'Markdown' });
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          bot.sendMessage(chatId, 'Connection closed. Reconnecting...');
        } else {
          bot.sendMessage(chatId, 'Connection closed. Logged out.');
          removeFile(sessionDir);
        }
      } else if (connection === 'open') {
        await delay(5000);
        const credsPath = path.join(sessionDir, 'creds.json');
        const data = fs.readFileSync(credsPath);
        const b64data = Buffer.from(data).toString('base64');
        
        const successText = await fancyText('Success!');
        bot.sendMessage(chatId, successText, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, 'Here is your encoded session data:');
        bot.sendMessage(chatId, b64data);

        await delay(1000);
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
  bot.sendMessage(chatId, 'Generating QR code...');

  const id = makeid();
  const sessionDir = path.join(tempDir, id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
      browser: ['Chrome (Linux)', '', ''],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        const qrImage = await qrcode.toDataURL(qr);
        bot.sendPhoto(chatId, Buffer.from(qrImage.split(',')[1], 'base64'), { caption: 'Scan this QR code to pair' });
      } else if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          bot.sendMessage(chatId, 'Connection closed. Reconnecting...');
        } else {
          bot.sendMessage(chatId, 'Connection closed. Logged out.');
          removeFile(sessionDir);
        }
      } else if (connection === 'open') {
        await delay(5000);
        const credsPath = path.join(sessionDir, 'creds.json');
        const data = fs.readFileSync(credsPath);
        const b64data = Buffer.from(data).toString('base64');
        
        const successText = await fancyText('Success!');
        bot.sendMessage(chatId, successText, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, 'Here is your encoded session data:');
        bot.sendMessage(chatId, b64data);

        await delay(1000);
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

bot.on('polling_error', (error) => {
  console.error(error);
});

app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});