const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { KordAi, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } = require("maher-zubair-baileys");
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const axios = require('axios');

// Initialize Telegram bot
const bot = new TelegramBot('7740666373:AAEZxNT8vpNx1il_GUAf9qYxRCHl0ow97zQ', { polling: true });

// Express setup
const app = express();
const PORT = process.env.PORT || 3000;

// Setup temp directory
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Utility functions
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

// Bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to KORD-AI - PAIRING');
  bot.sendMessage(chatId, 'Use /pair to start the pairing process.');
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
    await handleKordAiPairing(chatId, phoneNumber);
  }
});

async function handleKordAiPairing(chatId, phoneNumber) {
  bot.sendMessage(chatId, 'Generating pairing code...');
  const id = makeid();
  const sessionDir = path.join(tempDir, id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let KordAiClient = KordAi({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
      },
      printQRInTerminal: false,
      logger: pino({ level: "fatal" }).child({ level: "fatal" }),
      browser: ["Chrome (Linux)", "", ""],
    });

    if (!KordAiClient.authState.creds.registered) {
      await delay(1500);
      const code = await KordAiClient.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      bot.sendMessage(chatId, `Your pairing code is: ${code}`);
    }

    KordAiClient.ev.on('creds.update', saveCreds);
    
    KordAiClient.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === "open") {
        await delay(5000);
        const credsPath = path.join(sessionDir, 'creds.json');
        const data = fs.readFileSync(credsPath);

        try {
          // Upload creds to API
          const { data: apiResponse } = await axios.post('https://kord-ai-db.onrender.com/api/upload-creds', data, {
            headers: {
              'Content-Type': 'application/json'
            }
          });

          const Kordtext = `
┏━━━━━━❖❖❖❖
┃*KordAi Session has been registered to KordAi database✅🔥*
┃\`\`\`Your bot ID: ${apiResponse.botId}\`\`\`
┗━━━━━━❖❖❖❖

❖━━━━━━━━❖━━━━━━━━━❖
> WhattsApp Channel
  https://whatsapp.com/channel/0029VaghjWRHVvTh35lfZ817
❖━━━━━━━━━━━━━━━━━━❖
\`\`\` Wanna talk to me?\n👉 https://t.me/korretdesigns 👈 \`\`\`
❖━━━━━━━━❖━━━━━━━━━❖

_Don't Forget To Give Star To My Repo_`;

          // Send success messages
          await KordAiClient.sendMessage(KordAiClient.user.id, { text: 'Success! Your session is connected.' });
          await KordAiClient.sendMessage(KordAiClient.user.id, { text: Kordtext });

          // Send Telegram messages
          bot.sendMessage(chatId, 'Success! Your session has been registered.');
          bot.sendMessage(chatId, `Your bot ID: ${apiResponse.botId}`);
          bot.sendMessage(chatId, Kordtext);

        } catch (err) {
          console.error('Error uploading creds:', err);
          bot.sendMessage(chatId, 'Error uploading credentials. Please try again.');
        }

        await delay(1000);
        await KordAiClient.ws.close();
        removeFile(sessionDir);
        
      } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode != 401) {
        bot.sendMessage(chatId, 'Connection closed. Reconnecting...');
        await delay(10000);
        handleKordAiPairing(chatId, phoneNumber);
      }
    });

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    removeFile(sessionDir);
  }
}

// Error handling
bot.on('polling_error', (error) => {
  console.error(error);
});

// Express routes
app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
