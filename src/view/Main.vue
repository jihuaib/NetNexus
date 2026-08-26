<template>
    <div class="main-layout">
        <!-- 侧边菜单导航 -->
        <aside class="sider" :class="{ collapsed: isCollapsed }" aria-label="主导航">
            <div class="sidebar-header">
                <div v-if="!isCollapsed" class="sidebar-brand" aria-label="NetNexus 网络工具套件">
                    <img class="sidebar-brand-logo" :src="appLogoUrl" alt="" aria-hidden="true" />
                    <span class="sidebar-brand-copy">
                        <strong>NetNexus</strong>
                        <small>网络工具套件</small>
                    </span>
                </div>
                <nn-button
                    type="text"
                    class="toggle-btn"
                    :aria-label="isCollapsed ? '展开侧边栏' : '收起侧边栏'"
                    :title="isCollapsed ? '展开侧边栏' : '收起侧边栏'"
                    @click="toggleCollapse"
                >
                    <template #icon>
                        <MenuFoldOutlined v-if="!isCollapsed" />
                        <MenuUnfoldOutlined v-else />
                    </template>
                </nn-button>
            </div>
            <nav class="sidebar-nav" aria-label="功能模块">
                <nn-menu
                    v-model:selected-keys="current"
                    mode="inline"
                    :items="items"
                    class="main-menu"
                    :inline-collapsed="isCollapsed"
                    :open-keys="!isCollapsed ? openKeys : []"
                    @select="handleSelect"
                    @open-change="onOpenChange"
                />
            </nav>
            <!-- 底部菜单按钮 -->
            <div class="bottom-menu-btn">
                <nn-dropdown :trigger="['click']" placement="topRight">
                    <nn-button type="text" aria-label="更多选项" title="更多选项">
                        <template #icon><SettingOutlined /></template>
                        <span v-if="!isCollapsed">更多选项</span>
                    </nn-button>
                    <template #overlay>
                        <nn-menu>
                            <nn-menu-item key="settings" @click="handleBottomMenuClick('settings')">
                                <nn-space>
                                    <SettingOutlined />
                                    <span>设置</span>
                                </nn-space>
                            </nn-menu-item>
                            <nn-menu-item
                                key="process-resource-manager"
                                data-testid="open-process-resource-manager"
                                @click="handleBottomMenuClick('process-resource-manager')"
                            >
                                <nn-space>
                                    <ClusterOutlined />
                                    <span>进程资源管理器</span>
                                </nn-space>
                            </nn-menu-item>
                            <nn-menu-item key="developer" @click="handleBottomMenuClick('developer')">
                                <nn-space>
                                    <ToolOutlined />
                                    <span>开发人员选项</span>
                                </nn-space>
                            </nn-menu-item>
                            <nn-menu-item key="about" @click="handleBottomMenuClick('about')">
                                <nn-space>
                                    <InfoCircleOutlined />
                                    <span>关于</span>
                                </nn-space>
                            </nn-menu-item>
                        </nn-menu>
                    </template>
                </nn-dropdown>
            </div>
        </aside>
        <!-- 内容区域 -->
        <div class="content-container" :class="{ 'content-expanded': isCollapsed }">
            <div class="content-area">
                <router-view v-slot="{ Component }">
                    <keep-alive :include="$store.state.cachedViews">
                        <component :is="Component" ref="currentComponent" @open-settings="handleOpenSettings" />
                    </keep-alive>
                </router-view>
            </div>
        </div>

        <!-- 设置弹窗 -->
        <SettingsDialog ref="settingsDialog" />

        <!-- 更新通知 -->
        <UpdateNotification />
    </div>
</template>

