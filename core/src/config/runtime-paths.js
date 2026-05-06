const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const isPackaged = !!process.pkg;

function getResourceRoot() {
    return path.join(__dirname, '..');
}

function getResourcePath(...segments) {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable() {
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
}

function getDataDir() {
    return path.join(getAppRootForWritable(), 'data');
}

function ensureDataDir() {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getDataFile(filename) {
    return path.join(getDataDir(), filename);
}

function getShareFilePath() {
    return path.join(getAppRootForWritable(), 'share.txt');
}

function getUserDataDir(userId) {
    return path.join(getDataDir(), 'users', String(userId || ''));
}

function getUserDataFile(userId, filename) {
    return path.join(getUserDataDir(userId), filename);
}

function ensureUserDataDir(userId) {
    const dir = getUserDataDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    isPackaged,
    getResourcePath,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
    getUserDataDir,
    getUserDataFile,
    ensureUserDataDir,
};
