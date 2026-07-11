<template>
    <div class="main-layout">
        <!-- 侧边菜单导航 -->
        <div class="sider" :class="{ collapsed: isCollapsed }">
            <div class="toggle-btn" @click="toggleCollapse">
                <nn-button type="text">
                    <template #icon>
                        <MenuFoldOutlined v-if="!isCollapsed" />
                        <MenuUnfoldOutlined v-else />
                    </template>
                </nn-button>
            </div>
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
            <!-- 底部菜单按钮 -->
            <div class="bottom-menu-btn">
                <nn-dropdown :trigger="['click']" placement="topRight">
                    <nn-button type="text">
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
        </div>
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
        ApiOutlined,
        AppstoreOutlined,
        ClockCircleOutlined,
        ClusterOutlined,
        CodeOutlined,
        FileTextOutlined,
        FolderOutlined,
        InfoCircleOutlined,
        KeyOutlined,
        MenuFoldOutlined,
        MenuUnfoldOutlined,
        SafetyOutlined,
        SettingOutlined,
        SwapOutlined,
        ToolOutlined,
        WifiOutlined
    } from '../ui/icons';

    import SettingsDialog from '../components/SettingsDialog.vue';
    import UpdateNotification from '../components/UpdateNotification.vue';
    import modalResizeHandler from '../utils/modalResizeHandler';

    const router = useRouter();
    const route = useRoute();
    const store = useStore();
    const currentComponent = ref(null);
    const isCollapsed = ref(false);
    const openKeys = ref([]);
    const settingsDialog = ref(null);

    const current = ref(['工具集合']);
    const items = ref([
        {
            key: '工具集合',
            icon: h(AppstoreOutlined),
            label: '工具集合',
            title: '工具集合',
            route: '/tools'
        },
        {
            key: 'BGP模拟器',
            icon: h(ApiOutlined),
            label: 'BGP模拟器',
            title: 'BGP模拟器',
            route: '/bgp'
        },
        {
            key: 'BMP服务器',
            icon: h(ClusterOutlined),
            label: 'BMP服务器',
            title: 'BMP服务器',
            route: '/bmp'
        },
        {
            key: 'RPKI服务器',
            icon: h(SafetyOutlined),
            label: 'RPKI服务器',
            title: 'RPKI服务器',
            route: '/rpki'
        },
        {
            key: 'FTP服务器',
            icon: h(FolderOutlined),
            label: 'FTP服务器',
            title: 'FTP服务器',
            route: '/ftp'
        },
        {
            key: 'SNMP服务器',
            icon: h(CodeOutlined),
            label: 'SNMP服务器',
            title: 'SNMP服务器',
            route: '/snmp'
        },
        {
            key: 'DHCP服务器',
            icon: h(WifiOutlined),
            label: 'DHCP服务器',
            title: 'DHCP服务器',
            route: '/dhcp'
        },
        {
            key: 'NTP服务器',
            icon: h(ClockCircleOutlined),
            label: 'NTP服务器',
            title: 'NTP服务器',
            route: '/ntp'
        },
        {
            key: 'RADIUS服务器',
            icon: h(KeyOutlined),
            label: 'RADIUS服务器',
            title: 'RADIUS服务器',
            route: '/radius'
        },
        {
            key: 'TFTP服务器',
            icon: h(SwapOutlined),
            label: 'TFTP服务器',
            title: 'TFTP服务器',
            route: '/tftp'
        },
        {
            key: 'Syslog服务器',
            icon: h(FileTextOutlined),
            label: 'Syslog服务器',
            title: 'Syslog服务器',
            route: '/syslog'
        }
    ]);

    // 菜单点击事件
    const handleSelect = ({ key }) => {
        const selectedItem = items.value.find(item => item.key === key);
        if (selectedItem) {
            // 在导航前确保当前路由已被添加到缓存视图中
            const targetRoute = router.resolve(selectedItem.route);
            if (targetRoute.name) {
                store.dispatch('addCachedView', targetRoute);
            }
            router.push(selectedItem.route);
        }
    };

    // 底部菜单点击事件
    const handleBottomMenuClick = key => {
        if (key === 'developer') {
            window.commonApi.openDeveloperOptions();
        } else if (key === 'about') {
            window.commonApi.openSoftwareInfo();
        } else if (key === 'settings') {
            settingsDialog.value.openDialog();
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
        background-color: var(--nn-color-bg-sider);
        box-shadow: var(--nn-shadow-sider);
        transition: all 0.2s;
        width: 160px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .sider.collapsed {
        width: 60px;
    }

    .toggle-btn {
        padding: 16px 0;
        text-align: right;
        padding-right: 16px;
    }

    .main-menu {
        border-right: none;
        flex: 1;
    }

    .bottom-menu-btn {
        border-top: 1px solid var(--nn-color-border-sider);
        padding: 16px;
        text-align: center;
    }

    .content-container {
        margin-left: 165px;
        transition: all 0.2s;
        width: calc(100% - 165px);
        display: flex;
        padding-right: 20px;
    }

    .content-container.content-expanded {
        margin-left: 65px;
        width: calc(100% - 65px);
    }

    .content-area {
        display: flex;
        flex-direction: column;
        width: 100%;
        box-sizing: border-box;
        background: var(--nn-color-bg-layout);
    }

    /* 菜单图标样式 */
    :deep(.nn-menu-item) {
        display: flex;
        align-items: center;
    }

    :deep(.nn-menu-inline-collapsed .nn-menu-item),
    :deep(.nn-menu-inline-collapsed .nn-menu-submenu-title) {
        padding: 0 calc(30% - 16px / 2) !important;
    }
</style>
