const axios = require('axios');
const logger = require('../utils/logger');
const { readState, writeState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');


const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function emitLogUpdated(username) {
    if (global.io && global.userSockets?.[username]) {
        global.io.to(global.userSockets[username]).emit('log_updated');
        logger.info(`Emitted 'log_updated' event to user ${username}`);
    }
}

async function createGroup(sock, username, groupName, participants, adminJid = null) {
    const state = readState();
    if (state.createdGroups[groupName]) {
        logger.info(`Group "${groupName}" already exists. Skipping.`);
        return;
    }

    const randomDelayValue = getRandomDelay(180000, 300000);
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)} seconds before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        logger.info(`Attempting to create group "${groupName}" via Baileys...`);
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid);
    } catch (baileysError) {
        logger.error(`Baileys failed to create group: ${baileysError.message}. Attempting failover to Green-API.`);
        try {
            await createGroupWithGreenAPI(username, groupName, participants, adminJid);
        } catch (greenApiError) {
            logger.error(`Green-API also failed: ${greenApiError.message}`);
            writeInviteLog(username, groupName, '', 'Failed', greenApiError.message);
            throw new Error(`Both Baileys and Green-API failed to create group "${groupName}".`);
        }
    }
}

async function createGroupWithBaileys(sock, username, groupName, participants, adminJid) {
    const state = readState();
    if (state.createdGroups[groupName]) {
        logger.info(`Group "${groupName}" already exists. Skipping.`);
        return;
    }

    const confirmedParticipants = [];
    // **FIX**: This loop now correctly checks each number individually.
    for (const p of participants) {
        if (!p) continue;
        // We check the number without the @s.whatsapp.net suffix
        const [result] = await sock.onWhatsApp(p.split('@')[0]);
        if (result?.exists) {
            confirmedParticipants.push(result.jid); // Use the JID from the result
        } else {
            logger.warn(`Number ${p} is not on WhatsApp. Skipping.`);
        }
    }

    if (confirmedParticipants.length === 0) throw new Error('No valid WhatsApp users found.');

    const group = await sock.groupCreate(groupName, confirmedParticipants);
    logger.info(`Baileys: Group "${groupName}" created with ID: ${group.id}`);

    // **FIX & ENHANCED LOGGING**: This block now has better checks and logs for admin promotion.
    if (adminJid) {
        if (confirmedParticipants.includes(adminJid)) {
            logger.info(`Attempting to promote ${adminJid} to admin...`);
            await delay(3000);
            try {
                await sock.groupParticipantsUpdate(group.id, [adminJid], "promote");
                logger.info(`Successfully promoted ${adminJid} to admin in group "${groupName}".`);
                // Consider adding a success note to the log here if needed
            } catch (e) {
                logger.error(`Failed to promote admin ${adminJid}: ${e.message}`);
                // Write a distinct log entry about the promotion failure
                writeInviteLog(username, groupName, inviteLink, 'Success (Admin Promotion Failed)', e.message);
            }
        } else {
            logger.warn(`Admin JID ${adminJid} was not in the final list of confirmed participants. Cannot promote.`);
        }
    }

    await delay(2000);
    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
    
    writeInviteLog(username, groupName, inviteLink, 'Success (Baileys)');
    emitLogUpdated(username); // Notifies frontend to refresh logs
    
    state.createdGroups[groupName] = group.id;
    writeState(state);
}

async function createGroupWithGreenAPI(username, groupName, participants, adminJid) {
    const idInstance = process.env.GREEN_API_ID_INSTANCE || 'YOUR_ID_INSTANCE_PLACEHOLDER';
    const apiTokenInstance = process.env.GREEN_API_API_TOKEN_INSTANCE || 'YOUR_API_TOKEN_PLACEHOLDER';
    
    if (idInstance.includes('PLACEHOLDER') || apiTokenInstance.includes('PLACEHOLDER')) {
        throw new Error('Green-API credentials are not configured in environment variables.');
    }

    const url = `https://api.green-api.com/waInstance${idInstance}/createGroup/${apiTokenInstance}`;
    const participantChatIds = participants.map(p => ({ participantChatId: p }));

    const createResponse = await axios.post(url, { groupName, participantChatIds });
    const groupData = createResponse.data;

    if (!groupData || !groupData.created) {
        throw new Error(`Green-API failed to create group. Response: ${JSON.stringify(groupData)}`);
    }
    
    const groupId = groupData.chatId;
    logger.info(`Green-API: Group "${groupName}" created with ID: ${groupId}`);

    if (adminJid) {
        await delay(3000);
        const promoteUrl = `https://api.green-api.com/waInstance${idInstance}/setGroupAdmin/${apiTokenInstance}`;
        await axios.post(promoteUrl, { groupId, participantChatId: adminJid });
        logger.info(`Green-API: Promoted ${adminJid} to admin.`);
    }

    const inviteLink = groupData.groupInviteLink;
    writeInviteLog(username, groupName, inviteLink, 'Success (Green-API)');
    emitLogUpdated(username);

    const state = readState();
    state.createdGroups[groupName] = groupId;
    writeState(state);
}

module.exports = { createGroup };