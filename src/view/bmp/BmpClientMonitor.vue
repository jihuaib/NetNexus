<template>
    <div class="bmp-client-monitor" data-testid="bmp-client-monitor-page">
        <nn-tabs
            v-model:active-key="activeView"
            class="bmp-client-monitor-tabs"
            :animated="false"
            @change="handleViewChange"
        >
            <nn-tab-pane v-for="view in monitorViews" :key="view.key" :tab="view.label">
                <div class="bmp-client-monitor-content">
                    <keep-alive>
                        <component :is="view.component" v-if="activeView === view.key" :client-key="lockedClientKey" />
                    </keep-alive>
                </div>
            </nn-tab-pane>
        </nn-tabs>
    </div>
</template>

<script setup>
    import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import EventBus from '../../utils/eventBus';
    import BgpSession from './BgpSession.vue';
    import BgpLocRib from './BgpLocRib.vue';
    import BgpSessionStatisReport from './BgpSessionStatisReport.vue';
    import BgpLocRibStatisReport from './BgpLocRibStatisReport.vue';

    defineOptions({ name: 'BmpClientMonitor' });

    const MONITOR_EVENT_ID = 'bmp-client-monitor-shell';
    const DEFAULT_VIEW = 'session';
    const monitorViews = Object.freeze([
        { key: 'session', label: 'BGP 会话', component: BgpSession },
        { key: 'loc-rib', label: 'Loc-RIB', component: BgpLocRib },
        { key: 'session-statistics', label: '会话统计', component: BgpSessionStatisReport },
        { key: 'loc-rib-statistics', label: 'Loc-RIB 统计', component: BgpLocRibStatisReport }
    ]);
    const monitorViewKeys = new Set(monitorViews.map(view => view.key));

    const route = useRoute();
    const router = useRouter();
    const parentMonitorWindowTitle = inject('monitorWindowTitle', null);
    // 子页面原先各自维护窗口标题；统一 Client 窗口只允许本容器维护一次。
    provide('monitorWindowTitle', null);

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
        });

    const getRouteQueryString = value => {
        const queryValue = Array.isArray(value) ? value[0] : value;
        if (typeof queryValue !== 'string' || queryValue.length === 0 || queryValue.length > 512) {
            return '';
        }
        return hasControlCharacter(queryValue) ? '' : queryValue;
    };

    const normalizeView = value => {
        const view = getRouteQueryString(value);
        return monitorViewKeys.has(view) ? view : DEFAULT_VIEW;
    };

    const lockedClientKey = computed(() => getRouteQueryString(route.query.clientKey));
    const activeView = ref(normalizeView(route.query.view || route.query.tab));
    const monitoredClient = ref(null);
    let clientRequestId = 0;
    let pageActive = false;

    const getClientSourceId = client => client?.persistentSourceId || client?.sourceId || '';
    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const clientMatchesKey = (client, clientKey) => {
        if (!client || !clientKey) return false;
        if (clientKey.startsWith('source:')) {
            const sourceId = getClientSourceId(client);
            return Boolean(sourceId) && `source:${String(sourceId).toLowerCase()}` === clientKey.toLowerCase();
        }
        return clientKey.startsWith('connection:') && `connection:${getClientTransportKey(client)}` === clientKey;
    };

    const activeViewLabel = computed(
        () => monitorViews.find(view => view.key === activeView.value)?.label || monitorViews[0].label
    );
    const monitorWindowTitleText = computed(() => {
        const clientLabel = monitoredClient.value ? formatBmpClientLabel(monitoredClient.value) : '';
        return [activeViewLabel.value, clientLabel].filter(Boolean).join(' · ');
    });
    const monitorTitleOwner = Symbol('bmp-client-monitor-title');
    watch(
        monitorWindowTitleText,
        title => parentMonitorWindowTitle?.setTitle(monitorTitleOwner, title || 'BMP Client 监控'),
        { immediate: true }
    );

    const loadMonitoredClient = async () => {
        const requestedClientKey = lockedClientKey.value;
        const requestId = ++clientRequestId;
        if (!requestedClientKey) {
            monitoredClient.value = null;
            return;
        }
        try {
            const result = await window.bmpApi.getClient(requestedClientKey);
            if (!pageActive || requestId !== clientRequestId || requestedClientKey !== lockedClientKey.value) return;
            monitoredClient.value =
                result?.status === 'success' && clientMatchesKey(result.data, requestedClientKey) ? result.data : null;
        } catch (error) {
            if (!pageActive || requestId !== clientRequestId || requestedClientKey !== lockedClientKey.value) return;
            console.error('加载 BMP Client 窗口标题失败', error);
            monitoredClient.value = null;
        }
    };

    const onInitiation = result => {
        if (result?.status !== 'success' || !clientMatchesKey(result.data, lockedClientKey.value)) return;
        monitoredClient.value = { ...(monitoredClient.value || {}), ...result.data };
    };

    const onTermination = result => {
        if (result?.status !== 'success') return;
        if (!result.data) {
            if (monitoredClient.value) {
                monitoredClient.value = {
                    ...monitoredClient.value,
                    isOnline: false,
                    connectionState: 'closed'
                };
            }
            return;
        }
        if (!clientMatchesKey(result.data, lockedClientKey.value)) return;
        monitoredClient.value = {
            ...(monitoredClient.value || {}),
            ...result.data,
            isOnline: false,
            connectionState: 'closed'
        };
    };

    const handleViewChange = view => {
        const normalizedView = normalizeView(view);
        if (normalizedView !== activeView.value) activeView.value = normalizedView;
        const nextQuery = { ...route.query, view: normalizedView };
        delete nextQuery.tab;
        router.replace({ query: nextQuery }).catch(() => {});
    };

    watch(
        () => route.query.view || route.query.tab,
        view => {
            activeView.value = normalizeView(view);
        }
    );

    watch(lockedClientKey, () => {
        clientRequestId += 1;
        monitoredClient.value = null;
        if (pageActive) loadMonitoredClient();
    });

    onMounted(() => {
        pageActive = true;
        EventBus.on('bmp:initiation', MONITOR_EVENT_ID, onInitiation);
        EventBus.on('bmp:termination', MONITOR_EVENT_ID, onTermination);
        loadMonitoredClient();
    });

    onBeforeUnmount(() => {
        pageActive = false;
        clientRequestId += 1;
        EventBus.off('bmp:initiation', MONITOR_EVENT_ID);
        EventBus.off('bmp:termination', MONITOR_EVENT_ID);
        parentMonitorWindowTitle?.clearTitle(monitorTitleOwner);
    });
</script>

<style scoped>
    .bmp-client-monitor {
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .bmp-client-monitor-tabs {
        display: flex;
        height: 100%;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-client-monitor-tabs > :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 4px;
    }

    .bmp-client-monitor-tabs > :deep(.nn-tabs-content-holder),
    .bmp-client-monitor-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content),
    .bmp-client-monitor-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane) {
        display: flex;
        flex: 1 1 0;
        height: 100%;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-client-monitor-content {
        flex: 1 1 0;
        width: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .bmp-client-monitor-content > :deep(.nn-container) {
        width: 100%;
        height: 100%;
        min-height: 0;
        margin: 0;
    }

    .bmp-client-monitor-content :deep(.bmp-full-card > .nn-card-body) {
        padding-top: 2px !important;
    }

    .bmp-client-monitor-content :deep(.bmp-inner-tabs > .nn-tabs-nav) {
        margin-bottom: 4px;
    }
</style>
