const Store = require('electron-store');

class ChangelogState {
    constructor(userDataPath, version) {
        this.userDataPath = userDataPath;
        this.version = version;
        this.store = null;
    }

    getStore() {
        if (!this.store) {
            this.store = new Store({
                name: 'Changelog State',
                // Viewed releases are application metadata and must survive major-version JSON cleanup.
                fileExtension: 'state',
                cwd: this.userDataPath,
                schema: {
                    seenVersions: {
                        type: 'array',
                        items: { type: 'string' },
                        uniqueItems: true
                    }
                }
            });
        }
        return this.store;
    }

    getState() {
        const seenVersions = this.getStore().get('seenVersions', []);
        return {
            version: this.version,
            shouldShow: !seenVersions.includes(this.version)
        };
    }

    markSeen(version) {
        if (typeof version !== 'string' || version !== this.version) {
            throw new TypeError('更新日志版本与当前版本不匹配');
        }
        const store = this.getStore();
        const seenVersions = store.get('seenVersions', []);
        if (!seenVersions.includes(version)) {
            store.set('seenVersions', [...seenVersions, version]);
        }
        return { version: this.version, shouldShow: false };
    }
}

module.exports = ChangelogState;
