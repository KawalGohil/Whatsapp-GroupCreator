const logger = require('../utils/logger');
const { readState, writeState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');
const config = require('../../config');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function createGroup(sock, username, groupName, participants) {
    const state = readState();
    if (state.createdGroups[groupName]) {
        logger.info(`Group "${groupName}" already exists. Skipping.`);
        return;
    }

    // **FIX**: The onWhatsApp function takes a single phone number string, not an array.
    // We need to check each participant individually.
    const confirmedParticipants = [];
    for (const p of participants) {
        const [result] = await sock.onWhatsApp(p);
        if (result?.exists) {
            confirmedParticipants.push(result.jid); // We use the jid property from the result object
        } else {
            logger.warn(`Number ${p} is not on WhatsApp. Skipping.`);
        }
    }

    if (confirmedParticipants.length === 0) {
        throw new Error('No valid WhatsApp users found in the provided list.');
    }

    logger.info(`Attempting to create group "${groupName}" with ${confirmedParticipants.length} members.`);
    await delay(5000); // Small delay before creation

    // 2. Create the group
    const group = await sock.groupCreate(groupName, confirmedParticipants);
    logger.info(`Group "${groupName}" created with ID: ${group.id}`);

    // 3. Get invite code
    await delay(2000);
    const inviteCode = await sock.groupInviteCode(group.id);
    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
    
    // 4. Log and save state
    writeInviteLog(username, groupName, inviteLink, 'Success');
    state.createdGroups[groupName] = group.id;
    writeState(state);

    return group;
}

module.exports = { createGroup };