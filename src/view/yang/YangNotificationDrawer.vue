<template>
    <nn-drawer
        :open="open"
        title="NETCONF 通知记录"
        width="min(1180px, calc(100vw - 24px))"
        placement="right"
        :body-style="{ padding: '0', overflow: 'hidden' }"
        @update:open="value => emit('update:open', value)"
    >
        <div class="notification-browser" data-testid="netconf-notification-drawer">
            <div class="notification-browser-toolbar">
                <div class="notification-browser-heading">
                    <strong>通知浏览器</strong>
                    <span>当前运行 {{ records.length }} 条 · 未读 {{ unreadCount }}</span>
                </div>
                <div class="notification-browser-filters">
                    <nn-input-search
                        :value="query"
                        allow-clear
                        placeholder="全文筛选通知名称、设备或 XML"
                        class="notification-search"
                        aria-label="全文筛选 NETCONF 通知"
                        @update:value="setQuery"
                    />
                    <nn-checkbox
                        :checked="unreadOnly"
                        class="notification-unread-filter"
                        @update:checked="setUnreadOnly"
                    >
                        只看未读
                    </nn-checkbox>
                </div>
                <div class="notification-browser-actions">
                    <nn-button
                        size="small"
                        :disabled="visibleRecords.length === 0"
                        title="将当前分组中的全部通知标为已读"
                        @click="markVisibleRead"
                    >
                        全部已读
                    </nn-button>
                    <nn-button
                        size="small"
                        :disabled="visibleRecords.length === 0"
                        title="导出当前分组及当前筛选结果"
                        @click="exportVisible"
                    >
                        <template #icon><DownloadOutlined /></template>
                        导出
                    </nn-button>
                    <nn-popconfirm
                        title="清空当前分组中的通知？"
                        ok-text="清空"
                        cancel-text="取消"
                        @confirm="clearVisibleScope"
                    >
                        <nn-button danger size="small" :disabled="visibleRecords.length === 0">
                            <template #icon><DeleteOutlined /></template>
                            清空
                        </nn-button>
                    </nn-popconfirm>
                </div>
            </div>

            <div class="notification-browser-layout">
                <aside class="notification-scope-pane" aria-label="通知 Session 与订阅分组">
                    <div class="notification-pane-title">Session / Subscription</div>
                    <div class="notification-scope-list" role="tree">
                        <button
                            type="button"
                            role="treeitem"
                            class="notification-scope-item notification-scope-all"
                            :class="{ 'notification-scope-item-active': allGroup.key === selectedScopeKey }"
                            :aria-selected="allGroup.key === selectedScopeKey ? 'true' : 'false'"
                            @click="selectScope(allGroup.scope)"
                        >
                            <span class="notification-scope-label">
                                <BellOutlined />
                                {{ allGroup.label }}
                            </span>
                            <span class="notification-scope-counts">
                                <span v-if="allGroup.unread" class="notification-unread-count">
                                    {{ allGroup.unread }}
                                </span>
                                <span>{{ allGroup.count }}</span>
                            </span>
                        </button>

                        <section v-for="profile in profileGroups" :key="profile.key" class="notification-profile-group">
                            <button
                                type="button"
                                role="treeitem"
                                :aria-level="1"
                                class="notification-scope-item notification-profile-item"
                                :class="{ 'notification-scope-item-active': profile.key === selectedScopeKey }"
                                :aria-selected="profile.key === selectedScopeKey ? 'true' : 'false'"
                                :title="profile.label"
                                @click="selectScope(profile.scope)"
                            >
                                <span class="notification-scope-label">
                                    <CloudServerOutlined />
                                    <span class="notification-scope-text">{{ profile.label }}</span>
                                </span>
                                <span class="notification-scope-counts">
                                    <span v-if="profile.unread" class="notification-unread-count">
                                        {{ profile.unread }}
                                    </span>
                                    <span>{{ profile.count }}</span>
                                </span>
                            </button>

                            <div
                                v-for="session in profile.children"
                                :key="session.key"
                                class="notification-session-group"
                            >
                                <button
                                    type="button"
                                    role="treeitem"
                                    :aria-level="2"
                                    class="notification-scope-item notification-session-item"
                                    :class="{ 'notification-scope-item-active': session.key === selectedScopeKey }"
                                    :aria-selected="session.key === selectedScopeKey ? 'true' : 'false'"
                                    @click="selectScope(session.scope)"
                                >
                                    <span class="notification-scope-label">
                                        <ApiOutlined />
                                        <span class="notification-scope-text">{{ session.label }}</span>
                                    </span>
                                    <span class="notification-scope-counts">
                                        <span v-if="session.unread" class="notification-unread-count">
                                            {{ session.unread }}
                                        </span>
                                        <span>{{ session.count }}</span>
                                    </span>
                                </button>

                                <button
                                    v-for="subscription in session.children"
                                    :key="subscription.key"
                                    type="button"
                                    role="treeitem"
                                    :aria-level="3"
                                    class="notification-scope-item notification-subscription-item"
                                    :class="{
                                        'notification-scope-item-active': subscription.key === selectedScopeKey
                                    }"
                                    :aria-selected="subscription.key === selectedScopeKey ? 'true' : 'false'"
                                    :title="subscriptionTitle(subscription)"
                                    @click="selectScope(subscription.scope)"
                                >
                                    <span class="notification-scope-label">
                                        <span
                                            class="notification-subscription-state"
                                            :class="`notification-subscription-state-${subscription.status}`"
                                            aria-hidden="true"
                                        />
                                        <span class="notification-scope-text">{{ subscription.label }}</span>
                                    </span>
                                    <span class="notification-scope-counts">
                                        <span
                                            class="notification-subscription-status"
                                            :class="`notification-subscription-status-${subscription.status}`"
                                        >
                                            {{ subscriptionStatusLabel(subscription.status) }}
                                        </span>
                                        <span v-if="subscription.unread" class="notification-unread-count">
                                            {{ subscription.unread }}
                                        </span>
                                        <span>{{ subscription.count }}</span>
                                    </span>
                                </button>
                            </div>
                        </section>
                    </div>
                </aside>

                <main class="notification-content-pane">
                    <section class="notification-table-pane" aria-label="通知列表">
                        <div class="notification-pane-title notification-table-title">
                            <span>{{ activeGroupLabel }}</span>
                            <span>{{ visibleRecords.length }} 条</span>
                        </div>
                        <nn-table
                            :columns="notificationColumns"
                            :data-source="visibleRecords"
                            :pagination="false"
                            :scroll="{ x: 690, y: '100%' }"
                            row-key="id"
                            size="small"
                            class="notification-table"
                            :row-class-name="notificationRowClass"
                            :custom-row="notificationRowProps"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'generated'">
                                    <span class="notification-time" :title="formatDateTime(record.generatedAt)">
                                        {{ formatTableTime(record.generatedAt) }}
                                    </span>
                                </template>
                                <template v-else-if="column.key === 'received'">
                                    <span class="notification-time" :title="formatDateTime(record.receivedAt)">
                                        {{ formatTableTime(record.receivedAt) }}
                                    </span>
                                </template>
                                <template v-else-if="column.key === 'notification'">
                                    <span class="notification-table-event">
                                        <span v-if="!record.read" class="notification-unread-dot" aria-label="未读" />
                                        <span class="notification-table-event-name">{{ record.eventName }}</span>
                                        <span class="notification-table-event-meta">
                                            {{
                                                record.subscriptionName ||
                                                record.stream ||
                                                record.profileName ||
                                                record.profileId
                                            }}
                                        </span>
                                    </span>
                                </template>
                            </template>
                            <template #emptyText>
                                <nn-empty description="当前筛选下没有通知" />
                            </template>
                        </nn-table>
                    </section>

                    <section class="notification-xml-pane" aria-label="通知 XML 详情">
                        <template v-if="selectedRecord">
                            <header class="notification-xml-header">
                                <div class="notification-xml-summary">
                                    <strong>{{ selectedRecord.eventName }}</strong>
                                    <nn-tag v-if="selectedRecord.xmlTruncated" color="warning">内容已截断</nn-tag>
                                    <span>
                                        {{ formatDateTime(selectedRecord.generatedAt || selectedRecord.receivedAt) }}
                                    </span>
                                    <span v-if="selectedRecord.namespace" :title="selectedRecord.namespace">
                                        {{ selectedRecord.namespace }}
                                    </span>
                                </div>
                                <div class="notification-xml-actions">
                                    <nn-button size="small" @click="copySelectedXml">
                                        <template #icon><CopyOutlined /></template>
                                        复制 XML
                                    </nn-button>
                                    <nn-popconfirm
                                        title="删除这条通知？"
                                        ok-text="删除"
                                        cancel-text="取消"
                                        @confirm="deleteSelected"
                                    >
                                        <nn-button danger size="small">
                                            <template #icon><DeleteOutlined /></template>
                                            删除
                                        </nn-button>
                                    </nn-popconfirm>
                                </div>
                            </header>
                            <XmlCodeEditor
                                :key="selectedRecord.id"
                                :value="selectedXml"
                                :rows="12"
                                readonly
                                line-numbers
                                :bordered="false"
                                class="notification-xml-editor"
                                data-testid="netconf-notification-xml"
                                tabindex="0"
                                aria-label="NETCONF Notification XML"
                            />
                        </template>
                        <nn-empty v-else description="选择一条通知查看完整 XML" />
                    </section>
                </main>
            </div>
        </div>

        <template #footer>
            <div class="notification-session-footer">
                <div class="notification-session-lifecycle">
                    <span
                        class="notification-session-lifecycle-state"
                        :class="`notification-session-lifecycle-state-${selectedSubscriptionStatus}`"
                        aria-hidden="true"
                    />
                    <span class="notification-session-lifecycle-copy">
                        <strong>{{ subscriptionLifecycleTitle }}</strong>
                        <span :title="subscriptionLifecycleDetail">{{ subscriptionLifecycleDetail }}</span>
                    </span>
                </div>
                <div class="notification-subscription-actions">
                    <template v-if="selectedSubscriptionIsModern">
                        <nn-button
                            class="notification-subscription-action"
                            :disabled="!canManageSelectedSubscription"
                            title="在工作区中修改此动态订阅"
                            data-testid="netconf-notification-modify-subscription"
                            @click="requestModernAction('modify-subscription')"
                        >
                            修改订阅
                        </nn-button>
                        <nn-button
                            v-if="selectedSubscriptionIsOnChange"
                            class="notification-subscription-action"
                            :disabled="!canResyncSelectedSubscription"
                            title="请求完整 push-update"
                            data-testid="netconf-notification-resync-subscription"
                            @click="requestModernAction('resync-subscription')"
                        >
                            完整重同步
                        </nn-button>
                        <nn-button
                            danger
                            class="notification-subscription-action"
                            :disabled="!canManageSelectedSubscription"
                            title="删除此订阅但保持 NETCONF Session"
                            data-testid="netconf-notification-delete-subscription"
                            @click="requestModernAction('delete-subscription')"
                        >
                            删除订阅
                        </nn-button>
                    </template>
                    <nn-button
                        v-else
                        danger
                        class="notification-disconnect-session"
                        :loading="disconnecting"
                        :disabled="!canDisconnectSelectedSubscription"
                        :title="disconnectButtonTitle"
                        data-testid="netconf-notification-disconnect-session"
                        @click="requestDisconnectSession"
                    >
                        断开 Session 并结束订阅
                    </nn-button>
                </div>
            </div>
        </template>
    </nn-drawer>
