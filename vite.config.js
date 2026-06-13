import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

function collectIconOptimizeDeps() {
    const sourceRoot = path.join(projectRoot, 'src');
    const iconImports = new Set();
    const importPattern = /@ant-design\/icons-vue\/es\/icons\/[A-Za-z0-9]+/g;
    const visit = dir => {
        if (!fs.existsSync(dir)) {
            return;
        }

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
                continue;
            }
            if (!/\.(js|vue)$/.test(entry.name)) {
                continue;
            }

            const content = fs.readFileSync(fullPath, 'utf8');
            for (const match of content.matchAll(importPattern)) {
                iconImports.add(match[0]);
            }
        }
    };

    visit(sourceRoot);
    return Array.from(iconImports).sort();
}

const iconOptimizeDeps = collectIconOptimizeDeps();

// Vite配置文档: https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    base: './', // 必须设置为相对路径
    optimizeDeps: {
        include: iconOptimizeDeps
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) {
                        return undefined;
                    }
                    if (id.includes('/node_modules/@vue/') || id.includes('/node_modules/vue')) {
                        return 'vue-vendor';
                    }
                    if (id.includes('/node_modules/ant-design-vue')) {
                        const antdPath = id.split('/node_modules/ant-design-vue/es/')[1] || '';
                        if (/^(table|vc-table)\//.test(antdPath)) {
                            return 'antd-table';
                        }
                        if (/^(form|input|input-number|select|vc-select|date-picker|vc-picker|checkbox|radio|switch)\//.test(antdPath)) {
                            return 'antd-form';
                        }
                        if (
                            /^(modal|drawer|dropdown|tooltip|popover|popconfirm|message|notification|vc-dialog|vc-drawer|vc-dropdown|vc-trigger|vc-tooltip|vc-notification|vc-align)\//.test(
                                antdPath
                            )
                        ) {
                            return 'antd-overlay';
                        }
                        if (/^(menu|tabs|card|row|col|grid|space|divider|layout)\//.test(antdPath)) {
                            return 'antd-layout';
                        }
                        if (/^(tree|vc-tree)\//.test(antdPath)) {
                            return 'antd-tree';
                        }
                        if (/^(list|descriptions|statistic|tag|badge|empty|alert|spin|typography)\//.test(antdPath)) {
                            return 'antd-display';
                        }
                        return 'antd-core';
                    }
                    if (id.includes('/node_modules/@ant-design/icons-vue')) {
                        return 'antd-icons';
                    }
                    if (id.includes('/node_modules/lodash-es')) {
                        return 'lodash-vendor';
                    }
                    return 'vendor';
                }
            }
        }
    },
    server: {
        host: '127.0.0.1',
        port: 3000
    }
});
