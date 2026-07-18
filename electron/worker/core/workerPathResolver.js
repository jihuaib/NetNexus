const path = require('path');
const { app } = require('electron');

function resolveWorkerPath(workerRelativePath) {
    if (app?.isPackaged) {
        return path.join(process.resourcesPath, 'app', 'electron', 'worker', workerRelativePath);
    }

    return path.join(__dirname, '..', workerRelativePath);
}

module.exports = {
    resolveWorkerPath
};
