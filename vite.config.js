import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Vite配置文档: https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    base: './', // 必须设置为相对路径
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
                    if (id.includes('/node_modules/@lucide/vue')) {
                        return 'lucide-icons';
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
