'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const digest = token => createHash('sha256').update(token).digest('hex');
function readAccess(filename) {
    if (fs.statSync(filename).size > 1024 * 1024) throw new Error('Access file exceeds 1 MiB.');
    const members = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(members) || members.length > 1000 || members.some(item => !/^[a-zA-Z0-9_-]{1,64}$/.test(item.member) || !/^[a-f0-9]{64}$/.test(item.sha256))
        || new Set(members.map(item => item.member)).size !== members.length) throw new Error('Invalid access file.');
    return members;
}
function authenticate(filename, header) {
    if (typeof header !== 'string' || !/^Bearer ns_[a-zA-Z0-9_-]{43}$/.test(header)) return null;
    const candidate = Buffer.from(digest(header.slice(7)), 'hex');
    return readAccess(filename).find(item => timingSafeEqual(Buffer.from(item.sha256, 'hex'), candidate))?.member || null;
}
function changeMember(filename, member, revoke = false) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(member || '')) throw new Error('--member needs 1–64 letters, numbers, _ or -.');
    filename = path.resolve(filename);
    const members = fs.existsSync(filename) ? readAccess(filename) : [];
    const remaining = members.filter(item => item.member !== member);
    if (revoke && remaining.length === members.length) throw new Error('Member not found.');
    if (!revoke && remaining.length !== members.length) throw new Error('Member already exists; revoke first to rotate their token.');
    const token = revoke ? null : `ns_${randomBytes(32).toString('base64url')}`;
    if (token) remaining.push({ member, sha256: digest(token) });
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temp, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, filename);
    } finally { fs.rmSync(temp, { force: true }); }
    return token;
}
module.exports = { readAccess, authenticate, changeMember };
