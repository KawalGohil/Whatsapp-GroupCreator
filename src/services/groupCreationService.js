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
    const state = readState();
    if (state.createdGroups[username]?.[groupName]) {
        logger.info(`Group "${groupName}" already created by ${username}. Skipping.`);
        return;
    }

    const randomDelayValue = getRandomDelay(10000, 20000); // 10-20 seconds
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)}s before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid);
    } catch (baileysError) {
        logger.error(`Baileys failed for group "${groupName}": ${baileysError.message}.`);
        writeInviteLog(username, groupName, '', 'Failed', baileysError.message);
    }
}

async function createGroupWithBaileys(sock, username, groupName, participants, adminJid) {
    const numbersToValidate = participants.map(p => p.split('@')[0]);
    const onWhatsApp = await sock.onWhatsApp(...numbersToValidate);

    const confirmedParticipants = onWhatsApp.filter(result => result.exists).map(result => result.jid);

    if (confirmedParticipants.length === 0) {
        throw new Error('No valid WhatsApp users found.');
    }

    const group = await sock.groupCreate(groupName, confirmedParticipants);
    logger.info(`Baileys: Group "${groupName}" created with ID: ${group.id}`);
    
    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

    if (adminJid) {
        if (confirmedParticipants.includes(adminJid)) {
            await delay(2000);
            try {
                await sock.groupParticipantsUpdate(group.id, [adminJid], "promote");
                logger.info(`Successfully promoted ${adminJid} to admin.`);
                writeInviteLog(username, groupName, inviteLink, 'Success');
            } catch (e) {
                logger.error(`Failed to promote admin ${adminJid}: ${e.message}`);
                writeInviteLog(username, groupName, inviteLink, 'Success (Admin Promotion Failed)', e.message);
            }
        } else {
            logger.warn(`Admin JID ${adminJid} was not a valid participant. Cannot promote.`);
            writeInviteLog(username, groupName, inviteLink, 'Success (Admin Not Found)');
        }
    } else {
        writeInviteLog(username, groupName, inviteLink, 'Success');
    }
    
    emitLogUpdated(username);
    
    const state = readState();
    if (!state.createdGroups[username]) {
        state.createdGroups[username] = {};
    }
    state.createdGroups[username][groupName] = group.id;
    writeState(state);
}

module.exports = { createGroup };