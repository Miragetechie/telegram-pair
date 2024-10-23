const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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
const API_ENDPOINT = 'https://kord-ai-db.onrender.com/api/upload-file';
const QR_TIMEOUT = 60000; // 1 minute
const MAX_QR_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 2;

// Setup directories
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
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
    `,

    credentials: (sessionId, botId) => `
🔐 *Your KORD-AI Bot Credentials*

1️⃣ *Session ID:*
\`\`\`
${sessionId}
\`\`\`

2️⃣ *Bot ID:*
\`${botId}\`

You can use either of these credentials to deploy your bot. 
Choose the method that works best for you!

Need help deploying? Type /help for guidance.
    `
};

// Utility Class
class BotUtils {
    static generateId(length = 6) {
        return Array.from(
            { length }, 
            () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
                Math.floor(Math.random() * 62)
            ]
        ).join('');
    }

    static cleanupSession(sessionPath) {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            return true;
        }
        return false;
    }

    static async getCredentials(credsPath) {
        try {
            // Get Session ID
            const credsData = fs.readFileSync(credsPath, 'utf8');
            const sessionId = Buffer.from(credsData).toString('base64');

            // Get Bot ID
            const formData = new FormData();
            formData.append('file', fs.createReadStream(credsPath));
            const response = await axios.post(API_ENDPOINT, formData, {
                headers: formData.getHeaders()
            });
            const botId = response.data.fileId;

            return { sessionId, botId };
        } catch (error) {
            throw new Error(`Failed to get credentials: ${error.message}`);
        }
    }

    static displayStartupMessage() {
        console.log(figlet.textSync('KORD-AI BOT', {
            font: 'Standard',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        }));
        console.log('\nKORD-AI Pairing Bot Started Successfully!');
    }
}

// WhatsApp Connection Handler
class WhatsAppConnection {
    constructor(chatId) {
        this.chatId = chatId;
        this.sessionDir = path.join(tempDir, BotUtils.generateId());
        this.qrAttempts = 0;
        this.retryCount = 0;
        this.whatsappClient = null;
    }

    async initialize() {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        
        const client = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        client.ev.on('creds.update', saveCreds);
        this.whatsappClient = client;
        return client;
    }

    async handleQRPairing() {
        try {
            await bot.sendMessage(this.chatId, '🔄 Generating QR code...');
            const client = await this.initialize();
            this.setupConnectionHandlers(client);
        } catch (error) {
            console.error('QR pairing error:', error);
            await bot.sendMessage(this.chatId, '❌ Error generating QR code. Please try again.');
            BotUtils.cleanupSession(this.sessionDir);
        }
    }

    async handlePhonePairing(phoneNumber) {
        try {
            await bot.sendMessage(this.chatId, '🔄 Generating pairing code...');
            const client = await this.initialize();
            
            if (!client.authState.creds.registered) {
                const code = await client.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                await bot.sendMessage(this.chatId, `🔑 Your pairing code is: *${code}*`, { parse_mode: 'Markdown' });
            }

            this.setupConnectionHandlers(client);
        } catch (error) {
            console.error('Phone pairing error:', error);
            await bot.sendMessage(this.chatId, '❌ Error generating pairing code. Please try again.');
            BotUtils.cleanupSession(this.sessionDir);
        }
    }

    setupConnectionHandlers(client) {
        let qrTimeout;

        client.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr && this.qrAttempts < MAX_QR_ATTEMPTS) {
                this.qrAttempts++;
                clearTimeout(qrTimeout);

                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    await bot.sendPhoto(this.chatId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                        caption: `📱 Scan this QR code in WhatsApp (Attempt ${this.qrAttempts}/${MAX_QR_ATTEMPTS})`
                    });

                    if (this.qrAttempts === MAX_QR_ATTEMPTS) {
                        qrTimeout = setTimeout(async () => {
                            if (!client.user) {
                                await bot.sendMessage(this.chatId, '❌ QR code scanning timeout. Please try again with /qr');
                                await client.end();
                                BotUtils.cleanupSession(this.sessionDir);
                            }
                        }, QR_TIMEOUT);
                    }
                } catch (error) {
                    console.error('QR generation error:', error);
                    await bot.sendMessage(this.chatId, '❌ Error generating QR code. Please try again.');
                }
            } else if (connection === 'open') {
                clearTimeout(qrTimeout);
                await this.handleSuccessfulConnection(client);
            } else if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.retryCount < MAX_RETRY_ATTEMPTS) {
                    this.retryCount++;
                    await bot.sendMessage(this.chatId, `🔄 Connection lost. Attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS} to reconnect...`);
                    setTimeout(async () => {
                        await this.handleQRPairing();
                    }, 5000);
                } else {
                    await bot.sendMessage(this.chatId, '❌ Connection failed. Please try again with /pair or /qr');
                    BotUtils.cleanupSession(this.sessionDir);
                }
            }
        });
    }

    async handleSuccessfulConnection(client) {
        try {
            // Send success message to both platforms
            await client.sendMessage(client.user.id, { text: messages.success });
            await bot.sendMessage(this.chatId, messages.success, { parse_mode: 'Markdown' });

            // Generate and send credentials
            const credsPath = path.join(this.sessionDir, 'creds.json');
            const { sessionId, botId } = await BotUtils.getCredentials(credsPath);
            const credentialsMessage = messages.credentials(sessionId, botId);

            // Send credentials to both platforms
            await bot.sendMessage(this.chatId, credentialsMessage, { parse_mode: 'Markdown' });
            await client.sendMessage(client.user.id, { text: credentialsMessage });

        } catch (error) {
            console.error('Connection success handling error:', error);
            await bot.sendMessage(this.chatId, '❌ Error processing connection. Please try again.');
        } finally {
            BotUtils.cleanupSession(this.sessionDir);
        }
    }
}

// Bot Command Handlers
bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id, messages.welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, messages.help, { parse_mode: 'Markdown' });
});

bot.onText(/\/qr/, async (msg) => {
    const handler = new WhatsAppConnection(msg.chat.id);
    await handler.handleQRPairing();
});

bot.onText(/\/pair/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📱 Please enter your phone number with country code (e.g., +1234567890):');
});

// Message Handler for Phone Number
bot.on('message', async (msg) => {
    if (msg.text && msg.text.match(/^\+?[1-9]\d{1,14}$/)) {
        const handler = new WhatsAppConnection(msg.chat.id);
        await handler.handlePhonePairing(msg.text);
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
    BotUtils.displayStartupMessage();
});
