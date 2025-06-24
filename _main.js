const { RateLimiterMemory } = require('rate-limiter-flexible');
const LRU = require('lru-cache');

// Constants
const MAX_MESSAGE_LENGTH = 3000;
const MAX_DISCORD_MESSAGE_LENGTH = 1950;
const LOADING_MESSAGE = "🧅 OnionBot is translating...";
const ERROR_MESSAGE = "❗ OnionBot failed to translate. Please try again.";
const LENGTH_WARNING_MESSAGE = "⚠️ The message is too long. Please keep it under 3000 characters.";
const RATE_LIMIT_POINTS = 5;
const RATE_LIMIT_DURATION = 1;
const RETRY_DELAY_MS = 5000;
const MAX_RETRY_ATTEMPTS = 2;
const LOADING_FRAMES = [
    "🧅 Translating ░░░░░░░░░░",
    "🧅 Translating ▓░░░░░░░░░",
    "🧅 Translating ▓▓░░░░░░░░",
    "🧅 Translating ▓▓▓░░░░░░░",
    "🧅 Translating ▓▓▓▓░░░░░░",
    "🧅 Translating ▓▓▓▓▓░░░░░",
    "🧅 Translating ▓▓▓▓▓▓░░░░",
    "🧅 Translating ▓▓▓▓▓▓▓░░░",
    "🧅 Translating ▓▓▓▓▓▓▓▓░░",
    "🧅 Translating ▓▓▓▓▓▓▓▓▓░",
    "🧅 Translating ▓▓▓▓▓▓▓▓▓▓"
];
const LOADING_INTERVAL_MS = 500;

const rateLimiter = new RateLimiterMemory({
    points: RATE_LIMIT_POINTS,
    duration: RATE_LIMIT_DURATION,
});

const options = { 
  max: 500, 
  maxAge: 1000 * 60 * 60,
  length(n, key) { return 1 }, 
  dispose(key, n) { /* 데이터가 삭제된 후 호출 */ }
};

const messageCache = new LRU(options);

const messageQueue = [];
let isProcessingQueue = false;

function enqueueMessage(message) {
    messageQueue.push(message);
    if (!isProcessingQueue) {
        processQueue();
    }
}

async function processQueue() {
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
        const message = messageQueue.shift();
        await handleMessage(message);
    }
    isProcessingQueue = false;
}

async function handleMessage(message) {
    if (needShutdown) return;
    if (message.author.bot) {
        if (message.author.id === discordClient.user.id) {
            thisBotMessages.add(message.id);
        }
        return;
    }

    try {
        await rateLimiter.consume(message.author.id);
    } catch {
        return; // Rate limit exceeded
    }

    if (message.content.length >= MAX_MESSAGE_LENGTH) {
        await message.reply(LENGTH_WARNING_MESSAGE);
        return;
    }

    if (!isTranslatableText(message.content)) {
        console.log(`Skipped non-translatable message from ${message.author.username}: "${message.content}"`);
        return;
    }

    usernames[message.author.id] = message.author.username;
    messageCache.set(message.id, {
        id: message.id,
        referenceMessageId: message.reference?.messageId ?? null,
        time: message.createdTimestamp,
        authorName: message.author.username,
        text: message.content,
    });

    console.log('At ', new Date(message.createdTimestamp), '. Message from user ', message.author.displayName,
        '. Text: ', message.content);

    let loadingMessage;
    let loadingAnimation;

    try {
        loadingMessage = await message.reply(LOADING_FRAMES[0]);
        let frameIndex = 1;
        loadingAnimation = setInterval(() => {
            if (!loadingMessage.editable) return;
            loadingMessage.edit(LOADING_FRAMES[frameIndex % LOADING_FRAMES.length]);
            frameIndex++;
        }, LOADING_INTERVAL_MS);
    } catch (e) {
        console.warn("Failed to send loading message (possibly due to missing message context):", e);
        const retryCount = message.retryCount || 0;
        if (retryCount < MAX_RETRY_ATTEMPTS) {
            const retryMessage = Object.assign({}, message, { retryCount: retryCount + 1 });
            setTimeout(() => enqueueMessage(retryMessage), RETRY_DELAY_MS);
        } else {
            console.warn("Maximum retry attempts reached. Message skipped:", message.id);
        }
        return;
    }

    try {
        const response = await generateResponse(message.id, message.channelId, OPENAI_API_KEY);

        if (response.length <= MAX_DISCORD_MESSAGE_LENGTH) {
            clearInterval(loadingAnimation);
            await loadingMessage.edit(response);
            thisBotMessages.add(loadingMessage.id);
        } else {
            let responseLeft = response;
            let prevMessage = loadingMessage;
            clearInterval(loadingAnimation);
            await prevMessage.edit(responseLeft.substring(0, MAX_DISCORD_MESSAGE_LENGTH));
            responseLeft = responseLeft.substring(MAX_DISCORD_MESSAGE_LENGTH);

            while (responseLeft !== '') {
                const s = responseLeft.substring(0, MAX_DISCORD_MESSAGE_LENGTH);
                const newMessage = await message.reply(s);
                thisBotMessages.add(newMessage.id);
                responseLeft = responseLeft.substring(MAX_DISCORD_MESSAGE_LENGTH);
                prevMessage = newMessage;
            }
        }
    } catch (err) {
        console.error('Translation failed:', err);
        clearInterval(loadingAnimation);
        await loadingMessage.edit(ERROR_MESSAGE);
    }
}

discordClient.on('messageCreate', async (message) => {
    enqueueMessage(message);
});

discordClient.on('messageUpdate', async (oldMessage, newMessage) => {
    const message = newMessage.partial ? oldMessage : newMessage;
    if (!message || message.partial || !message.content) return;
    enqueueMessage(message);
});