</template>

<script setup>
    import { computed, nextTick, watch } from 'vue';
    import {
        ApiOutlined,
        BellOutlined,
        CloudServerOutlined,
        CopyOutlined,
        DeleteOutlined,
        DownloadOutlined
    } from '../../ui/icons';
    import { notify } from '../../utils/notify';
    import XmlCodeEditor from './XmlCodeEditor.vue';
    import { formatXmlForDisplay } from './yangUiUtils';
    import { useNetconfNotificationHistory } from './useNetconfNotificationHistory';

    defineOptions({ name: 'YangNotificationDrawer' });

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        profileId: {
            type: String,
            default: ''
        },
        sessionId: {
            type: [String, Number],
            default: ''
        },
        subscriptionId: {
            type: String,
            default: ''
        },
        disconnecting: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits([
        'update:open',
        'export',
        'disconnect-session',
        'modify-subscription',
        'delete-subscription',
        'resync-subscription'
    ]);
    const {
        records,
        groups,
        filteredRecords,
        selectedRecord,
        selectedScopeKey,
        query,
        unreadOnly,
        unreadCount,
        selectNotification,
        selectScope,
        setQuery,
        setUnreadOnly,
        markScopeRead,
        deleteNotification,
        clearNotifications,
        exportDescriptor
    } = useNetconfNotificationHistory();

    const notificationColumns = Object.freeze([
        { title: 'Generated', dataIndex: 'generatedAt', key: 'generated', width: 190, ellipsis: true },
        { title: 'Received', dataIndex: 'receivedAt', key: 'received', width: 190, ellipsis: true },
        { title: 'Notification', dataIndex: 'eventName', key: 'notification', width: 310, ellipsis: true }
    ]);

    const allGroup = computed(
        () =>
            groups.value.find(group => group.kind === 'all') || {
                key: 'notification-scope:all',
                scope: {},
                children: []
            }
    );
    const profileGroups = computed(() => groups.value.filter(group => group.kind === 'profile'));
    const visibleRecords = computed(() => filteredRecords.value);
    const activeGroup = computed(() => {
        const find = list => {
            for (const group of list) {
                if (group.key === selectedScopeKey.value) return group;
                const child = find(group.children || []);
                if (child) return child;
            }
            return null;
        };
        return find(groups.value) || allGroup.value;
    });
    const activeGroupLabel = computed(() => activeGroup.value.label || '全部通知');
    const selectedXml = computed(() => formatXmlForDisplay(selectedRecord.value?.xml || ''));
    const selectedSubscription = computed(() =>
        activeGroup.value.kind === 'subscription' && activeGroup.value.subscriptionId ? activeGroup.value : null
    );
    const hasDeviceSubscriptionId = subscription =>
        subscription?.deviceSubscriptionId !== undefined &&
        subscription?.deviceSubscriptionId !== null &&
        String(subscription.deviceSubscriptionId) !== '';
    const selectedSubscriptionStatus = computed(() => selectedSubscription.value?.status || 'none');
    const selectedSubscriptionIsModern = computed(() => {
        const subscription = selectedSubscription.value;
        if (!subscription) return false;
        const protocol = String(subscription.protocol || '').toLowerCase();
        return (
            hasDeviceSubscriptionId(subscription) ||
            ['rfc8639', 'rfc8640', 'rfc8641', 'yang-push', 'modern'].some(value => protocol.includes(value))
        );
    });
    const selectedSubscriptionIsOnChange = computed(
        () => selectedSubscriptionIsModern.value && selectedSubscription.value?.updateTrigger === 'on-change'
    );
    const canManageSelectedSubscription = computed(
        () =>
            selectedSubscriptionIsModern.value &&
            ['active', 'suspended'].includes(selectedSubscriptionStatus.value) &&
            Boolean(selectedSubscription.value?.profileId) &&
            hasDeviceSubscriptionId(selectedSubscription.value)
    );
    const canResyncSelectedSubscription = computed(
        () =>
            canManageSelectedSubscription.value &&
            selectedSubscriptionIsOnChange.value &&
            selectedSubscriptionStatus.value === 'active'
    );
    const canDisconnectSelectedSubscription = computed(
        () => selectedSubscriptionStatus.value === 'active' && Boolean(selectedSubscription.value?.profileId)
    );

    const subscriptionStatusLabel = status => {
        if (status === 'active') return '活动';
        if (status === 'pending') return '建立中';
        if (status === 'suspended') return '已暂停';
        if (status === 'ended') return '已结束';
        if (status === 'error') return '错误';
        if (status === 'unassigned') return '未关联';
        if (status === 'unknown') return '状态未知';
        return status || '未知';
    };

    const subscriptionTitle = subscription => {
        const parts = [subscription.label, `状态：${subscriptionStatusLabel(subscription.status)}`];
        if (subscription.desynchronized) {
            parts.push(`状态失同步：${subscription.desynchronizationReason || '请重新连接后再管理订阅'}`);
        } else if (subscription.suspensionReason) parts.push(`暂停原因：${subscription.suspensionReason}`);
        else if (subscription.errorMessage) parts.push(`错误：${subscription.errorMessage}`);
        else if (subscription.terminationReason) parts.push(`结束原因：${subscription.terminationReason}`);
        if (subscription.replayCompletedAt)
            parts.push(`Replay 完成：${formatDateTime(subscription.replayCompletedAt)}`);
        return parts.filter(Boolean).join('\n');
    };

    const subscriptionLifecycleTitle = computed(() => {
        if (!selectedSubscription.value) return '订阅生命周期';
        if (selectedSubscriptionIsModern.value) {
            const standard = selectedSubscription.value.targetType === 'datastore' ? 'YANG-Push' : 'RFC 8639';
            return `${subscriptionStatusLabel(selectedSubscriptionStatus.value)}订阅 · ${standard}`;
        }
        return `${subscriptionStatusLabel(selectedSubscriptionStatus.value)}订阅 · ${selectedSubscription.value.label}`;
    });
    const subscriptionLifecycleDetail = computed(() => {
        if (!selectedSubscription.value) return '选择左侧订阅后查看状态并执行适用的管理操作';
        const sessionLabel = selectedSubscription.value.sessionId
            ? `Session ${selectedSubscription.value.sessionId}`
            : '所属 Session';
        if (selectedSubscriptionIsModern.value) {
            const id = hasDeviceSubscriptionId(selectedSubscription.value)
                ? selectedSubscription.value.deviceSubscriptionId
                : '-';
            const target =
                selectedSubscription.value.targetType === 'datastore'
                    ? `${selectedSubscription.value.datastore || 'datastore'} · ${
                          selectedSubscription.value.updateTrigger || 'YANG-Push'
                      }`
                    : selectedSubscription.value.stream || 'NETCONF';
            if (selectedSubscriptionStatus.value === 'suspended') {
                const reason = selectedSubscription.value.suspensionReason
                    ? ` · 暂停原因：${selectedSubscription.value.suspensionReason}`
                    : '';
                return `${sessionLabel} · ID ${id} · ${target}${reason} · 可修改或删除`;
            }
            if (selectedSubscriptionStatus.value === 'active') {
                const replay = selectedSubscription.value.replayCompletedAt
                    ? ` · Replay 已于 ${formatDateTime(selectedSubscription.value.replayCompletedAt)} 完成`
                    : '';
                return `${sessionLabel} · ID ${id} · ${target}${replay}`;
            }
            if (selectedSubscriptionStatus.value === 'unknown' || selectedSubscription.value.desynchronized) {
                return `${sessionLabel} · ID ${id} · 状态失同步：${
                    selectedSubscription.value.desynchronizationReason || '请重新连接后再继续管理'
                }`;
            }
        }
        if (selectedSubscriptionStatus.value === 'active') {
            return `RFC 5277 没有单独取消入口；需要断开 ${sessionLabel}`;
        }
        if (selectedSubscriptionStatus.value === 'error' && selectedSubscription.value.errorMessage) {
            return `${sessionLabel} · ${selectedSubscription.value.errorMessage}`;
        }
        if (selectedSubscriptionStatus.value === 'ended' && selectedSubscription.value.terminationReason) {
            return `${sessionLabel} · 结束原因：${selectedSubscription.value.terminationReason}`;
        }
        return `${sessionLabel} · ${subscriptionStatusLabel(selectedSubscriptionStatus.value)}`;
    });
    const disconnectButtonTitle = computed(() => {
        if (canDisconnectSelectedSubscription.value) {
            return `断开 Session ${selectedSubscription.value.sessionId || ''} 并结束此 RFC 5277 订阅`.trim();
        }
        if (selectedSubscription.value && !selectedSubscription.value.profileId)
            return '订阅缺少 Profile 信息，无法断开 Session';
        if (selectedSubscription.value)
            return `当前订阅状态为“${subscriptionStatusLabel(selectedSubscriptionStatus.value)}”，无需断开 Session`;
        return '请先选择左侧的活动订阅';
    });

    const formatDateTime = value => {
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    };

    const formatTableTime = value => {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    };

    const notificationRowClass = record => [
        'notification-table-row',
        record.id === selectedRecord.value?.id ? 'notification-table-row-active' : '',
        !record.read ? 'notification-table-row-unread' : ''
    ];

    const selectRow = record => {
        selectNotification(record.id);
    };

    const notificationRowProps = record => ({
        role: 'option',
        tabindex: record.id === selectedRecord.value?.id ? 0 : -1,
        'aria-selected': record.id === selectedRecord.value?.id ? 'true' : 'false',
        'data-testid': 'netconf-notification-row',
        onClick: () => selectRow(record),
        onKeydown: event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectRow(record);
            }
        }
    });

    const currentScope = () => activeGroup.value.scope || { kind: 'all' };

    const markVisibleRead = () => {
        markScopeRead(currentScope());
        notify.success('当前分组通知已全部标为已读');
    };

    const clearVisibleScope = () => {
        const removed = clearNotifications(currentScope());
        notify.success(`已清空 ${removed} 条通知`);
    };

    const exportVisible = () => {
        const descriptor = exportDescriptor({
            scope: currentScope(),
            query: query.value,
            onlyUnread: unreadOnly.value
        });
        emit('export', descriptor);
    };

    const copySelectedXml = async () => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(selectedRecord.value?.xml || '');
            notify.success('Notification XML 已复制');
        } catch (_error) {
            notify.warning('系统剪贴板不可用');
        }
    };

    const deleteSelected = () => {
        if (!selectedRecord.value) return;
        deleteNotification(selectedRecord.value.id);
        notify.success('通知已删除');
    };

    const requestDisconnectSession = () => {
        if (!canDisconnectSelectedSubscription.value) return;
        emit('disconnect-session', {
            profileId: selectedSubscription.value.profileId,
            sessionId: selectedSubscription.value.sessionId,
            subscriptionId: selectedSubscription.value.subscriptionId,
            label: selectedSubscription.value.label
        });
    };

    const requestModernAction = operation => {
        if (!canManageSelectedSubscription.value) return;
        if (operation === 'resync-subscription' && !canResyncSelectedSubscription.value) return;
        emit(operation, {
            ...selectedSubscription.value,
            operation,
            modernSubscriptionId: selectedSubscription.value.deviceSubscriptionId
        });
    };

    const applyInitialScope = () => {
        if (props.subscriptionId) {
            selectScope({
                kind: 'subscription',
                profileId: props.profileId,
                sessionId: String(props.sessionId || ''),
                subscriptionId: props.subscriptionId
            });
        } else if (props.sessionId !== '') {
            selectScope({ kind: 'session', profileId: props.profileId, sessionId: String(props.sessionId) });
        } else if (props.profileId) {
            selectScope({ kind: 'profile', profileId: props.profileId });
        }
    };

    watch(
        [() => props.open, () => props.profileId, () => props.sessionId, () => props.subscriptionId],
        ([open]) => {
            if (open) applyInitialScope();
        },
        { immediate: true }
    );

    watch(
        [() => props.open, visibleRecords],
        async ([open, visible]) => {
            if (!open || visible.some(record => record.id === selectedRecord.value?.id)) return;
            selectNotification(visible[0]?.id || '', { markRead: false });
            await nextTick();
        },
        { immediate: true }
    );
