// groupCreationService.js
const axios = require('axios');
const logger = require('../utils/logger');
const { readState, writeState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function emitLogUpdated(username) {
    if (global.io && global.userSockets?.[username]) {
        global.io.to(global.userSockets[username]).emit('log_updated');
    }
}

async function createGroup(sock, username, groupName, participants, adminJid = null, batchId = null, inviteOnlyJids = []) {
    const state = readState();
    if (state.createdGroups[username]?.[groupName]) {
        const reason = 'Group already exists';
        logger.info(`Group "${groupName}" already created by ${username}. Skipping.`);
        writeInviteLog(username, groupName, '', 'Skipped', reason, batchId);
        return 'skipped';
    }

    const randomDelayValue = getRandomDelay(10000, 20000);
    logger.info(`Waiting for ${Math.round(randomDelayValue / 1000)}s before creating group "${groupName}"...`);
    await delay(randomDelayValue);

    try {
        // And also pass it here
        await createGroupWithBaileys(sock, username, groupName, participants, adminJid, batchId, inviteOnlyJids);
        return 'success';
    } catch (baileysError) {
        logger.error(`Baileys failed for group "${groupName}": ${baileysError.message}.`);
        writeInviteLog(username, groupName, '', 'Failed', baileysError.message, batchId);
        return 'failed';
    }
}


async function createGroupWithBaileys(sock, username, groupName, participants, adminJid, batchId, inviteOnlyJids = []) {
    logger.info(`[createGroupWithBaileys] Starting group creation for user: ${username}, group: ${groupName}`);
    logger.info(`[createGroupWithBaileys] Total participants passed: ${participants.length}`);

    if (!sock.user || !sock.user.id) {
        throw new Error('Bot user ID (sock.user.id) is not available.');
    }
    const botJid = jidNormalizedUser(sock.user.id);

    const numbersToValidate = participants.map(p => p.split('@')[0]);
    logger.info(`[User: ${username}] Validating ${numbersToValidate.length} numbers with WhatsApp for group "${groupName}"...`);

    const onWhatsApp = await sock.onWhatsApp(...numbersToValidate);
    logger.info(`[User: ${username}] WhatsApp validation response: ${JSON.stringify(onWhatsApp)}`);

    const confirmedParticipants = new Set(onWhatsApp.filter(p => p.exists).map(p => p.jid));

    const directAddParticipants = [botJid];
    const finalInviteOnlyParticipants = [];

    for (const jid of confirmedParticipants) {
        if (jidNormalizedUser(jid) !== botJid) {
            // If the JID is in the special invite list, add it to the invite-only participants
            if (inviteOnlyJids.includes(jid)) {
                finalInviteOnlyParticipants.push(jid);
            } else {
                directAddParticipants.push(jid);
            }
        }
    }

    logger.info(`[DEBUG] Final Direct Add Participants: ${JSON.stringify(directAddParticipants)}`);
    logger.info(`[DEBUG] Final Invite-Only Participants: ${JSON.stringify(finalInviteOnlyParticipants)}`);

    if (directAddParticipants.length < 1) { // We only need the bot for this check
        throw new Error(`Critical error: The bot itself is not in the direct-add list.`);
    }
    
    // We need at least one other person to create a group with the bot
    if (directAddParticipants.length + finalInviteOnlyParticipants.length < 1) {
        throw new Error('Not enough valid participants to create a group.');
    }

    // If the direct add list is empty (except for the bot), we must "borrow" a participant from the invite list
    if (directAddParticipants.length < 2 && finalInviteOnlyParticipants.length > 0) {
        directAddParticipants.push(finalInviteOnlyParticipants.shift());
    }

    logger.info(`[User: ${username}] Creating group "${groupName}" with ${directAddParticipants.length} direct add participants.`);
    const group = await sock.groupCreate(groupName, directAddParticipants);
    logger.info(`Group Create Full Response: ${JSON.stringify(group, null, 2)}`);

    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

    for (const jid of finalInviteOnlyParticipants) {
        try {
            logger.info(`Sending invite link to non-contact participant: ${jid}`);
            await sock.sendMessage(jid, {
                text:   `Hi! You have been invited to join the group "${groupName}" by Stayvista. \n\nPlease join using this link: ${inviteLink}. 
                        \n\n Just reply with a "Yes" in case the link is not clickable.`
            });
            logger.info(`Invite link successfully sent to ${jid}`);
            await delay(1000);
        } catch (err) {
            logger.error(`Failed to send invite to ${jid}: ${err.message}`);
        }
    }

    // Admin promotion and state update logic remains the same...
    if (adminJid) {
        const allParticipants = [...directAddParticipants, ...finalInviteOnlyParticipants];
        if (allParticipants.includes(adminJid)) {
            await delay(2000);
            try {
                await sock.groupParticipantsUpdate(group.id, [adminJid], "promote");
                logger.info(`Successfully promoted ${adminJid} to admin.`);
                writeInviteLog(username, groupName, inviteLink, 'Success', '', batchId);
            } catch (e) {
                logger.error(`Failed to promote admin ${adminJid}: ${e.message}`);
                writeInviteLog(username, groupName, inviteLink, 'Success (Admin Promotion Failed)', e.message, batchId);
            }
        } else {
            logger.warn(`Admin JID ${adminJid} was not a valid participant. Cannot promote.`);
            writeInviteLog(username, groupName, inviteLink, 'Success (Admin Not Found)', '', batchId);
        }
    } else {
        writeInviteLog(username, groupName, inviteLink, 'Success', '', batchId);
    }

    emitLogUpdated(username);

    const state = readState();
    if (!state.createdGroups[username]) state.createdGroups[username] = {};
    state.createdGroups[username][groupName] = group.id;
    writeState(state);
}

module.exports = { createGroup };