const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_TIME_BUDGET_MS = 8;

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function optionalCallback(value) {
    return typeof value === 'function' ? value : null;
}

class BmpRouteAgingScheduler {
    constructor(options = {}) {
        this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
        this.timeBudgetMs = positiveNumber(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS);
        this.onError = optionalCallback(options.onError);
        this.jobs = new Map();
        this.readyQueue = [];
        this.pumpImmediate = null;
    }

    schedule(options = {}) {
        const key = String(options.key || '');
        if (!key || !(options.routeMap instanceof Map)) {
            throw new Error('BMP route aging requires a key and route Map');
        }

        const delayMs = nonNegativeNumber(options.delayMs);
        const targetEpoch = nonNegativeNumber(options.targetEpoch);
        let existing = this.jobs.get(key);
        if (existing && (existing.targetEpoch !== targetEpoch || existing.routeMap !== options.routeMap)) {
            this.finishJob(existing, 'replaced', true);
            existing = null;
        }
        if (existing) {
            this.updateJobCallbacks(existing, options);
            if (existing.timer && Date.now() + delayMs < existing.dueAtMs) {
                clearTimeout(existing.timer);
                existing.timer = null;
                this.arm(existing, delayMs);
            }
            return false;
        }

        const job = {
            key,
            routeMap: options.routeMap,
            targetEpoch,
            isEligible: optionalCallback(options.isEligible),
            isCurrent: optionalCallback(options.isCurrent),
            isExhausted: optionalCallback(options.isExhausted),
            onDelete: optionalCallback(options.onDelete),
            onComplete: optionalCallback(options.onComplete),
            timer: null,
            dueAtMs: null,
            iterator: null,
            scanRemaining: 0,
            processed: 0,
            deleted: 0,
            cancelled: false,
            finished: false
        };
        this.jobs.set(key, job);
        this.arm(job, delayMs);
        return true;
    }

    updateJobCallbacks(job, options) {
        for (const name of ['isEligible', 'isCurrent', 'isExhausted', 'onDelete', 'onComplete']) {
            if (Object.prototype.hasOwnProperty.call(options, name)) {
                job[name] = optionalCallback(options[name]);
            }
        }
    }

    arm(job, delayMs) {
        job.dueAtMs = Date.now() + delayMs;
        if (delayMs === 0) {
            this.activate(job);
            return;
        }
        job.timer = setTimeout(() => {
            job.timer = null;
            this.activate(job);
        }, delayMs);
        job.timer.unref?.();
    }

    activate(job) {
        if (job.cancelled || job.finished || this.jobs.get(job.key) !== job || job.iterator) {
            return;
        }
        job.iterator = job.routeMap.entries();
        // Bound the scan to the routes present at activation. Routes learned while
        // an old epoch is aging must be handled by the owner of the new epoch.
        job.scanRemaining = job.routeMap.size;
        this.readyQueue.push(job);
        this.schedulePump();
    }

    schedulePump() {
        if (this.pumpImmediate || this.readyQueue.length === 0) {
            return;
        }
        this.pumpImmediate = setImmediate(() => {
            this.pumpImmediate = null;
            try {
                this.processNextBatch();
            } catch (error) {
                // No single route or callback may permanently stop all aging jobs.
                this.reportError(error, null, 'pump');
                this.schedulePump();
            }
        });
    }

    reportError(error, job, phase) {
        if (!this.onError) {
            return;
        }
        try {
            this.onError(error, job?.key || null, phase);
        } catch (_error) {
            // Error reporting is deliberately isolated from the scheduler pump.
        }
    }

    checkCurrent(job) {
        if (!job.isCurrent) {
            return true;
        }
        try {
            return Boolean(job.isCurrent(job.targetEpoch));
        } catch (error) {
            this.reportError(error, job, 'isCurrent');
            return false;
        }
    }

    checkExhausted(job) {
        if (!job.isExhausted) {
            return false;
        }
        try {
            return Boolean(job.isExhausted(job.targetEpoch, job.deleted));
        } catch (error) {
            // Exhaustion is an optimization. If it fails, retain the bounded scan
            // instead of risking leaving eligible stale routes behind.
            this.reportError(error, job, 'isExhausted');
            return false;
        }
    }

    isActive(job) {
        return !job.cancelled && !job.finished && this.jobs.get(job.key) === job;
    }

