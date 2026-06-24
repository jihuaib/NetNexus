const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, shell } = require('electron');

const execFileAsync = promisify(execFile);

const PLUGIN_FILENAME = 'netnexus-bmp-v4-draft20.lua';
const PLUGIN_RELATIVE_PATH = path.join('resources', 'wireshark', PLUGIN_FILENAME);

class WiresharkPluginInstaller {
    getSourcePath() {
        return path.join(__dirname, '..', PLUGIN_RELATIVE_PATH);
    }

    getTsharkCandidates() {
        const candidates = [];
        if (process.env.WIRESHARK_TSHARK_PATH) {
            candidates.push(process.env.WIRESHARK_TSHARK_PATH);
        }

        if (process.platform === 'darwin') {
            candidates.push('/Applications/Wireshark.app/Contents/MacOS/tshark');
        } else if (process.platform === 'win32') {
            const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
            const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
            candidates.push(
                path.join(programFiles, 'Wireshark', 'tshark.exe'),
                path.join(programFilesX86, 'Wireshark', 'tshark.exe')
            );
        }

        candidates.push(process.platform === 'win32' ? 'tshark.exe' : 'tshark');
        return [...new Set(candidates.filter(Boolean))];
    }

    async findTsharkFolders() {
        for (const candidate of this.getTsharkCandidates()) {
            try {
                const { stdout } = await execFileAsync(candidate, ['-G', 'folders'], {
                    timeout: 5000,
                    windowsHide: true,
                    maxBuffer: 1024 * 1024
                });
                return {
                    tsharkPath: candidate,
                    foldersOutput: stdout
                };
            } catch (_error) {
                // Try the next candidate.
            }
        }

        return {
            tsharkPath: '',
            foldersOutput: ''
        };
    }

    parsePersonalLuaPluginDir(foldersOutput) {
        if (!foldersOutput) {
            return '';
        }

        const line = foldersOutput
            .split(/\r?\n/)
            .find(item => item.trim().toLowerCase().startsWith('personal lua plugins:'));
        if (!line) {
            return '';
        }

        return line.replace(/^Personal Lua Plugins:\s*/i, '').trim();
    }

    getFallbackPluginDir() {
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            return path.join(appData, 'Wireshark', 'plugins');
        }

        return path.join(os.homedir(), '.local', 'lib', 'wireshark', 'plugins');
    }

    async resolvePluginDir() {
        const folders = await this.findTsharkFolders();
        const wiresharkPluginDir = this.parsePersonalLuaPluginDir(folders.foldersOutput);
        return {
            tsharkPath: folders.tsharkPath,
            pluginDir: wiresharkPluginDir || this.getFallbackPluginDir(),
            detectedFromTshark: Boolean(wiresharkPluginDir)
        };
    }

    async filesMatch(sourcePath, installedPath) {
        try {
            const [source, installed] = await Promise.all([
                fs.promises.readFile(sourcePath),
                fs.promises.readFile(installedPath)
            ]);
            return source.equals(installed);
        } catch (_error) {
            return false;
        }
    }

    async getStatus() {
        const sourcePath = this.getSourcePath();
        const sourceExists = fs.existsSync(sourcePath);
        const resolved = await this.resolvePluginDir();
        const installedPath = path.join(resolved.pluginDir, PLUGIN_FILENAME);
        const installed = fs.existsSync(installedPath);
        const upToDate = installed && sourceExists ? await this.filesMatch(sourcePath, installedPath) : false;

        return {
            pluginName: 'BMP v4 TLV draft-20 (NetNexus)',
            pluginFilename: PLUGIN_FILENAME,
            sourcePath,
            sourceExists,
            pluginDir: resolved.pluginDir,
            installedPath,
            installed,
            upToDate,
            tsharkPath: resolved.tsharkPath,
            detectedFromTshark: resolved.detectedFromTshark,
            appUserDataPath: app.getPath('userData')
        };
    }

    async install() {
        const status = await this.getStatus();
        if (!status.sourceExists) {
            throw new Error(`插件资源不存在: ${status.sourcePath}`);
        }

        await fs.promises.mkdir(status.pluginDir, { recursive: true });
        await fs.promises.copyFile(status.sourcePath, status.installedPath);
        return this.getStatus();
    }

    async uninstall() {
        const status = await this.getStatus();
        if (status.installed) {
            try {
                await fs.promises.unlink(status.installedPath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        return this.getStatus();
    }

    async openPluginDirectory() {
        const status = await this.getStatus();
        await fs.promises.mkdir(status.pluginDir, { recursive: true });
        const result = await shell.openPath(status.pluginDir);
        if (result) {
            throw new Error(result);
        }
        return status;
    }
}

module.exports = WiresharkPluginInstaller;
