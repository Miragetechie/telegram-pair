const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const figlet = require('figlet');
const axios = require('axios');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Telegram Bot
const TOKEN = '7959549272:AAE6yg3a5EHa_qS-7zf5V7he8yk_x8_7Z1U';
const bot = new TelegramBot(TOKEN, { polling: true });

// Constants
const MAX_RETRY_ATTEMPTS = 2;

// Setup directories
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// State management
const userStates = new Map();

// Display startup message
console.log(figlet.textSync('KORD-AI BOT', {
    font: 'Standard',
    horizontalLayout: 'default',
    verticalLayout: 'default'
}));
console.log('\nKORD-AI Pairing Bot Started Successfully!');

// Message Templates
const messages = {
    welcome: `
🤖 *Welcome to KORD-AI PAIRING BOT* 🤖

Available Commands:
📱 /pair - Start phone number pairing
❓ /help - Show help message

Start pairing your WhatsApp with /pair
    `,
    
    help: `
*KORD-AI PAIRING BOT HELP*

Available Commands:
1. /start - Start the bot
2. /pair - Begin phone number pairing
3. /help - Show this help message

*Pairing Method:*
• *Phone Number:* Use /pair and follow the prompts

*Need Support?*
Join our channel: https://whatsapp.com/channel/0029VaghjWRHVvTh35lfZ817

_For more assistance, visit our GitHub repository._
    `,
    
    success: `
┏━━━━━━❖❖❖❖
┃ *KORD-AI Connection Successful!* ✅
┗━━━━━━❖❖❖❖

❖━━━━━━━━❖━━━━━━━━━❖
> *Join Our Channel*
https://whatsapp.com/channel/0029VaghjWRHVvTh35lfZ817
❖━━━━━━━━━━━━━━━━━━❖

Contact: https://t.me/korretdesigns
❖━━━━━━━━❖━━━━━━━━━❖
    `
};

// Utility Functions
class Utils {
    static generateRandomId(length = 6) {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from({ length }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
    }

    static removeFile(filePath) {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
            return true;
        }
        return false;
    }

    static async uploadToServer(filePath) {
        try {
            const fileContent = await fs.promises.readFile(filePath, 'utf8');
            const jsonData = JSON.parse(fileContent);
            
            const response = await axios.post('https://kordai-dash.vercel.app/api/files/upload-creds', jsonData, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-Key': 'kordAi.key'
                }
            });

            if (response.data?.status === 'success' && response.data?.data) {
                return {
                    fileId: response.data.data.fileId,
                    filename: response.data.data.filename,
                    size: response.data.data.size,
                    checksum: response.data.data.checksum,
                    uploadedAt: response.data.data.uploadedAt
                };
            }
            throw new Error('Invalid response format from server');
        } catch (error) {
            console.error('Upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }
}

// WhatsApp Connection Handler
class WhatsAppHandler {
    constructor(chatId, sessionDir) {
        this.chatId = chatId;
        this.sessionDir = sessionDir;
        this.retryCount = 0;
    }

    async initializeClient() {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        
        const client = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        client.ev.on('creds.update', saveCreds);
        return client;
    }

    async handlePhonePairing(phoneNumber) {
        try {
            await bot.sendMessage(this.chatId, '🔄 Generating pairing code...');
            const client = await this.initializeClient();
            
            if (!client.authState.creds.registered) {
                await delay(1500);
                const formattedPhone = phoneNumber.replace(/[^0-9]/g, '');
                const code = await client.requestPairingCode(formattedPhone);
                await bot.sendMessage(this.chatId, `🔑 Your pairing code is: *${code}*`, { parse_mode: 'Markdown' });
            }

            this.setupConnectionHandler(client);
        } catch (error) {
            console.error('Phone pairing error:', error);
            await bot.sendMessage(this.chatId, '❌ An error occurred. Please try again with /pair');
            Utils.removeFile(this.sessionDir);
        }
    }

    setupConnectionHandler(client) {
        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    await bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    await delay(5000);
                    await this.handlePhonePairing(this.phoneNumber);
                } else {
                    await bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair');
                    Utils.removeFile(this.sessionDir);
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection(client);
            }
        });
    }

    async handleSuccessfulConnection(client) {
        try {
            await delay(3000);
            const credsPath = path.join(this.sessionDir, 'creds.json');
            
            if (!fs.existsSync(credsPath)) {
                await delay(2000);
                if (!fs.existsSync(credsPath)) {
                    throw new Error('Credentials file not found');
                }
            }

            try {
                const uploadResult = await Utils.uploadToServer(credsPath);
                const botIdMessage = `Your Bot ID: \`${uploadResult.fileId}\``;
                
                await client.sendMessage(client.user.id, { text: `Your Bot ID: ${uploadResult.fileId}` });
                await bot.sendMessage(this.chatId, botIdMessage, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Error getting bot ID:', error);
                await bot.sendMessage(this.chatId, '❌ Error generating Bot ID. Please try again with /pair');
            }
            
            await client.sendMessage(client.user.id, { text: messages.success });
            await bot.sendMessage(this.chatId, messages.success, { parse_mode: 'Markdown' });

            userStates.set(this.chatId, { sessionDir: this.sessionDir });
        } catch (error) {
            console.error('Success message error:', error);
            await bot.sendMessage(this.chatId, '❌ Connection successful but error in generating credentials. Please try again with /pair');
            Utils.removeFile(this.sessionDir);
        }
    }
}

// Bot Command Handlers
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.help, { parse_mode: 'Markdown' });
});

bot.onText(/\/pair/, (msg) => {
    const chatId = msg.chat.id;
    userStates.set(chatId, { awaitingPhoneNumber: true });
    bot.sendMessage(chatId, '📱 Please enter your phone number with country code (e.g., +1234567890):');
});

// Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);
    
    if (state?.awaitingPhoneNumber) {
        const phoneNumber = msg.text;
        
        if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
            return bot.sendMessage(chatId, '❌ Please send a valid phone number with country code.');
        }

        userStates.delete(chatId);
        const sessionDir = path.join(tempDir, Utils.generateRandomId());
        const handler = new WhatsAppHandler(chatId, sessionDir);
        await handler.handlePhonePairing(phoneNumber);
    }
});

// Error Handler
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Express Routes
app.get('/', (req, res) => {
    res.send('KORD-AI Telegram Bot is running! 🤖');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