    processNextBatch() {
        const job = this.readyQueue.shift();
        if (!job) {
            return;
        }
        if (!this.isActive(job)) {
            this.schedulePump();
            return;
        }
        if (!this.checkCurrent(job)) {
            this.finishJob(job, 'owner-changed', true);
            this.schedulePump();
            return;
        }
        if (this.checkExhausted(job)) {
            this.finishJob(job, 'exhausted', false);
            this.schedulePump();
            return;
        }

        const deadlineMs = Date.now() + positiveNumber(this.timeBudgetMs, DEFAULT_TIME_BUDGET_MS);
        const batchSize = positiveInteger(this.batchSize, DEFAULT_BATCH_SIZE);
        let processedThisBatch = 0;
        let done = false;

        while (
            processedThisBatch < batchSize &&
            job.scanRemaining > 0 &&
            (processedThisBatch === 0 || Date.now() < deadlineMs)
        ) {
            if (!this.isActive(job) || !this.checkCurrent(job)) {
                this.finishJob(job, 'owner-changed', true);
                this.schedulePump();
                return;
            }

            let next;
            try {
                next = job.iterator.next();
            } catch (error) {
                this.reportError(error, job, 'iterate');
                this.finishJob(job, 'iterator-error', true);
                this.schedulePump();
                return;
            }
            if (next.done) {
                done = true;
                break;
            }

            processedThisBatch += 1;
            job.processed += 1;
            job.scanRemaining -= 1;
            const [routeKey, route] = next.value;
            if (job.routeMap.get(routeKey) !== route) {
                continue;
            }

            let eligible;
            try {
                eligible = job.isEligible
                    ? job.isEligible(route, job.targetEpoch)
                    : Number(route?.ribEpoch || 0) < job.targetEpoch;
            } catch (error) {
                this.reportError(error, job, 'isEligible');
                continue;
            }
            if (!eligible) {
                continue;
            }
            const activeBeforeDelete = this.isActive(job);
            const currentBeforeDelete = activeBeforeDelete && this.checkCurrent(job);
            if (!activeBeforeDelete || !currentBeforeDelete) {
                this.finishJob(job, 'owner-changed', true);
                this.schedulePump();
                return;
            }

            try {
                const accepted = job.onDelete?.(route, routeKey);
                if (accepted === false) {
                    continue;
                }
                // A callback can synchronously learn a replacement route or move
                // ownership to another epoch. Never delete that replacement by key.
                const activeAfterDelete = this.isActive(job);
                const currentAfterDelete = activeAfterDelete && this.checkCurrent(job);
                if (!activeAfterDelete || !currentAfterDelete) {
                    this.finishJob(job, 'owner-changed', true);
                    this.schedulePump();
                    return;
                }
                if (job.routeMap.get(routeKey) !== route) {
                    continue;
                }
                if (job.routeMap.delete(routeKey)) {
                    job.deleted += 1;
                }
            } catch (error) {
                this.reportError(error, job, 'onDelete');
            }

            if (this.checkExhausted(job)) {
                this.finishJob(job, 'exhausted', false);
                this.schedulePump();
                return;
            }
        }

        if (job.scanRemaining === 0) {
            done = true;
        }

        if (!done) {
            this.readyQueue.push(job);
            this.schedulePump();
            return;
        }

        this.finishJob(job, 'completed', false);
        this.schedulePump();
    }

    finishJob(job, reason, aborted) {
        if (!job || job.finished) {
            return;
        }
        job.finished = true;
        job.cancelled = Boolean(aborted);
        if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
        }
        if (this.jobs.get(job.key) === job) {
            this.jobs.delete(job.key);
        }
        this.readyQueue = this.readyQueue.filter(queuedJob => queuedJob !== job);
        try {
            job.onComplete?.(job.deleted, {
                aborted: Boolean(aborted),
                reason,
                key: job.key,
                targetEpoch: job.targetEpoch,
                processed: job.processed
            });
        } catch (error) {
            this.reportError(error, job, 'onComplete');
        }
    }

    cancel(key) {
        const job = this.jobs.get(String(key || ''));
        if (!job) {
            return false;
        }
        this.finishJob(job, 'cancelled', true);
        return true;
    }

    cancelByPrefix(prefix) {
        const normalized = String(prefix || '');
        const matched = [...this.jobs.values()].filter(job => job.key.startsWith(normalized));
        matched.forEach(job => this.finishJob(job, 'cancelled', true));
        return matched.length;
    }

    clear() {
        [...this.jobs.values()].forEach(job => this.finishJob(job, 'cleared', true));
        this.jobs.clear();
        this.readyQueue = [];
        if (this.pumpImmediate) {
            clearImmediate(this.pumpImmediate);
            this.pumpImmediate = null;
        }
    }

    getStatus() {
        return { jobs: this.jobs.size, ready: this.readyQueue.length };
    }
}

module.exports = BmpRouteAgingScheduler;
