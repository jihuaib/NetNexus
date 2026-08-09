const WorkerMessageHandler = require('../core/workerMessageHandler');
const RPKI_IMPORT_OP = require('./rpkiImportConst');
const { runImportTask } = require('./rpkiImportTask');

class RpkiImportWorker {
    constructor() {
        this.messageHandler = new WorkerMessageHandler();
        this.taskQueue = Promise.resolve();

        this.messageHandler.registerHandler(
            RPKI_IMPORT_OP.IMPORT_ROA_JSON,
            this.handleImport.bind(this, RPKI_IMPORT_OP.IMPORT_ROA_JSON)
        );
        this.messageHandler.registerHandler(
            RPKI_IMPORT_OP.IMPORT_ASPA_JSON,
            this.handleImport.bind(this, RPKI_IMPORT_OP.IMPORT_ASPA_JSON)
        );
        this.messageHandler.init();
    }

    handleImport(operation, messageId, options) {
        const task = this.taskQueue.then(() => runImportTask(operation, options));
        this.taskQueue = task.catch(() => {});
        task.then(stats => {
            this.messageHandler.sendSuccessResponse(messageId, stats, 'RPKI JSON import completed');
        }).catch(error => {
            this.messageHandler.sendErrorResponse(messageId, error?.message || String(error), {
                code: error?.code || 'RPKI_IMPORT_ERROR'
            });
        });
    }
}

if (require.main === module) {
    new RpkiImportWorker();
}

module.exports = RpkiImportWorker;
