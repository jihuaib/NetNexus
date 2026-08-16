'use strict';

const { createHash } = require('node:crypto');

const MAX_PROFILE_ID_BYTES = 1024;

function profileWorkspaceId(profileId) {
    const value = String(profileId ?? '');
    const containsControlCharacter = [...value].some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (!value || /^\s+$/u.test(value) || containsControlCharacter || Buffer.byteLength(value) > MAX_PROFILE_ID_BYTES) {
        throw new Error('缺少有效的 NETCONF Profile ID');
    }
    return `profile-${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

module.exports = { profileWorkspaceId, MAX_PROFILE_ID_BYTES };
