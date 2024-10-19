const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

// Replace with your actual Telegram bot token
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

const userStates = {};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to KORD-AI - PAIRING');
  bot.sendMessage(chatId, 'Use /pair to start the pairing process or /qr to get a QR code.');
});

bot.onText(/\/pair/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = 'awaitingPhoneNumber';
  bot.sendPhoto(chatId, 'https://files.catbox.moe/g4q04p.png', {
    caption: 'Please enter your phone number with country code (e.g., +1234567890):'
  });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  if (userStates[chatId] === 'awaitingPhoneNumber') {
    const phoneNumber = msg.text;

    if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
      return bot.sendMessage(chatId, 'Please send a valid phone number with country code.');
    }

    userStates[chatId] = null;
    bot.sendMessage(chatId, 'Generating pairing code...');

    const id = makeid();
    const sessionDir = path.join(tempDir, id);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
      });

      sock.ev.on('creds.update', saveCreds);

      if (!sock.authState.creds.registered) {
        await delay(1500);
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        bot.sendMessage(chatId, `Your pairing code is: ${code}`);
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
          
          const Kordtext = `
┏━━━━━━
┃𝑲𝒐𝒓𝒅 𝑨𝒊 𝑰𝒔 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅! ,✅🤖
┗━━━━━━
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
_Use the Session Id To Deploy Your Bot, Add the Session id to The SESSION_ID variable in config.js_

Repo link: *https://github.com/M3264/Kord-Ai*
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
❷ || WhattsApp Channel = https://whatsapp.com/channel/0029VaghjWRHVvTh35lfZ817
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
> © ɪɴᴛᴇʟʟɪɢᴇɴᴄᴇ ʙʏ ᴋᴏʀᴅ ɪɴᴄ³²¹™
_Don't Forget To Give Star To My Repo_`;

          // Send messages to WhatsApp
          await sock.sendMessage(sock.user.id, { text: 'Success! Your session is connected.' });
          await sock.sendMessage(sock.user.id, { text: 'Here is your encoded session data:' });
          await sock.sendMessage(sock.user.id, { text: b64data });
          await sock.sendMessage(sock.user.id, { text: Kordtext });

          // Send messages to Telegram
          bot.sendMessage(chatId, 'Success!');
          bot.sendMessage(chatId, 'Here is your encoded session data:');
          bot.sendMessage(chatId, b64data);
          bot.sendMessage(chatId, Kordtext);

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
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
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
        
        const Kordtext = `
┏━━━━━━
┃𝑲𝒐𝒓𝒅 𝑨𝒊 𝑰𝒔 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅! ,✅🤖
┗━━━━━━
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
_Use the Session Id To Deploy Your Bot, Add the Session id to The SESSION_ID variable in config.js_

Repo link: *https://github.com/M3264/Kord-Ai*
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
❷ || WhattsApp Channel = https://whatsapp.com/channel/0029VaghjWRHVvTh35lfZ817
▬▬▬▬▬▬▬▬▬▬▬▬▬▬
> © ɪɴᴛᴇʟʟɪɢᴇɴᴄᴇ ʙʏ ᴋᴏʀᴅ ɪɴᴄ³²¹™
_Don't Forget To Give Star To My Repo_`;

        // Send messages to WhatsApp
        await sock.sendMessage(sock.user.id, { text: 'Success! Your session is connected.' });
        await sock.sendMessage(sock.user.id, { text: 'Here is your encoded session data:' });
        await sock.sendMessage(sock.user.id, { text: b64data });
        await sock.sendMessage(sock.user.id, { text: Kordtext });

        // Send messages to Telegram
        bot.sendMessage(chatId, 'Success!');
        bot.sendMessage(chatId, 'Here is your encoded session data:');
        bot.sendMessage(chatId, b64data);
        bot.sendMessage(chatId, Kordtext);

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
