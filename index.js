const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Replace 'YOUR_BOT_TOKEN' with your actual Telegram bot token
const bot = new TelegramBot('7959549272:AAE6yg3a5EHa_qS-7zf5V7he8yk_x8_7Z1U', { polling: true });

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

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome! Please send your phone number to get a pairing code.');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const phoneNumber = msg.text;

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
      bot.sendMessage(chatId, `Your pairing code is: ${code}`);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        await delay(5000);
        const credsPath = path.join(sessionDir, 'creds.json');
        const data = fs.readFileSync(credsPath);
        const b64data = Buffer.from(data).toString('base64');
        
        bot.sendMessage(chatId, 'Connection successful! Here is your encoded session data:');
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