const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
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
const MAX_QR_ATTEMPTS = 2;
const API_ENDPOINT = 'https://kord-ai-db.onrender.com/api/upload-file';

// Setup directories
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// State management
const userStates = new Map();
const activeConnections = new Set();

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
        const fileStream = fs.createReadStream(filePath);
        const fileName = path.basename(filePath);
        
        formData.append('file', fileStream, {
            filename: fileName,
            contentType: 'application/json'
        });
        
        try {
            const response = await axios.post(API_ENDPOINT, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Type': 'multipart/form-data'
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            
            if (response.data && response.data.fileId) {
                return {
                    fileId: response.data.fileId,
                    filename: response.data.filename
                };
            } else {
                throw new Error('Invalid response format from server');
            }
        } catch (error) {
            console.error('Upload error details:', error.response?.data || error.message);
            throw new Error(`Upload failed: ${error.response?.data?.error || error.message}`);
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

    static cleanupConnection(chatId) {
        const state = userStates.get(chatId);
        if (state?.sessionDir) {
            Utils.removeFile(state.sessionDir);
        }
        userStates.delete(chatId);
        activeConnections.delete(chatId);
    }
}

// WhatsApp Connection Handler
class WhatsAppHandler {
    constructor(chatId, sessionDir) {
        this.chatId = chatId;
        this.sessionDir = sessionDir;
        this.qrSentCount = 0;
        this.isActive = true;
        this.connectionTimeout = null;
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
        if (!this.isActive) return;

        try {
            bot.sendMessage(this.chatId, '🔄 Generating pairing code...');
            const client = await this.initializeClient();
            
            if (!client.authState.creds.registered) {
                await delay(1500);
                const code = await client.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                bot.sendMessage(this.chatId, `🔑 Your pairing code is: *${code}*`, { parse_mode: 'Markdown' });
            }

            this.setupConnectionHandler(client);
            this.startConnectionTimeout();
        } catch (error) {
            console.error('Phone pairing error:', error);
            if (this.isActive) {
                bot.sendMessage(this.chatId, '❌ An error occurred. Please try again later.');
                this.cleanup();
            }
        }
    }

    async handleQRPairing() {
        if (!this.isActive) return;

        try {
            bot.sendMessage(this.chatId, '🔄 Generating QR code...');
            const client = await this.initializeClient();
            this.setupQRHandler(client);
            this.startConnectionTimeout();
        } catch (error) {
            console.error('QR pairing error:', error);
            if (this.isActive) {
                bot.sendMessage(this.chatId, '❌ An error occurred. Please try again later.');
                this.cleanup();
            }
        }
    }

    setupQRHandler(client) {
        if (!this.isActive) return;

        client.ev.on('connection.update', async (update) => {
            if (!this.isActive) return;

            const { connection, qr } = update;

            if (qr) {
                if (this.qrSentCount >= MAX_QR_ATTEMPTS) {
                    if (this.isActive) {
                        await bot.sendMessage(this.chatId, '❌ QR code limit reached. Please use /qr to request a new session.');
                        this.cleanup();
                    }
                    return;
                }

                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    if (this.isActive) {
                        await bot.sendPhoto(this.chatId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                            caption: `📱 Scan this QR code in WhatsApp (Attempt ${this.qrSentCount + 1}/${MAX_QR_ATTEMPTS})`
                        });
                        this.qrSentCount++;
                    }
                } catch (error) {
                    console.error('QR generation error:', error);
                    if (this.isActive) {
                        await bot.sendMessage(this.chatId, '❌ Error generating QR code. Please try again.');
                        this.cleanup();
                    }
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection(client);
            } else if (connection === 'close') {
                if (this.isActive) {
                    await bot.sendMessage(this.chatId, '❌ Connection closed. Please try again with /qr');
                    this.cleanup();
                }
            }
        });
    }

    setupConnectionHandler(client) {
        if (!this.isActive) return;

        client.ev.on('connection.update', async (update) => {
            if (!this.isActive) return;

            const { connection } = update;

            if (connection === 'open') {
                await this.handleSuccessfulConnection(client);
            } else if (connection === 'close') {
                if (this.isActive) {
                    await bot.sendMessage(this.chatId, '❌ Connection closed. Please try again.');
                    this.cleanup();
                }
            }
        });
    }

    async handleSuccessfulConnection(client) {
        if (!this.isActive) return;

        try {
            const credsPath = path.join(this.sessionDir, 'creds.json');
            
            // Get session ID
            const base64Creds = await Utils.getBase64Creds(credsPath);
            
            let botId = '';
            try {
                // Try to upload and get bot ID
                const uploadResult = await Utils.uploadToServer(credsPath);
                botId = uploadResult.fileId;
            } catch (uploadError) {
                console.error('Upload error:', uploadError);
            }

            // Prepare credentials message
            let credentialsMessage = `*Your KORD-AI Bot Credentials*\n\n`;
            credentialsMessage += `*Session ID:*\n\`\`\`${base64Creds}\`\`\`\n\n`;
            
            if (botId) {
                credentialsMessage += `*Bot ID:*\n\`${botId}\`\n\n`;
                credentialsMessage += `_You can use either of these credentials to deploy your bot._\n\n`;
            } else {
                credentialsMessage += `_Use this Session ID to deploy your bot._\n\n`;
            }
            
            credentialsMessage += messages.success;

            // Send messages
            await client.sendMessage(client.user.id, { text: credentialsMessage });
            await bot.sendMessage(this.chatId, messages.success, { parse_mode: 'Markdown' });
            await bot.sendMessage(this.chatId, 'ℹ️ Your credentials have been sent to your WhatsApp. Please check your messages.');
        } catch (error) {
            console.error('Success message error:', error);
            if (this.isActive) {
                await bot.sendMessage(this.chatId, '❌ Error sending credentials. Please check your WhatsApp for the message.');
            }
        } finally {
            this.cleanup();
        }
    }

    startConnectionTimeout() {
        this.connectionTimeout = setTimeout(() => {
            if (this.isActive) {
                bot.sendMessage(this.chatId, '❌ Connection timeout. Please try again.');
                this.cleanup();
            }
        }, 180000); // 3 minutes timeout
    }

    cleanup() {
        this.isActive = false;
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
        }
        Utils.cleanupConnection(this.chatId);
    }
}

// Command Handlers
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.help, { parse_mode: 'Markdown' });
});

bot.onText(/\/pair/, (msg) => {
    const chatId = msg.chat.id;
    
    if (activeConnections.has(chatId)) {
        return bot.sendMessage(chatId, '❌ You have an active pairing session. Please wait for it to complete or try again later.');
    }

    activeConnections.add(chatId);
    userStates.set(chatId, { awaitingPhoneNumber: true });
    bot.sendMessage(chatId, '📱 Please enter your phone number with country code (e.g., +1234567890):');
});

bot.onText(/\/qr/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (activeConnections.has(chatId)) {
        return bot.sendMessage(chatId, '❌ You have an active pairing session. Please wait for it to complete or try again later.');
    }

    activeConnections.add(chatId);
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