<script setup>
    import { ref, watch, h, onMounted, onUnmounted } from 'vue';
    import { useRouter, useRoute } from 'vue-router';
    import { useStore } from 'vuex';
    import {
        ClusterOutlined,
        InfoCircleOutlined,
        MenuFoldOutlined,
        MenuUnfoldOutlined,
        SettingOutlined,
        ToolOutlined
    } from 'netnexus-ui/icons';
    import { moduleNavigationIcons } from '../const/navigationIcons';

    import SettingsDialog from '../components/SettingsDialog.vue';
    import UpdateNotification from '../components/UpdateNotification.vue';
    import modalResizeHandler from '../utils/modalResizeHandler';
    import { notify } from '../utils/notify';
    import appLogoUrl from '../../electron/assets/logo.png';

    const router = useRouter();
    const route = useRoute();
    const store = useStore();
    const currentComponent = ref(null);
    const isCollapsed = ref(false);
    const openKeys = ref([]);
    const settingsDialog = ref(null);
    const processResourceOpening = ref(false);

    const current = ref(['工具集合']);
    const items = ref([
        {
            key: '工具集合',
            icon: h(moduleNavigationIcons.tools),
            label: '工具',
            title: '工具集合',
            route: '/tools'
        },
        {
            key: 'BGP模拟器',
            icon: h(moduleNavigationIcons.bgp),
            label: 'BGP',
            title: 'BGP模拟器',
            route: '/bgp'
        },
        {
            key: 'BMP服务器',
            icon: h(moduleNavigationIcons.bmp),
            label: 'BMP',
            title: 'BMP服务器',
            route: '/bmp'
        },
        {
            key: 'RPKI服务器',
            icon: h(moduleNavigationIcons.rpki),
            label: 'RPKI',
            title: 'RPKI服务器',
            route: '/rpki'
        },
        {
            key: 'FTP服务器',
            icon: h(moduleNavigationIcons.ftp),
            label: 'FTP',
            title: 'FTP服务器',
            route: '/ftp'
        },
        {
            key: 'SNMP服务器',
            icon: h(moduleNavigationIcons.snmp),
            label: 'SNMP',
            title: 'SNMP服务器',
            route: '/snmp'
        },
        {
            key: 'YANG',
            icon: h(moduleNavigationIcons.yang),
            label: 'YANG',
            title: 'YANG',
            route: '/yang'
        },
        {
            key: 'DHCP服务器',
            icon: h(moduleNavigationIcons.dhcp),
            label: 'DHCP',
            title: 'DHCP服务器',
            route: '/dhcp'
        },
        {
            key: 'NTP服务器',
            icon: h(moduleNavigationIcons.ntp),
            label: 'NTP',
            title: 'NTP服务器',
            route: '/ntp'
        },
        {
            key: 'RADIUS服务器',
            icon: h(moduleNavigationIcons.radius),
            label: 'RADIUS',
            title: 'RADIUS服务器',
            route: '/radius'
        },
        {
            key: 'TFTP服务器',
            icon: h(moduleNavigationIcons.tftp),
            label: 'TFTP',
            title: 'TFTP服务器',
            route: '/tftp'
        },
        {
            key: 'Syslog服务器',
            icon: h(moduleNavigationIcons.syslog),
            label: 'Syslog',
            title: 'Syslog服务器',
            route: '/syslog'
        },
        {
            key: 'gRPC服务器',
            icon: h(moduleNavigationIcons.grpc),
            label: 'gRPC',
            title: 'gRPC服务器',
            route: '/grpc'
        }
    ]);

    // 菜单点击事件
    const handleSelect = ({ key }) => {
        const selectedItem = items.value.find(item => item.key === key);
        if (selectedItem) {
            const isCurrentSection =
                route.path === selectedItem.route || route.path.startsWith(`${selectedItem.route}/`);
            if (isCurrentSection) {
                return;
            }

            // 在导航前确保当前路由已被添加到缓存视图中
            const targetRoute = router.resolve(selectedItem.route);
            if (targetRoute.name) {
                store.dispatch('addCachedView', targetRoute);
            }
            router.push(selectedItem.route);
        }
    };

    // 底部菜单点击事件
    const openProcessResourceManager = async () => {
        if (processResourceOpening.value) return;
        if (typeof window.windowApi?.openMonitor !== 'function') {
            notify.error('进程资源管理器仅支持桌面版');
            return;
        }

        processResourceOpening.value = true;
        try {
            const result = await window.windowApi.openMonitor('process-resource-manager');
            if (result?.status !== 'success') {
                notify.error(result?.msg || '打开进程资源管理器失败');
            }
        } catch (error) {
            notify.error('打开进程资源管理器失败: ' + error.message);
        } finally {
            processResourceOpening.value = false;
        }
    };

    const handleBottomMenuClick = key => {
        if (key === 'developer') {
            window.commonApi.openDeveloperOptions();
        } else if (key === 'about') {
            window.commonApi.openSoftwareInfo();
        } else if (key === 'settings') {
            settingsDialog.value.openDialog();
        } else if (key === 'process-resource-manager') {
            openProcessResourceManager();
        }
    };

    // Handle opening settings from child components
    const handleOpenSettings = category => {
        settingsDialog.value.openDialog(category);
    };

    // 切换菜单收缩状态
    const toggleCollapse = () => {
        isCollapsed.value = !isCollapsed.value;
    };

    // 控制展开的子菜单
    const onOpenChange = keys => {
        openKeys.value = keys;
    };

    const syncCurrentMenuFromRoute = () => {
        const path = route.path || '/tools';
        const matchedItem = items.value.find(item => path === item.route || path.startsWith(`${item.route}/`));
        if (matchedItem) {
            current.value = [matchedItem.key];
        }
    };

    // 监听路由变化
    watch(
        () => route.path,
        () => {
            syncCurrentMenuFromRoute();
            // 路由变化时清空验证错误
            if (currentComponent.value && typeof currentComponent.value.clearValidationErrors === 'function') {
                currentComponent.value.clearValidationErrors();
            }
        },
        { immediate: true }
    );

    // 组件挂载时初始化缓存
    onMounted(() => {
        // 确保初始路由被正确缓存
        if (route.name && route.meta.keepAlive) {
            store.dispatch('addCachedView', route);
        }
        syncCurrentMenuFromRoute();

        // 初始化时检查窗口宽度
        handleSidebarResize();

        // 注册到 modalResizeHandler 的回调
        modalResizeHandler.onZoomChange(handleSidebarResize);
    });

    // 组件卸载时移除监听器
    onUnmounted(() => {
        modalResizeHandler.offZoomChange(handleSidebarResize);
    });

    // 处理侧边栏响应式调整
    const handleSidebarResize = () => {
        const width = window.innerWidth;
        // 当窗口宽度小于1200px时自动收缩侧边栏
        if (width < 1200 && !isCollapsed.value) {
            isCollapsed.value = true;
        }
        // 当窗口宽度大于等于1200px时自动展开侧边栏
        else if (width >= 1200 && isCollapsed.value) {
            isCollapsed.value = false;
        }
    };
