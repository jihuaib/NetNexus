const { Client } = require('ssh2');
const path = require('path');
const logger = require('../log/logger');

/**
 * Deploy BMP MD5 proxy to Linux via SSH
 * Uploads socat proxy script and configures the server
 */
class SshDeployer {
    constructor() {
        this.conn = null;
    }

    /**
     * Connect to SSH server
     */
    async connect(host, username, password) {
        return new Promise((resolve, reject) => {
            this.conn = new Client();

            this.conn.on('ready', () => {
                logger.info(`SSH connection established to ${host}`);
                resolve();
            });

            this.conn.on('error', err => {
                logger.error(`SSH connection error: ${err.message}`);
                reject(err);
            });

            this.conn.connect({
                host: host,
                port: 22,
                username: username,
                password: password
            });
        });
    }

    /**
     * Execute command on remote server
     */
    async execCommand(command) {
        logger.info(`Executing command: ${command}`);
        return new Promise((resolve, reject) => {
            this.conn.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('close', code => {
                    if (code !== 0) {
                        reject(new Error(`Command failed with code ${code}: ${stderr}`));
                    } else {
                        resolve(stdout);
                    }
                });

                stream.on('data', data => {
                    stdout += data.toString();
                });

                stream.stderr.on('data', data => {
                    stderr += data.toString();
                });
            });
        });
    }

    /**
     * Upload file to remote server
     */
    async uploadFile(localPath, remotePath) {
        return new Promise((resolve, reject) => {
            this.conn.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }

                sftp.fastPut(localPath, remotePath, err => {
                    if (err) {
                        reject(err);
                    } else {
                        logger.info(`Uploaded ${localPath} to ${remotePath}`);
                        resolve();
                    }
                });
            });
        });
    }

    /**
     * Deploy BMP MD5 proxy to remote server
     */
    async deploy() {
        logger.info('Starting proxy deployment...');

        try {
            const fs = require('fs');
            const scriptsDir = path.join(__dirname, '../../scripts');

            // 使用临时目录上传文件，然后用 sudo 移动到 /opt
            const tempMd5Dir = '/tmp/tcp-md5-proxy';
            const md5ProxyDir = '/opt/tcp-md5-proxy';

            // 创建临时目录
            await this.execCommand(`mkdir -p ${tempMd5Dir}`);
            logger.info('Created temp directories');

            // 读取 scripts 目录中的所有文件
            const scriptFiles = fs.readdirSync(scriptsDir);
            logger.info(`Found ${scriptFiles.length} files in scripts directory`);

            // 分类并上传文件
            for (const file of scriptFiles) {
                const localPath = path.join(scriptsDir, file);
                const stats = fs.statSync(localPath);

                // 跳过目录
                if (stats.isDirectory()) {
                    continue;
                }

                if (!file.includes('tcp-md5')) {
                    continue;
                }

                await this.uploadFile(localPath, `${tempMd5Dir}/${file}`);
                logger.info(`Uploaded ${file} to ${tempMd5Dir}`);
            }

            // 创建目标目录并移动文件
            await this.execCommand(`sudo mkdir -p ${md5ProxyDir}`);
            await this.execCommand(`sudo cp -r ${tempMd5Dir}/* ${md5ProxyDir}/`);
            logger.info('Moved files to target directories');

            // Make scripts executable
            await this.execCommand(`sudo chmod +x ${md5ProxyDir}/*.sh`);
            logger.info('Made scripts executable');

            // Install gcc if not present
            logger.info('Checking for gcc...');
            try {
                await this.execCommand('which gcc');
                logger.info('gcc is already installed');
            } catch (error) {
                logger.info('Installing gcc...');
                await this.execCommand('sudo yum install -y gcc || sudo apt-get install -y gcc');
                logger.info('gcc installed successfully');
            }

            // Compile TCP MD5 helper
            logger.info('Compiling TCP MD5 helper...');
            await this.execCommand(`sudo gcc -g -o ${md5ProxyDir}/tcp-md5-helper ${md5ProxyDir}/tcp-md5-helper.c`);
            logger.info('TCP MD5 helper compiled successfully');

            // Disable firewall
            await this.disableFirewall();

            logger.info('All proxy files deployment completed successfully');

            return {
                md5ProxyDir,
                md5HelperPath: `${md5ProxyDir}/tcp-md5-helper`,
                md5ScriptPath: `${md5ProxyDir}/tcp-md5-proxy.sh`
            };
        } catch (error) {
            logger.error(`Deployment failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Disable firewall on remote server
     */
    async disableFirewall() {
        try {
            // Try to disable ufw (Ubuntu/Debian)
            try {
                // Check if system is Ubuntu/Debian
                const osRelease = await this.execCommand('cat /etc/os-release 2>/dev/null || echo ""');
                const isUbuntuDebian = osRelease.includes('Ubuntu') || osRelease.includes('Debian');

                if (isUbuntuDebian) {
                    // Check if ufw is installed
                    let ufwInstalled = false;
                    try {
                        await this.execCommand('which ufw 2>/dev/null');
                        ufwInstalled = true;
                    } catch (e) {
                        // ufw not installed, try to install it
                        logger.info('UFW not found on Ubuntu/Debian, installing...');
                        try {
                            await this.execCommand('sudo apt-get update -qq 2>/dev/null');
                            await this.execCommand('sudo apt-get install -y ufw 2>/dev/null');
                            ufwInstalled = true;
                            logger.info('UFW installed successfully');
                        } catch (installError) {
                            logger.warn('Failed to install UFW, skipping firewall disable');
                        }
                    }

                    // Disable ufw if installed
                    if (ufwInstalled) {
                        await this.execCommand('sudo ufw disable 2>/dev/null');
                        logger.info('UFW (Ubuntu firewall) disabled');
                    }
                }
            } catch (e) {
                // Not Ubuntu/Debian or ufw operations failed
            }

            // Try to stop and disable firewalld (CentOS 7/8, RHEL)
            try {
                await this.execCommand('systemctl stop firewalld 2>/dev/null');
                await this.execCommand('systemctl disable firewalld 2>/dev/null');
                logger.info('Firewalld stopped and disabled');
            } catch (e) {
                // Firewalld not present
            }

            // Try to stop and disable iptables (CentOS 6)
            try {
                await this.execCommand('service iptables stop 2>/dev/null');
                await this.execCommand('chkconfig iptables off 2>/dev/null');
                logger.info('iptables stopped and disabled');
            } catch (e) {
                // iptables not present
            }

            logger.info('Firewall disabled successfully');
        } catch (error) {
            logger.warn(`Could not disable firewall: ${error.message}`);
        }
    }

    /**
     * Disconnect from SSH server
     */
    disconnect() {
        if (this.conn) {
            this.conn.end();
            this.conn = null;
            logger.info('SSH connection closed');
        }
    }
}

module.exports = SshDeployer;
