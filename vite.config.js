import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, transformWithEsbuild } from 'vite';
import vue from '@vitejs/plugin-vue';
import localUiSource from './scripts/local-ui-source.js';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const { LOCAL_UI_OPTIMIZE_EXCLUDES, createLocalUiAliases, resolveLocalUiRoot } = localUiSource;
const localUiRoot = resolveLocalUiRoot(projectRoot, process.env.NETNEXUS_UI_SOURCE);
const localUiAliases = createLocalUiAliases(localUiRoot);

// Vite配置文档: https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue(),
        {
            name: 'bgp-shared-helpers',
            enforce: 'pre',
            transform(code, id) {
                const filename = id.split('?')[0];
                if (
                    [
                        '/shared/bgpExtendedCommunities.js',
                        '/shared/bgpRouteDistinguisher.js',
                        '/shared/bgpAttributeConditions.js',
                        '/shared/bgpEvpnSrv6.js'
                    ].some(path => filename.endsWith(path))
                ) {
                    return transformWithEsbuild(code, id, { format: 'esm', loader: 'js' });
                }
            }
        }
    ],
    base: './', // 必须设置为相对路径
    resolve: {
        alias: localUiAliases,
        dedupe: ['vue', '@lucide/vue']
    },
    ...(localUiRoot
        ? {
              optimizeDeps: {
                  exclude: [...LOCAL_UI_OPTIMIZE_EXCLUDES]
              }
          }
        : {}),
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
        port: 3000,
        strictPort: true,
        ...(localUiRoot
            ? {
                  fs: {
                      allow: [projectRoot, localUiRoot]
                  }
              }
            : {})
    }
});
