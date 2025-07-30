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

async function createGroup(sock, username, groupName, participants, adminJid = null, batchId = null) {
    const state = readState();
    if (state.createdGroups[username]?.[groupName]) {
        const reason = 'Group already exists';
        logger.info(`Group "${groupName}" already created by ${username}. Skipping.`);
        
        // Log the skipped group to the CSV, passing the batchId
        writeInviteLog(username, groupName, '', 'Skipped', reason, batchId);
        
        // Return 'skipped' status to the queue processor
        return 'skipped'; 
    }

    const randomDelayValue = getRandomDelay(10000, 20000);
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)}s before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid, batchId);
        return 'success'; // Return 'success' on completion
    } catch (baileysError) {
        logger.error(`Baileys failed for group "${groupName}": ${baileysError.message}.`);
        // The batchId is now passed to the logger here as well
        writeInviteLog(username, groupName, '', 'Failed', baileysError.message, batchId);
        return 'failed'; // Return 'failed' status
    }
}


async function createGroupWithBaileys(sock, username, groupName, participants, adminJid, batchId) {
    const numbersToValidate = participants.map(p => p.split('@')[0]);
   logger.info(`[User: ${username}] Validating ${numbersToValidate.length} numbers with WhatsApp for group "${groupName}"...`);
    const onWhatsApp = await sock.onWhatsApp(...numbersToValidate);
    logger.info(`[User: ${username}] WhatsApp validation response: ${JSON.stringify(onWhatsApp)}`);

    const confirmedParticipants = [];
    onWhatsApp.forEach(result => {
        if (result.exists) {
            confirmedParticipants.push(result.jid);
        } else {
            // This log will now clearly show which numbers are being rejected by WhatsApp.
            logger.warn(`[User: ${username}] WhatsApp reports that number ${result.jid} is not a valid user. Skipping.`);
        }
    });

    if (confirmedParticipants.length < 2) {
        throw new Error(`Not enough valid WhatsApp users found to form a group (found ${confirmedParticipants.length}, need at least 2).`);
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
                // --- ✅ FIX: Added missing '' argument for details ---
                writeInviteLog(username, groupName, inviteLink, 'Success', '', batchId);
            } catch (e) {
                logger.error(`Failed to promote admin ${adminJid}: ${e.message}`);
                writeInviteLog(username, groupName, inviteLink, 'Success (Admin Promotion Failed)', e.message, batchId);
            }
        } else {
            logger.warn(`Admin JID ${adminJid} was not a valid participant. Cannot promote.`);
            // --- ✅ FIX: Added missing '' argument for details ---
            writeInviteLog(username, groupName, inviteLink, 'Success (Admin Not Found)', '', batchId);
        }
    } else {
        // --- ✅ FIX: Added missing '' argument for details ---
        writeInviteLog(username, groupName, inviteLink, 'Success', '', batchId);
    }
    
    emitLogUpdated(username);
    
    // This part of the code will now be reached without crashing
    const state = readState();
    if (!state.createdGroups[username]) {
        state.createdGroups[username] = {};
    }
    state.createdGroups[username][groupName] = group.id;
    writeState(state);
}

module.exports = { createGroup };