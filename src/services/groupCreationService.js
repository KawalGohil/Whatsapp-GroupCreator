const axios = require('axios');
const logger = require('../utils/logger');
const { readState, writeState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');
const config = require('../../config');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Main function to create a WhatsApp group.
 * It will first try using Baileys and then fall back to Green-API on failure.
 */
async function createGroup(sock, username, groupName, participants, adminJid = null) {
    const state = readState();
    if (state.createdGroups[groupName]) {
        logger.info(`Group "${groupName}" already exists. Skipping.`);
        return;
    }

    // Feature 1: Add a random delay of 3-5 minutes before each group creation
    const randomDelayValue = getRandomDelay(180000, 300000); // 180k ms = 3 mins, 300k ms = 5 mins
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)} seconds before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        logger.info(`Attempting to create group "${groupName}" via Baileys...`);
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid);
    } catch (baileysError) {
        logger.error(`Baileys failed to create group: ${baileysError.message}. Attempting failover to Green-API.`);
        
        // Feature 4: Green-API Failover
        try {
            await createGroupWithGreenAPI(username, groupName, participants, adminJid);
        } catch (greenApiError) {
            logger.error(`Green-API also failed: ${greenApiError.message}`);
            // Log the failure to the daily CSV
            writeInviteLog(username, groupName, '', 'Failed', greenApiError.message);
            throw new Error(`Both Baileys and Green-API failed to create group "${groupName}".`);
        }
    }
}

/**
 * Creates a group using the Baileys library.
 */
async function createGroupWithBaileys(sock, username, groupName, participants, adminJid) {
    // 1. Validate numbers
    const onWhatsApp = await sock.onWhatsApp(participants.map(p => p.split('@')[0]));
    const confirmedParticipants = onWhatsApp.filter(p => p.exists).map(p => p.jid);

    if (confirmedParticipants.length === 0) {
        throw new Error('No valid WhatsApp users found.');
    }

    // 2. Create the group
    const group = await sock.groupCreate(groupName, confirmedParticipants);
    logger.info(`Baileys: Group "${groupName}" created with ID: ${group.id}`);

    // Feature 2: Promote Admin
    if (adminJid && confirmedParticipants.includes(adminJid)) {
        await delay(3000); // Wait for group propagation
        await sock.groupParticipantsUpdate(group.id, [adminJid], "promote");
        logger.info(`Baileys: Promoted ${adminJid} to admin in group "${groupName}".`);
    }

    // 3. Get invite link and log it
    await delay(2000);
    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
    
    // Feature 3: Log to daily CSV
    writeInviteLog(username, groupName, inviteLink, 'Success (Baileys)');
    
    const state = readState();
    state.createdGroups[groupName] = group.id;
    writeState(state);
}

/**
 * Creates a group using the Green-API as a backup.
 */
async function createGroupWithGreenAPI(username, groupName, participants, adminJid) {
    const idInstance = process.env.GREEN_API_ID_INSTANCE || 'YOUR_ID_INSTANCE_PLACEHOLDER';
    const apiTokenInstance = process.env.GREEN_API_API_TOKEN_INSTANCE || 'YOUR_API_TOKEN_PLACEHOLDER';
    
    if (idInstance.includes('PLACEHOLDER') || apiTokenInstance.includes('PLACEHOLDER')) {
        throw new Error('Green-API credentials are not configured in environment variables.');
    }

    const url = `https://api.green-api.com/waInstance${idInstance}/createGroup/${apiTokenInstance}`;

    const participantChatIds = participants.map(p => ({ participantChatId: p }));

    // Create the group
    const createResponse = await axios.post(url, { groupName, participantChatIds });
    const groupData = createResponse.data;

    if (!groupData || !groupData.created) {
        throw new Error(`Green-API failed to create group. Response: ${JSON.stringify(groupData)}`);
    }
    
    const groupId = groupData.chatId;
    logger.info(`Green-API: Group "${groupName}" created with ID: ${groupId}`);

    // Feature 2: Promote Admin via Green-API
    if (adminJid) {
        await delay(3000);
        const promoteUrl = `https://api.green-api.com/waInstance${idInstance}/setGroupAdmin/${apiTokenInstance}`;
        await axios.post(promoteUrl, { groupId, participantChatId: adminJid });
        logger.info(`Green-API: Promoted ${adminJid} to admin.`);
    }

    // Get invite link and log
    const inviteLink = groupData.groupInviteLink;
    
    // Feature 3: Log to daily CSV
    writeInviteLog(username, groupName, inviteLink, 'Success (Green-API)');

    const state = readState();
    state.createdGroups[groupName] = groupId;
    writeState(state);
}


module.exports = { createGroup };