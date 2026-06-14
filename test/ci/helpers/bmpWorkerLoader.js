const path = require('path');
const { loadBmpWorkerClassFromFile } = require('../../../scripts/bmp-worker-loader');

function loadBmpWorkerClass(testDir, parentModule) {
    const filePath = path.join(testDir, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js');
    return loadBmpWorkerClassFromFile(filePath, parentModule, 'CI loading');
}

module.exports = {
    loadBmpWorkerClass
};
