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
        chunkSizeWarningLimit: 1000,
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
                        return 'antd-vendor';
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
