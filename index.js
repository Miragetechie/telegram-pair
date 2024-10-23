const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { KordAi } = require("maher-zubair-baileys");
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
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Setup directories
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// State management
const userStates = new Map();
const activeSessions = new Map();

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

    static isUserInSession(chatId) {
        return activeSessions.has(chatId);
    }

    static startUserSession(chatId) {
        if (this.isUserInSession(chatId)) {
            return false;
        }
        
        activeSessions.set(chatId, setTimeout(() => {
            this.endUserSession(chatId);
        }, SESSION_TIMEOUT));
        
        return true;
    }

    static endUserSession(chatId) {
        const timeoutId = activeSessions.get(chatId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeSessions.delete(chatId);
        }
        
        const state = userStates.get(chatId);
        if (state?.sessionDir) {
            this.removeFile(state.sessionDir);
            userStates.delete(chatId);
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
🔄 /cancel - Cancel current session

Choose a method to start pairing your WhatsApp!
    `,
    
    help: `
*KORD-AI PAIRING BOT HELP*

Available Commands:
1. /start - Start the bot
2. /pair - Begin phone number pairing
3. /qr - Get QR code for pairing
4. /help - Show this help message
5. /cancel - Cancel current session

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
        this.client = null;
    }

    async initializeClient() {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        
        this.client = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        this.client.ev.on('creds.update', saveCreds);
        return this.client;
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

            this.setupConnectionHandler(client);
        } catch (error) {
            console.error('Phone pairing error:', error);
            bot.sendMessage(this.chatId, '❌ An error occurred. Please try again later.');
            this.cleanup();
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
            this.cleanup();
        }
    }

    setupConnectionHandler(client) {
        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    await delay(5000);
                    await this.initializeClient();
                } else {
                    bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair or /qr');
                    this.cleanup();
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection();
            }
        });
    }

    setupQRHandler(client) {
        let qrAttempts = 0;
        const MAX_QR_ATTEMPTS = 3;
        
        client.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                if (qrAttempts >= MAX_QR_ATTEMPTS) {
                    bot.sendMessage(this.chatId, '❌ QR code scanning timeout. Please try again with /qr');
                    this.cleanup();
                    return;
                }

                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    bot.sendPhoto(this.chatId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                        caption: `📱 Scan this QR code in WhatsApp (Attempt ${qrAttempts + 1}/${MAX_QR_ATTEMPTS})`
                    });
                    qrAttempts++;
                } catch (error) {
                    console.error('QR generation error:', error);
                    bot.sendMessage(this.chatId, '❌ Error generating QR code. Please try again.');
                    this.cleanup();
                }
            } else if (connection === 'open') {
                await this.handleSuccessfulConnection();
            } else if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    await delay(5000);
                    await this.initializeClient();
                } else {
                    bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair or /qr');
                    this.cleanup();
                }
            }
        });
    }

    async handleSuccessfulConnection() {
        try {
            // Get session credentials
            const credsPath = path.join(this.sessionDir, 'creds.json');
            const base64Creds = await Utils.getBase64Creds(credsPath);
            const uploadResult = await Utils.uploadToServer(credsPath);

            // Prepare credential messages
            const sessionIdMessage = `\`\`\`${base64Creds}\`\`\``;
            const botIdMessage = `\`\`\`${uploadResult.fileId}\`\`\``;
            const securityNote = "_Keep these credentials safe and don't share them with anyone!_";

            // Send to WhatsApp
            if (this.client) {
                // Send success message
                await this.client.sendMessage(this.client.user.id, { 
                    text: messages.success
                });
                
                // Send session ID
                await this.client.sendMessage(this.client.user.id, { 
                    text: sessionIdMessage
                });
                
                // Send bot ID
                await this.client.sendMessage(this.client.user.id, { 
                    text: botIdMessage
                });
                
                // Send security note
                await this.client.sendMessage(this.client.user.id, { 
                    text: securityNote
                });
            }

            // Send to Telegram with proper formatting
            // Success message
            await bot.sendMessage(this.chatId, messages.success, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
            
            // Session ID
            await bot.sendMessage(this.chatId, sessionIdMessage, { 
                parse_mode: 'Markdown'
            });
            
            // Bot ID
            await bot.sendMessage(this.chatId, botIdMessage, { 
                parse_mode: 'Markdown'
            });
            
            // Security note
            await bot.sendMessage(this.chatId, securityNote, { 
                parse_mode: 'Markdown'
            });
            
            // Cleanup
            this.cleanup();
        } catch (error) {
            console.error('Success message error:', error);
            bot.sendMessage(this.chatId, '❌ Error sending success message. Please check your WhatsApp.');
            this.cleanup();
        }
    }

    cleanup() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }
        Utils.removeFile(this.sessionDir);
    }
} // End of WhatsAppHandler class


// Bot Command Handlers
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, messages.help, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (Utils.isUserInSession(chatId)) {
        Utils.endUserSession(chatId);
        bot.sendMessage(chatId, '✅ Session cancelled successfully. You can start a new session with /pair or /qr');
    } else {
        bot.sendMessage(chatId, '❌ No active session to cancel.');
    }
});

bot.onText(/\/pair/, (msg) => {
    const chatId = msg.chat.id;
    
    if (Utils.isUserInSession(chatId)) {
        return bot.sendMessage(chatId, '❌ You already have an active session. Please finish or cancel it first using /cancel');
    }

    if (Utils.startUserSession(chatId)) {
        userStates.set(chatId, { awaitingPhoneNumber: true });
        bot.sendMessage(chatId, '📱 Please enter your phone number with country code (e.g., +1234567890):');
    }
});

bot.onText(/\/qr/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (Utils.isUserInSession(chatId)) {
        return bot.sendMessage(chatId, '❌ You already have an active session. Please finish or cancel it first using /cancel');
    }

    if (Utils.startUserSession(chatId)) {
        const sessionDir = path.join(tempDir, Utils.generateRandomId());
        const handler = new WhatsAppHandler(chatId, sessionDir);
        await handler.handleQRPairing();
    }
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

// Cleanup interval for expired sessions
setInterval(() => {
    const now = Date.now();
    for (const [chatId, timeoutId] of activeSessions.entries()) {
        if (now - timeoutId > SESSION_TIMEOUT) {
            Utils.endUserSession(chatId);
            bot.sendMessage(chatId, '⏳ Session expired due to inactivity. Please start a new session with /pair or /qr');
        }
    }
}, 60000); // Check every minute

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\nCleaning up before exit...');
    
    // Clean up all active sessions
    for (const [chatId] of activeSessions.entries()) {
        Utils.endUserSession(chatId);
    }
    
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    console.log('Cleanup completed. Exiting...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Attempt to clean up and notify affected users
    for (const [chatId] of activeSessions.entries()) {
        bot.sendMessage(chatId, '❌ An unexpected error occurred. Please try again later.')
            .catch(console.error);
        Utils.endUserSession(chatId);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('Bot is ready to handle connections!');
});
