const {Client, GatewayIntentBits, Partials, ActivityType} = require('discord.js');
const {OpenAI} = require('openai');

require('dotenv').config();

// noinspection JSUnresolvedReference
const discordClient = new Client({
    partials: [Partials.Channel, Partials.Message],
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ]
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GPT_MODEL = process.env.GPT_MODEL ?? "gpt-4.1";
const GPT_PROMPT = process.env.GPT_PROMPT ?? "You are a helpful assistant. Respond briefly, but informatively."

let GPT_DEFAULT_SYSTEM_ROLE;
{
    const no_developer_messages = [
        'o1-mini',
        'o1-preview',
    ];
    const force_developer_models = [
        'o1',
        'o3',
        'o4',
    ];
    
    let is_system_is_developer = false;
    let is_no_developer = false;
    let lowered = GPT_MODEL.toLowerCase();
    
    for (let prefix of no_developer_messages) {
        if ((lowered === prefix) || lowered.startsWith(prefix + '-')) {
            is_no_developer = true;
            break;
        }
    }
    
    if (!is_no_developer) {
        for (let prefix of force_developer_models) {
            if ((lowered === prefix) || lowered.startsWith(prefix + '-')) {
                is_system_is_developer = true;
                break;
            }
        }
    }
    
    if (is_no_developer) {
        GPT_DEFAULT_SYSTEM_ROLE = 'user';
    } else if (is_system_is_developer) {
        GPT_DEFAULT_SYSTEM_ROLE = 'developer';
    } else {
        GPT_DEFAULT_SYSTEM_ROLE = 'system';
    }
}

let GPT_DEFAULT_NO_CHAT_COMPLETION_API = false;
{
    const no_chat_completion_api_prefixes = [
        'o1-pro',
    ];
    let lowered = GPT_MODEL.toLowerCase();
    for (let prefix of no_chat_completion_api_prefixes) {
        if ((lowered === prefix) || lowered.startsWith(prefix + '-')) {
            GPT_DEFAULT_NO_CHAT_COMPLETION_API = true;
            break;
        }
    }
}

const GPT_SYSTEM_ROLE = process.env.GPT_SYSTEM_ROLE ?? GPT_DEFAULT_SYSTEM_ROLE;
const GPT_NO_CHAT_COMPLETION_API = process.env.GPT_NO_CHAT_COMPLETION_API ?? GPT_DEFAULT_NO_CHAT_COMPLETION_API;

const openaiClient = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

const usefulMessagesLifetime = 7 * 24 * 3600 * 1000;
const unusefulMessagesLifetime = 24 * 3600 * 1000;

let botName;
const thisBotMessages = new Set();
const allMessages = {};
const usernames = {};
let needShutdown = false;
let currentProcessingMessaged = 0;

discordClient.on('ready', () => {
    console.log(`Logged in`);
    console.log(`Bot ID: ${discordClient.user.id}`);
    console.log(`Startup Time: ${new Date().toLocaleString()}`);
    console.log(`Serving on ${discordClient.guilds.cache.size} servers`);
    console.log(`Observing ${discordClient.users.cache.size} users`);
    botName = discordClient.user.username;
    
    let statusText = `${GPT_MODEL}. ${GPT_PROMPT}`;
    if (statusText.length > 50) {
        statusText = statusText.substring(0, 50);
    }
    
    // https://discord.com/developers/docs/topics/gateway-events#activity-object-activity-structure
    // You could see available types in gateway.d.ts
    // noinspection JSCheckFunctionSignatures,JSUnresolvedReference
    discordClient.user.setPresence({
        status: 'online',
        activities: [{
            name: statusText,
            type: ActivityType.Custom,
            // details: "...details...", // GPT_PROMPT
            // state: "...state...",
            timestamps: {
                start: Date.now(),
            }
        }],
    });
});

discordClient.on('messageCreate', async (/** @type {Message} */ message) => {
    if (needShutdown) {
        return;
    }
    
    if (!isTranslatableText(message.content)) {
        console.log(`Skipped non-translatable message from ${message.author.username}: "${message.content}"`);
        return;
    }
    
    if (message.content.length >= 2000) {
        console.log(`Message from ${message.author.username} was too long (${message.content.length} chars). Ignored.`);
        return;
    }
    
    usernames[message.author.id] = message.author.username;
    allMessages[message.id] = {
        id: message.id,
        referenceMessageId: message.reference?.messageId ?? null,
        time: message.createdTimestamp,
        authorName: message.author.username,
        text: message.content,
    };
    
    if (message.author.bot) {
        // Author is a bot itself
        if (message.author.id === discordClient.user.id) {
            thisBotMessages.add(message.id);
        }
        
        return;
    }
    
    //    const hasmentionme = message.mentions.users.has(discordclient.user.id);
    //    const answertome = ((message.reference !== null) && thisbotmessages.has(message.reference.messageid));
    //    if (!hasmentionme && !answertome) {
    // i can't answer to this message
    //        return;
    //    }
    //
    
    if (message.author.bot) {
        if (message.author.id === discordClient.user.id) {
            thisBotMessages.add(message.id);
        }
        return; // 다른 봇 무시
    }
    
    console.log('At ', new Date(message.createdTimestamp), '. Message from user ', message.author.displayName,
    '. Text: ', message.content)
    currentProcessingMessaged++;
    const response = await generateResponse(message.id, message.channelId, OPENAI_API_KEY);
    // const newMessage = await message.channel.send(response);
    if (response.length <= 1950) {
        const newMessage = await message.reply(response);
        thisBotMessages.add(newMessage.id);
    } else {
        let responseLeft = response;
        let prevMessage = message;
        while (responseLeft !== '') {
            const s = responseLeft.substring(0, 1950);
            const newMessage = await prevMessage.reply(s);
            thisBotMessages.add(newMessage.id);
            responseLeft = responseLeft.substring(1950);
            prevMessage = newMessage;
        }
    }
    
    currentProcessingMessaged--;
});

async function generateResponse(messageId, channelId) {
    try {
        if (!GPT_NO_CHAT_COMPLETION_API) {
            return await generateResponse_chat(messageId, channelId);
        }
        
        return `Chat completion API is disabled for model ${GPT_MODEL}`;
    } catch (error) {
        console.error('Error generating response:', error.response ? error.response.data : error);
        if (error.error) {
            return `Sorry, I am unable to generate a response at this time ${error.error.type}: ${error.error.message}`;
        } else {
            return `Sorry, I am unable to generate a response at this time. ${error}`;
        }
    }
}

async function generateResponse_chat(messageId, channelId) {
    const channel = await discordClient.channels.fetch(channelId);
    const messageData = allMessages[messageId];

    const dialog = [];

    dialog.push({
        role: "user",
        content: messageData.text,
        name: messageData.authorName,
    });

    dialog.push({ role: GPT_SYSTEM_ROLE, content: [{ type: "text", text: GPT_PROMPT }] });

    const response = await openaiClient.chat.completions.create({
        model: GPT_MODEL,
        messages: dialog,
        max_completion_tokens: 4096,
        n: 1,
    });

    console.log('OpenAI response. Model', response.model, '. Text: ', response.choices[0].message.content);
    // return response.choices[0].message.content;
    return normalizeTranslationFormat(response.choices[0].message.content);
}

// async function generateResponse_chat(messageId, channelId) {
//     const dialog = [];
//     let lastChainId = messageId;
//     const channel = await discordClient.channels.fetch(channelId);
//     while (true) {
//         if (!allMessages.hasOwnProperty(lastChainId)) {
//             // no parent message loaded
//             const message1 = await channel.messages.fetch(lastChainId).catch(() => null);
//             if (!message1) {
//                 // Can't get this message. Break the cycle
//                 break;
//             }
            
//             usernames[message1.author.id] = message1.author.username;
//             allMessages[lastChainId] = {
//                 id: message1.id,
//                 referenceMessageId: message1.reference?.messageId ?? null,
//                 time: message1.createdTimestamp,
//                 authorName: message1.author.username,
//                 text: message1.content,
//             };
//         }
        
//         const message = allMessages[lastChainId];
//         if (thisBotMessages.has(lastChainId)) {
//             // This is THIS bot message
//             dialog.push({
//                 role: "assistant",
//                 content: message.text,
//                 name: botName,
//             });
//         } else {
//             // This is a user message
//             dialog.push({
//                 role: "user",
//                 content: message.text,
//                 name: message.authorName,
//             });
//         }
        
//         if (message.referenceMessageId === null) {
//             // No parent message. It's the root message for this branch
//             break;
//         }
        
//         lastChainId = message.referenceMessageId;
//     }
    
//     // Processing dialog
//     for (let i = 0; i < dialog.length; i++) {
//         const messageItem = dialog[i];
//         const message = messageItem.content;
//         const fixedMessage = fixMessageAppeals(message);
//         if (message === fixedMessage) {
//             continue;
//         }
        
//         messageItem.content = fixedMessage;
//         dialog[i] = messageItem;
//     }
    
//     dialog.push({role: GPT_SYSTEM_ROLE, content: [{type: "text", text: GPT_PROMPT}]});
    
//     /** https://platform.openai.com/docs/guides/text?api-mode=chat */
//     /** https://platform.openai.com/docs/api-reference/chat/create */
//     const response = await openaiClient.chat.completions.create({
//         model: GPT_MODEL,
//         messages: [...dialog].reverse(),
//         max_completion_tokens: 4096,
//         n: 1
//     });
    
//     console.log('OpenAI response. Model', response.model, '. Text: ', response.choices[0].message.content);
//     return response.choices[0].message.content;
// }

function normalizeTranslationFormat(text) {
    // 1. 줄바꿈 2번 이상을 1번으로 정리
    let normalized = text.replace(/\n{2,}/g, '\n');

    // 2. 🇺🇸, 🇮🇩, 🇰🇷 각 줄이 붙어있거나 줄바꿈이 안 되어 있으면 강제 줄바꿈
    normalized = normalized.replace(/(🇺🇸 \[EN\])/g, '\n$1');
    normalized = normalized.replace(/(🇮🇩 \[ID\])/g, '\n$1');
    normalized = normalized.replace(/(🇰🇷 \[KO\])/g, '\n$1');

    // 3. 맨 앞에 줄바꿈이 생기면 제거
    return normalized.trimStart();
}

function isTranslatableText(text) {
    const trimmed = text.trim();
    
    // 공백만 있음
    if (trimmed.length === 0) return false;
    
    // 링크만 있는 경우
    const urlRegex = /^(https?:\/\/[^\s]+)$/i;
    if (urlRegex.test(trimmed)) return false;
    
    // 유니코드 이모지만 있음 (예: 😁🎉)
    const emojiOnlyRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)+$/u;
    if (emojiOnlyRegex.test(trimmed)) return false;
    
    // 카모지 또는 특수기호만 있음 (괄호+기호 형태)
    const kamojiRegex = /^[\p{P}\p{S}\sA-Za-z0-9]*[\u3000-\u303F\uFF00-\uFFEF\u2500-\u257F()\\/|_~^*-]+[\p{P}\p{S}\sA-Za-z0-9]*$/u;
    if (kamojiRegex.test(trimmed) && trimmed.length < 15) return false;
    
    // 알파벳/한글/숫자가 전혀 없는 경우
    if (!/[a-zA-Z가-힣0-9]/.test(trimmed)) return false;
    
    return true;
}

