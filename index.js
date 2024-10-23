const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const figlet = require('figlet');
const axios = require('axios');
const FormData = require('form-data');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Telegram Bot
const TOKEN = '7740666373:AAEZxNT8vpNx1il_GUAf9qYxRCHl0ow97zQ';
const bot = new TelegramBot(TOKEN, { polling: true });

// Constants
const MAX_RETRY_ATTEMPTS = 2;
const API_ENDPOINT = 'https://kord-ai-db.onrender.com/api/upload-file';

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
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        
        try {
            const response = await axios.post(API_ENDPOINT, formData, {
                headers: formData.getHeaders()
            });
            return response.data;
        } catch (error) {
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    static async getBase64Creds(filePath) {
        try {
            const credsData = fs.readFileSync(filePath, 'utf8');
            return Buffer.from(credsData).toString('base64');
        } catch (error) {
            throw new Error(`Base64 conversion failed: ${error.message}`);
        }
    }
}

// Message Templates
const messages = {
    welcome: `
🤖 *Welcome to KORD-AI PAIRING BOT* 🤖

Available Commands:
📱 /pair - Start phone number pairing
📷 /qr - Get QR code for pairing
❓ /help - Show help message

Choose a method to start pairing your WhatsApp!
    `,
    
    help: `
*KORD-AI PAIRING BOT HELP*

Available Commands:
1. /start - Start the bot
2. /pair - Begin phone number pairing
3. /qr - Get QR code for pairing
4. /help - Show this help message

*Pairing Methods:*
• *Phone Number:* Use /pair and follow the prompts
• *QR Code:* Use /qr to receive a scannable QR code

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
            bot.sendMessage(this.chatId, '🔄 Generating pairing code...');
            const client = await this.initializeClient();
            
            if (!client.authState.creds.registered) {
                await delay(1500);
                const code = await client.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                bot.sendMessage(this.chatId, `🔑 Your pairing code is: *${code}*`, { parse_mode: 'Markdown' });
            }

            this.setupConnectionHandler(client, phoneNumber);
        } catch (error) {
            console.error('Phone pairing error:', error);
            bot.sendMessage(this.chatId, '❌ An error occurred. Please try again later.');
            Utils.removeFile(this.sessionDir);
        }
    }

    async handleQRPairing() {
        try {
            bot.sendMessage(this.chatId, '🔄 Generating QR code...');
            const client = await this.initializeClient();
            this.setupQRHandler(client);
        } catch (error) {
            console.error('QR pairing error:', error);
            bot.sendMessage(this.chatId, '❌ An error occurred. Please try again later.');
            Utils.removeFile(this.sessionDir);
        }
    }

    setupConnectionHandler(client, phoneNumber) {
        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    await delay(5000);
                    await this.handlePhonePairing(phoneNumber);
                } else {
                    bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair or /qr');
                    Utils.removeFile(this.sessionDir);
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection(client);
            }
        });
    }

    setupQRHandler(client) {
        client.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    bot.sendPhoto(this.chatId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                        caption: '📱 Scan this QR code in WhatsApp'
                    });
                } catch (error) {
                    console.error('QR generation error:', error);
                    bot.sendMessage(this.chatId, '❌ Error generating QR code. Please try again.');
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection(client);
            } else if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    await delay(5000);
                    await this.handleQRPairing();
                } else {
                    bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair or /qr');
                    Utils.removeFile(this.sessionDir);
                }
            }
        });
    }

    async handleSuccessfulConnection(client) {
        try {
            // Add delay to ensure credentials are saved
            await delay(3000);
            
            const credsPath = path.join(this.sessionDir, 'creds.json');
            
            // Check if credentials file exists
            if (!fs.existsSync(credsPath)) {
                await delay(2000);
                if (!fs.existsSync(credsPath)) {
                    throw new Error('Credentials file not found');
                }
            }

            try {
                // Get Session ID
                const base64Creds = await Utils.getBase64Creds(credsPath);
                const sessionIdMessage = `Your Session ID:\n${base64Creds}`;
                
                // Send to both platforms
                await client.sendMessage(client.user.id, { text: sessionIdMessage });
                await bot.sendMessage(this.chatId, `Your Session ID:\n\`\`\`${base64Creds}\`\`\``, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Error getting session ID:', error);
                await bot.sendMessage(this.chatId, '❌ Error generating Session ID. Please use the button below to try again.');
            }
            
            try {
                // Get Bot ID
                const uploadResult = await Utils.uploadToServer(credsPath);
                const botIdMessage = `Your Bot ID: ${uploadResult.fileId}`;
                
                // Send to both platforms
                await client.sendMessage(client.user.id, { text: botIdMessage });
                await bot.sendMessage(this.chatId, `Your Bot ID: \`${uploadResult.fileId}\``, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Error getting bot ID:', error);
                await bot.sendMessage(this.chatId, '❌ Error generating Bot ID. Please use the button below to try again.');
            }
            
            // Send success messages to both platforms
            await client.sendMessage(client.user.id, { text: messages.success });
            await bot.sendMessage(this.chatId, messages.success, { parse_mode: 'Markdown' });
            
            // Send session options buttons (Telegram only)
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Get Session ID', callback_data: 'session_id' },
                        { text: 'Get Bot ID', callback_data: 'bot_id' }
                    ]
                ]
            };
            
            bot.sendMessage(this.chatId, 'Choose how you want to receive your session:', {
                reply_markup: keyboard
            });

            // Store session info
            userStates.set(this.chatId, { sessionDir: this.sessionDir });
        } catch (error) {
            console.error('Success message error:', error);
            await bot.sendMessage(this.chatId, '❌ Connection successful but error in generating credentials. Please try again with /pair or /qr');
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

bot.onText(/\/qr/, async (msg) => {
    const chatId = msg.chat.id;
    const sessionDir = path.join(tempDir, Utils.generateRandomId());
    const handler = new WhatsAppHandler(chatId, sessionDir);
    await handler.handleQRPairing();
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

// Callback Query Handler
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;
    const state = userStates.get(chatId);
    
    if (!state?.sessionDir) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Session not found. Please reconnect.' });
    }

    const credsPath = path.join(state.sessionDir, 'creds.json');
    
    try {
        let response;
        if (action === 'session_id') {
            const base64Creds = await Utils.getBase64Creds(credsPath);
            response = `Your session ID:\n\`\`\`${base64Creds}\`\`\``;
        } else if (action === 'bot_id') {
            const uploadResult = await Utils.uploadToServer(credsPath);
            response = `Your Bot ID: \`${uploadResult.fileId}\``;
        }

        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Session handling error:', error);
        await bot.sendMessage(chatId, '❌ Error processing your request. Please try again.');
    } finally {
        userStates.delete(chatId);
        Utils.removeFile(state.sessionDir);
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
