const axios = require('axios');
const logger = require('../utils/logger');
const { readState, writeState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');


const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function emitLogUpdated(username) {
    if (global.io && global.userSockets?.[username]) {
        global.io.to(global.userSockets[username]).emit('log_updated');
    }
}

async function createGroup(sock, username, groupName, participants, adminJid = null) {
    // --- STATE MANAGEMENT FIX ---
    const state = readState();
    if (state.createdGroups[username]?.[groupName]) {
        logger.info(`Group "${groupName}" already created by user ${username}. Skipping.`);
        return;
    }
    // --- END OF FIX ---

    const randomDelayValue = getRandomDelay(10000, 20000); // Shortened for testing
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)}s before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        logger.info(`Attempting to create group "${groupName}" via Baileys...`);
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid);
    } catch (baileysError) {
        logger.error(`Baileys failed for group "${groupName}": ${baileysError.message}.`);
        writeInviteLog(username, groupName, '', 'Failed', baileysError.message);
        // Removed Green-API fallback for simplicity, can be re-added if needed
    }
}

async function createGroupWithBaileys(sock, username, groupName, participants, adminJid) {
    const numbersToValidate = participants.map(p => p.split('@')[0]);
    const onWhatsApp = await sock.onWhatsApp(...numbersToValidate);

    const confirmedParticipants = onWhatsApp
        .filter(result => result.exists)
        .map(result => result.jid);

    if (confirmedParticipants.length === 0) {
        throw new Error('No valid WhatsApp users found among participants.');
    }

    const group = await sock.groupCreate(groupName, confirmedParticipants);
    logger.info(`Baileys: Group "${groupName}" created with ID: ${group.id}`);
    
    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

    // --- ADMIN PROMOTION LOGGING FIX ---
    if (adminJid) {
        if (confirmedParticipants.includes(adminJid)) {
            logger.info(`Attempting to promote ${adminJid} to admin...`);
            await delay(2000);
            try {
                await sock.groupParticipantsUpdate(group.id, [adminJid], "promote");
                logger.info(`Successfully promoted ${adminJid} to admin.`);
                writeInviteLog(username, groupName, inviteLink, 'Success');
            } catch (e) {
                logger.error(`Failed to promote admin ${adminJid}: ${e.message}`);
                // Log accurately that the group was made but promotion failed.
                writeInviteLog(username, groupName, inviteLink, 'Success (Admin Promotion Failed)', e.message);
            }
        } else {
            logger.warn(`Admin JID ${adminJid} was not a valid participant. Cannot promote.`);
            writeInviteLog(username, groupName, inviteLink, 'Success (Admin Not Found)');
        }
    } else {
        writeInviteLog(username, groupName, inviteLink, 'Success');
    }
    // --- END OF FIX ---
    
    emitLogUpdated(username);
    
    // --- STATE MANAGEMENT FIX ---
    const state = readState();
    if (!state.createdGroups[username]) {
        state.createdGroups[username] = {};
    }
    state.createdGroups[username][groupName] = group.id;
    writeState(state);
    // --- END OF FIX ---
}


// Green-API function is unchanged.

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
    if (!state.createdGroups[username]) {
        state.createdGroups[username] = {};
    }
    state.createdGroups[username][groupName] = groupId;
    writeState(state);
}


module.exports = { createGroup };