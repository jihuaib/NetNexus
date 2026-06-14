(function installElectronApiMocks() {
    const initialHistory = [
        {
            template: 'hostname leaf-{A}',
            placeholder: '{A}',
            start: '3',
            end: '4'
        }
    ];

    const state = {
        calls: {
            generateString: []
        },
        history: initialHistory.map(item => ({ ...item })),
        rendererReadyNotified: false,
        timeline: []
    };

    const clone = value => JSON.parse(JSON.stringify(value));

    const record = (message, data = null) => {
        const item = {
            at: new Date().toISOString(),
            message
        };

        if (data !== null && data !== undefined) {
            item.data = clone(data);
        }

        state.timeline.push(item);
    };

    const renderTemplate = templateData => {
        const start = parseInt(templateData.start, 10);
        const end = parseInt(templateData.end, 10);
        const results = [];

        for (let i = start; i <= end; i += 1) {
            results.push(String(templateData.template).split(String(templateData.placeholder)).join(String(i)));
        }

        return results;
    };

    state.getDiagnosticsText = () => {
        const timeline = state.timeline
            .map(item => {
                const data = item.data === undefined ? '' : ` ${JSON.stringify(item.data)}`;
                return `[${item.at}] ${item.message}${data}`;
            })
            .join('\n');

        return [
            '=== String Generator E2E Timeline ===',
            timeline || '(empty)',
            '',
            '=== Final Mock State ===',
            JSON.stringify(
                {
                    rendererReadyNotified: state.rendererReadyNotified,
                    generateStringCalls: state.calls.generateString,
                    history: state.history
                },
                null,
                2
            )
        ].join('\n');
    };

    window.__netNexusE2e = state;

    record('electron API mocks installed', { initialHistoryCount: state.history.length });

    window.commonApi = {
        onUnifiedEvent: () => {
            record('commonApi.onUnifiedEvent registered');
        },
        notifyRendererReady: () => {
            state.rendererReadyNotified = true;
            record('commonApi.notifyRendererReady called');
        },
        openDeveloperOptions: () => {},
        openSoftwareInfo: () => {}
    };

    window.toolsApi = {
        generateString: async templateData => {
            const payload = clone(templateData);
            state.calls.generateString.push(payload);

            const exists = state.history.some(
                item =>
                    item.template === payload.template &&
                    item.placeholder === payload.placeholder &&
                    item.start === payload.start &&
                    item.end === payload.end
            );

            if (!exists) {
                state.history.push(payload);
            }

            const result = renderTemplate(payload);
            record('toolsApi.generateString called', {
                payload,
                resultCount: result.length,
                historyCount: state.history.length
            });

            return {
                status: 'success',
                msg: 'Worker处理成功',
                data: result
            };
        },
        getGenerateStringHistory: async () => {
            record('toolsApi.getGenerateStringHistory called', { historyCount: state.history.length });

            return {
                status: 'success',
                msg: '获取字符串生成历史记录成功',
                data: clone(state.history)
            };
        },
        clearGenerateStringHistory: async () => {
            state.history = [];
            record('toolsApi.clearGenerateStringHistory called');

            return {
                status: 'success',
                msg: '清空字符串生成历史记录成功',
                data: null
            };
        }
    };
})();