</script>

<style scoped>
    .main-layout {
        --sidebar-width: 160px;
        --sidebar-collapsed-width: 64px;

        width: 100%;
        min-height: 100vh;
        display: flex;
        flex-direction: row;
        background: var(--nn-color-bg-layout);
        color: var(--nn-color-text);
    }

    .sider {
        height: 100vh;
        position: fixed;
        left: 0;
        top: 0;
        z-index: 1000;
        border-right: 1px solid var(--nn-color-border);
        background: var(--nn-color-bg-surface);
        box-shadow: none;
        transition: width 0.2s ease;
        width: var(--sidebar-width);
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .sider.collapsed {
        width: var(--sidebar-collapsed-width);
    }

    .sidebar-header {
        height: 66px;
        padding: 0 8px;
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        border-bottom: 1px solid var(--nn-color-border);
    }

    .sidebar-brand {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 7px;
    }

    .sidebar-brand-logo {
        width: 30px;
        height: 30px;
        display: block;
        flex: 0 0 auto;
        border: 1px solid var(--nn-color-border);
        border-radius: 2px;
        box-shadow: none;
        object-fit: cover;
    }

    .sidebar-brand-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        line-height: 1.15;
    }

    .sidebar-brand-copy strong {
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.2px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .sidebar-brand-copy small {
        margin-top: 4px;
        overflow: hidden;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
        letter-spacing: 0.8px;
        opacity: 0.72;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .toggle-btn {
        flex: 0 0 auto;
    }

    .sider.collapsed .sidebar-header {
        padding-inline: 0;
        justify-content: center;
    }

    .sidebar-nav {
        min-height: 0;
        padding: 8px 6px;
        overflow-x: hidden;
        overflow-y: auto;
        flex: 1 1 auto;
        background: var(--nn-color-bg-muted);
    }

    .main-menu {
        border-right: none;
        padding: 0;
    }

    .bottom-menu-btn {
        border-top: 1px solid var(--nn-color-border);
        padding: 10px 12px 12px;
        flex: 0 0 auto;
    }

    .bottom-menu-btn :deep(.nn-dropdown),
    .bottom-menu-btn :deep(.nn-dropdown-trigger),
    .bottom-menu-btn :deep(.nn-button) {
        width: 100%;
    }

    .bottom-menu-btn :deep(.nn-button) {
        height: 36px;
        justify-content: flex-start;
        gap: 9px;
        padding-inline: 10px;
        border-radius: 2px;
        font-size: 13px;
    }

    .sider.collapsed .bottom-menu-btn {
        padding-inline: 8px;
    }

    .sider.collapsed .bottom-menu-btn :deep(.nn-button) {
        justify-content: center;
        gap: 0;
        padding-inline: 0;
    }

    .sider.collapsed .bottom-menu-btn :deep(.nn-button-content) {
        display: none;
    }

    .content-container {
        margin-left: var(--sidebar-width);
        transition:
            margin-left 0.2s ease,
            width 0.2s ease;
        width: calc(100% - var(--sidebar-width));
        display: flex;
    }

    .content-container.content-expanded {
        margin-left: var(--sidebar-collapsed-width);
        width: calc(100% - var(--sidebar-collapsed-width));
    }

    .content-area {
        display: flex;
        flex-direction: column;
        width: 100%;
        box-sizing: border-box;
        background: var(--nn-color-bg-surface);
    }

    /* 菜单图标样式 */
    :deep(.nn-menu-item) {
        display: flex;
        align-items: center;
    }

    :deep(.nn-menu-inline-collapsed .nn-menu-item),
    :deep(.nn-menu-inline-collapsed .nn-menu-submenu-title) {
        padding-inline: 0 !important;
    }

    @media (prefers-reduced-motion: reduce) {
        .sider,
        .content-container {
            transition: none;
        }
    }
</style>
