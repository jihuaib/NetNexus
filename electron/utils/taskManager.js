const { randomUUID } = require('crypto');

class TaskManager {
    constructor(options = {}) {
        this.tasks = new Map();
        this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        this.historyLimit = Math.max(10, Number(options.historyLimit) || 100);
    }

    start(type, executor, metadata = {}) {
        const taskId = randomUUID();
        const controller = new AbortController();
        const task = {
            taskId,
            type,
            phase: 'queued',
            percent: 0,
            status: 'running',
            metadata,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            controller,
            result: null,
            error: null
        };
        this.tasks.set(taskId, task);
        this.emit(task, { phase: 'queued', percent: 0 });

        const report = update => {
            if (task.status !== 'running') return;
            task.phase = update.phase || task.phase;
            task.percent = Math.max(task.percent, Math.min(100, Math.max(0, Number(update.percent) || 0)));
            task.updatedAt = new Date().toISOString();
            this.emit(task, update);
        };

        task.promise = Promise.resolve()
            .then(() => executor({ taskId, signal: controller.signal, report }))
            .then(result => {
                if (controller.signal.aborted) {
                    task.status = 'cancelled';
                    task.phase = 'cancelled';
                } else {
                    task.status = 'completed';
                    task.phase = 'completed';
                    task.percent = 100;
                    task.result = result;
                }
                task.updatedAt = new Date().toISOString();
                this.emit(task, { result });
                return result;
            })
            .catch(error => {
                task.status = controller.signal.aborted ? 'cancelled' : 'failed';
                task.phase = task.status;
                task.error = {
                    code: error.code || 'TASK_FAILED',
                    message: error.message || String(error)
                };
                task.updatedAt = new Date().toISOString();
                this.emit(task, { error: task.error });
                return null;
            })
            .finally(() => this.prune());

        return this.publicTask(task);
    }

    emit(task, extra = {}) {
        this.onProgress({
            ...this.publicTask(task),
            ...extra,
            metadata: task.metadata
        });
    }

    cancel(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'running') return false;
        task.controller.abort();
        return true;
    }

    get(taskId) {
        const task = this.tasks.get(taskId);
        return task ? this.publicTask(task) : null;
    }

    list() {
        return Array.from(this.tasks.values())
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map(task => this.publicTask(task));
    }

    publicTask(task) {
        return {
            taskId: task.taskId,
            type: task.type,
            action: task.type,
            taskType: task.type,
            phase: task.phase,
            percent: task.percent,
            status: task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            error: task.error
        };
    }

    prune() {
        const completed = Array.from(this.tasks.values())
            .filter(task => task.status !== 'running')
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        completed.slice(this.historyLimit).forEach(task => this.tasks.delete(task.taskId));
    }
}

module.exports = TaskManager;