</script>

<style scoped>
    .notification-browser {
        display: grid;
        height: 100%;
        min-width: 0;
        min-height: 0;
        grid-template-rows: auto minmax(0, 1fr);
        color: var(--nn-color-text);
    }

    .notification-browser-toolbar {
        display: grid;
        min-width: 0;
        align-items: center;
        grid-template-columns: minmax(160px, auto) minmax(280px, 1fr) auto;
        gap: 12px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .notification-browser-heading {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
    }

    .notification-browser-heading strong {
        color: var(--nn-color-text-strong);
        font-size: 13px;
    }

    .notification-browser-heading span {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .notification-browser-filters,
    .notification-browser-actions {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
    }

    .notification-browser-actions {
        justify-content: flex-end;
    }

    .notification-search {
        width: min(420px, 100%);
        min-width: 180px;
    }

    .notification-unread-filter {
        flex: 0 0 auto;
        white-space: nowrap;
    }

    .notification-browser-layout {
        display: grid;
        min-width: 0;
        min-height: 0;
        grid-template-columns: 270px minmax(0, 1fr);
        overflow: hidden;
    }

    .notification-scope-pane,
    .notification-table-pane,
    .notification-xml-pane {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border-color: var(--nn-color-border-light);
        background: var(--nn-color-bg-surface);
    }

    .notification-scope-pane {
        display: grid;
        grid-template-rows: 37px minmax(0, 1fr);
        border-right: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .notification-pane-title {
        display: flex;
        min-width: 0;
        min-height: 37px;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text-muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
    }

    .notification-scope-list {
        min-height: 0;
        overflow: auto;
        padding: 6px;
        overscroll-behavior: contain;
    }

    .notification-profile-group + .notification-profile-group {
        margin-top: 3px;
    }

    .notification-scope-item {
        display: flex;
        width: 100%;
        min-width: 0;
        min-height: 32px;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 7px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        text-align: left;
    }

    .notification-scope-item:hover,
    .notification-scope-item:focus-visible {
        background: var(--nn-color-bg-hover);
        outline: none;
    }

    .notification-scope-item:focus-visible {
        box-shadow: inset 0 0 0 2px var(--nn-color-primary);
    }

    .notification-scope-item-active {
        background: var(--nn-color-bg-info-subtle);
        box-shadow: inset 3px 0 0 var(--nn-color-primary);
        color: var(--nn-color-text-strong);
    }

    .notification-session-item {
        padding-left: 19px;
    }

    .notification-subscription-item {
        padding-left: 39px;
        font-size: 11px;
    }

    .notification-scope-label,
    .notification-scope-counts {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .notification-scope-label {
        flex: 1;
    }

    .notification-scope-label :deep(.nn-icon) {
        flex: 0 0 14px;
        color: var(--nn-color-text-muted);
        font-size: 14px;
    }

    .notification-scope-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .notification-scope-counts {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .notification-unread-count {
        min-width: 18px;
        padding: 1px 5px;
        border-radius: 9px;
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
        font-weight: 600;
        text-align: center;
    }

    .notification-subscription-state {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
    }

    .notification-subscription-state-active,
    .notification-subscription-state-subscribed {
        background: var(--nn-color-success);
    }

    .notification-subscription-state-pending {
        background: var(--nn-color-warning);
    }

    .notification-subscription-state-error,
    .notification-session-lifecycle-state-error {
        background: var(--nn-color-error);
    }

    .notification-subscription-state-ended,
    .notification-session-lifecycle-state-ended {
        background: var(--nn-color-text-muted);
    }

    .notification-subscription-status {
        color: var(--nn-color-text-muted);
        white-space: nowrap;
    }

    .notification-subscription-status-active {
        color: var(--nn-color-text-success);
    }

    .notification-subscription-status-error {
        color: var(--nn-color-error);
    }

    .notification-content-pane {
        display: grid;
        min-width: 0;
        min-height: 0;
        grid-template-rows: minmax(190px, 42%) minmax(220px, 58%);
        overflow: hidden;
    }

    .notification-table-pane {
        display: grid;
        grid-template-rows: 37px minmax(0, 1fr);
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .notification-table-title {
        color: var(--nn-color-text-strong);
        font-size: 12px;
        text-transform: none;
    }

    .notification-table {
        min-height: 0;
        overflow: hidden;
    }

    .notification-table :deep(.nn-table-wrapper),
    .notification-table :deep(.nn-spin-nested-loading),
    .notification-table :deep(.nn-spin-container),
    .notification-table :deep(.nn-table),
    .notification-table :deep(.nn-table-container) {
        height: 100%;
        min-height: 0;
    }

    .notification-table :deep(.nn-table-content) {
        height: 100%;
        overflow: auto;
    }

    .notification-table :deep(.notification-table-row) {
        cursor: pointer;
    }

    .notification-table :deep(.notification-table-row:hover),
    .notification-table :deep(.notification-table-row:focus-visible) {
        background: var(--nn-color-bg-hover);
        outline: none;
    }

    .notification-table :deep(.notification-table-row-active) {
        background: var(--nn-color-bg-info-subtle);
        box-shadow: inset 3px 0 0 var(--nn-color-primary);
    }

    .notification-table :deep(.notification-table-row-unread .nn-table-cell) {
        color: var(--nn-color-text-strong);
        font-weight: 500;
    }

    .notification-time {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        white-space: nowrap;
    }

    .notification-table-event {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 7px;
    }

    .notification-unread-dot {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        border-radius: 50%;
        background: var(--nn-color-primary);
    }

    .notification-table-event-name {
        min-width: 90px;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .notification-table-event-meta {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .notification-xml-pane {
        display: flex;
        flex-direction: column;
        background: var(--nn-color-bg-code);
    }

    .notification-xml-pane > :deep(.nn-empty) {
        margin: auto;
    }

    .notification-xml-header {
        display: flex;
        min-width: 0;
        min-height: 42px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .notification-xml-summary,
    .notification-xml-actions {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
    }

    .notification-xml-summary strong {
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
    }

    .notification-xml-summary span {
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .notification-xml-actions {
        flex: 0 0 auto;
    }

    .notification-xml-editor {
        min-width: 0;
        min-height: 0;
        flex: 1;
        border-radius: 0;
        font-size: 11px;
    }

    .notification-xml-editor :deep(.xml-code-editor-highlight),
    .notification-xml-editor :deep(.xml-code-editor-input) {
        height: 100%;
    }

    .notification-xml-editor :deep(.xml-code-editor-input) {
        resize: none;
    }

    .notification-xml-editor :deep(.xml-code-editor-input:focus) {
        border-color: var(--nn-color-primary);
        box-shadow: none;
    }

    .notification-session-footer {
        display: flex;
        width: 100%;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
    }

    .notification-session-lifecycle {
        display: flex;
        min-width: 0;
        flex: 1;
        align-items: center;
        gap: 8px;
        text-align: left;
    }

    .notification-session-lifecycle-state {
        width: 8px;
        height: 8px;
        flex: 0 0 8px;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
    }

    .notification-session-lifecycle-state-active {
        background: var(--nn-color-success);
    }

    .notification-session-lifecycle-state-pending {
        background: var(--nn-color-warning);
    }

    .notification-session-lifecycle-state-suspended {
        background: var(--nn-color-warning);
    }

    .notification-session-lifecycle-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1px;
    }

    .notification-session-lifecycle-copy strong,
    .notification-session-lifecycle-copy span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .notification-session-lifecycle-copy strong {
        color: var(--nn-color-text-strong);
        font-size: 12px;
    }

    .notification-session-lifecycle-copy span {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .notification-disconnect-session {
        width: 196px;
        flex: 0 0 196px;
    }

    .notification-subscription-actions {
        display: flex;
        min-width: 0;
        flex: 0 0 auto;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
    }

    .notification-subscription-action {
        width: 104px;
        flex: 0 0 104px;
    }

    @media (max-width: 900px) {
        .notification-browser-toolbar {
            grid-template-columns: minmax(0, 1fr) auto;
        }

        .notification-browser-heading {
            display: none;
        }

        .notification-browser-filters {
            grid-column: 1;
        }
    }

    @media (max-width: 720px) {
        .notification-browser-toolbar {
            grid-template-columns: minmax(0, 1fr);
        }

        .notification-browser-actions {
            justify-content: flex-start;
        }

        .notification-browser-layout {
            grid-template-columns: 220px minmax(0, 1fr);
        }

        .notification-content-pane {
            grid-template-rows: minmax(180px, 40%) minmax(220px, 60%);
        }

        .notification-xml-summary span:last-child {
            display: none;
        }

        .notification-session-footer {
            gap: 8px;
        }

        .notification-session-lifecycle-copy span {
            display: none;
        }

        .notification-subscription-actions {
            gap: 4px;
        }

        .notification-subscription-action {
            width: 88px;
            flex-basis: 88px;
            padding-inline: 6px;
        }
    }
</style>
