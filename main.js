require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const { OpenAI } = require('openai');
const { LRUCache } = require('lru-cache');

// Constants
const MAX_MESSAGE_LENGTH = 3000;
const ERROR_MESSAGE = "❗ OnionBot failed to translate. Please try again.";
const LENGTH_WARNING_MESSAGE = "⚠️ The message is too long. Please keep it under 3000 characters.";
const SYSTEM_PROMPT = process.env.GPT_PROMPT;
const NOT_TRANSLATABLE_KEYWORD = "not translatable";

// Loading animation frames
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
const MAX_LOADING_DURATION_MS = 10000;

// Initialize Discord client
const discordClient = new Client({
  partials: [Partials.Channel, Partials.Message],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ]
});

// Initialize OpenAI client
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LRU cache for messages
const messageCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 });

let botName;
const thisBotMessages = new Set();
const processedMessages = new Set();
const originalToReplyMap = new Map();

function isTranslatableText(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^[\p{Emoji_Presentation}\p{Punctuation}\s]+$/u.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

// On ready event
discordClient.on('ready', () => {
  botName = discordClient.user.username;
  console.log(`OnionBot logged in as ${botName}`);
  discordClient.user.setPresence({
    status: 'online',
    activities: [{ name: `OnionBot is online`, type: ActivityType.Custom, timestamps: { start: Date.now() } }],
  });
});

const messageQueue = [];
let isProcessingQueue = false;

function enqueueMessage(message) {
  if (message.author.bot) return;
  messageQueue.push(message);
  if (!isProcessingQueue) processQueue();
}

async function processQueue() {
  isProcessingQueue = true;
  while (messageQueue.length > 0) {
    const nextMessage = messageQueue.shift();
    await handleMessage(nextMessage);
  }
  isProcessingQueue = false;
}

discordClient.on('messageCreate', message => enqueueMessage(message));

discordClient.on('messageUpdate', (oldMessage, newMessage) => {
  const message = newMessage.partial ? oldMessage : newMessage;
  if (!message || message.partial || !message.content || message.author?.bot) return;
  enqueueMessage(message);
});

async function handleMessage(message) {
  if (message.author.bot) return;

  const hasReply = originalToReplyMap.has(message.id);
  const wasProcessed = processedMessages.has(message.id);
  if (wasProcessed && !hasReply) return;
  if (!wasProcessed) processedMessages.add(message.id);

  if (message.content.length >= MAX_MESSAGE_LENGTH) {
    await message.reply(LENGTH_WARNING_MESSAGE);
    return;
  }
  if (!isTranslatableText(message.content)) return;

  // Update cache on new or edited
  messageCache.set(message.id, { text: message.content, reference: message.reference?.messageId, author: message.author.username });

  let loadingMessage;
  let loadingInterval;
  let loadingTimeout;
  try {
    // Send initial loading message and start animation
    loadingMessage = await message.reply(LOADING_FRAMES[0]);
    let frameIndex = 1;
    loadingInterval = setInterval(() => {
      if (!loadingMessage.editable) return;
      loadingMessage.edit(LOADING_FRAMES[frameIndex % LOADING_FRAMES.length]);
      frameIndex++;
    }, LOADING_INTERVAL_MS);
    // Ensure animation stops after max duration
    loadingTimeout = setTimeout(() => clearInterval(loadingInterval), MAX_LOADING_DURATION_MS);

    const response = await generateResponse(message.id, message.channelId);
    clearInterval(loadingInterval);
    clearTimeout(loadingTimeout);

    if (!response || response.toLowerCase().includes(NOT_TRANSLATABLE_KEYWORD)) {
      // Remove loading message if response not needed
      await loadingMessage.delete().catch(() => null);
      return;
    }

    if (hasReply) {
      const existing = await message.channel.messages.fetch(originalToReplyMap.get(message.id)).catch(() => null);
      if (existing) {
        await existing.edit(response);
        // Delete loading message
        await loadingMessage.delete().catch(() => null);
        return;
      }
    }

    // Edit loading message to response
    await loadingMessage.edit(response);
    thisBotMessages.add(loadingMessage.id);
    originalToReplyMap.set(message.id, loadingMessage.id);
  } catch (err) {
    clearInterval(loadingInterval);
    clearTimeout(loadingTimeout);
    console.error(`Error processing message ${message.id}:`, err);
    if (hasReply) {
      const existing = await message.channel.messages.fetch(originalToReplyMap.get(message.id)).catch(() => null);
      if (existing) {
        await existing.edit(ERROR_MESSAGE);
        // Delete loading message
        await loadingMessage.delete().catch(() => null);
        return;
      }
    }
    // On error, edit loading to error or send new
    if (loadingMessage) {
      await loadingMessage.edit(ERROR_MESSAGE);
    } else {
      await message.reply(ERROR_MESSAGE);
    }
  }
}

async function generateResponse(messageId, channelId) {
  const dialog = [];
  let lastChainId = messageId;
  const channel = await discordClient.channels.fetch(channelId);

  while (true) {
    if (!messageCache.has(lastChainId)) {
      const msg = await channel.messages.fetch(lastChainId).catch(() => null);
      if (!msg) break;
      messageCache.set(lastChainId, { text: msg.content, reference: msg.reference?.messageId, author: msg.author.username });
    }
    const cached = messageCache.get(lastChainId);
    dialog.push({ role: thisBotMessages.has(lastChainId) ? 'assistant' : 'user', content: cached.text, name: cached.author });
    if (!cached.reference) break;
    lastChainId = cached.reference;
  }

  dialog.reverse();
  dialog.push({ role: 'system', content: SYSTEM_PROMPT });

  const res = await openaiClient.chat.completions.create({ model: process.env.GPT_MODEL || 'gpt-4', messages: dialog, max_tokens: 4096, n: 1 });
  return res.choices[0].message.content;
}

discordClient.login(process.env.DISCORD_BOT_TOKEN);