function fixMessageAppeals(msg) {
    const m = msg.match(/^<@(\d+)>/);
    if (!m) {
        return msg;
    }
    
    const id = m[1];
    let rest = msg.slice(m[0].length).trimStart();
    
    if (id === discordClient.user.id) {
        return rest;
    }
    
    if (usernames[id]) {
        rest = rest.replace(/^[ ,]+/, '').trimStart();
        return `${usernames[id]}, ${rest}`;
    }
    
    return msg;
}

/**
* Prints memory usage every hour indefinitely.
*
* @async
* @return {void}
*/
async function infiniteDrawMemoryUsage() {
    await new Promise(resolve => setTimeout(resolve, 10 * 600 * 1000));
    // noinspection InfiniteLoopJS
    while (true) {
        console.log('Memory usage');
        const used = process.memoryUsage();
        for (let key in used) {
            console.log(`${key}\t${Math.round(used[key] * (100 / 1024 / 1024)) / 100} MB`);
        }
        await new Promise(resolve => setTimeout(resolve, 3600000));
    }
}

async function infiniteCleanMessages() {
    // noinspection InfiniteLoopJS
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 3600000));
        // await new Promise(resolve => setTimeout(resolve, 1000));
        const prevMessagesCount = Object.keys(allMessages).length;
        if (Object.keys(allMessages).length === 0) {
            continue;
        }
        
        const usefulMessages = new Set();
        for (const messageId of [...thisBotMessages].reverse()) {
            let lastChainId = messageId;
            while (true) {
                if (usefulMessages.has(lastChainId)) {
                    // already processed
                    break;
                }
                
                if (!allMessages.hasOwnProperty(lastChainId)) {
                    // already deleted from allMessages
                    thisBotMessages.delete(lastChainId);
                    break;
                }
                
                usefulMessages.add(lastChainId);
                const message = allMessages[lastChainId];
                if (message.referenceMessageId === null) {
                    break;
                }
                
                lastChainId = message.referenceMessageId;
            }
        }
        
        const now = Date.now();
        const forDeletion = [];
        for (const messageId in allMessages) {
            const message = allMessages[messageId];
            const isUseful = usefulMessages.has(messageId);
            const lifetime = isUseful ? usefulMessagesLifetime : unusefulMessagesLifetime;
            
            if (message.time + lifetime < now) {
                forDeletion.push(messageId);
            }
        }
        
        for (const messageId of forDeletion) {
            delete allMessages[messageId];
        }
        
        console.log(`${prevMessagesCount - Object.keys(allMessages).length} messages deleted`);
    }
}

// noinspection JSIgnoredPromiseFromCall
infiniteDrawMemoryUsage();
// noinspection JSIgnoredPromiseFromCall
infiniteCleanMessages();

process.on('SIGINT', async function() {
    if (needShutdown) {
        return;
    }
    
    console.log("Gracefully shutting down from SIGINT (Ctrl+C)");
    needShutdown = true;
    while (currentProcessingMessaged > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    process.exit(0);
});

process.on('SIGTERM', async function() {
    if (needShutdown) {
        return;
    }
    
    console.log("Gracefully shutting down from SIGTERM");
    needShutdown = true;
    while (currentProcessingMessaged > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    process.exit(0);
});

discordClient.login(DISCORD_BOT_TOKEN).then();