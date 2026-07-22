const fs = require('fs');
const path = require('path');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const { BmpE2eController } = require('./bmp');
const { HuaweiBmpLab } = require('./huawei-bmp-lab');
const { ALL_ADJ_RIB_TYPES, getScenario } = require('./huawei-bmp-scenarios');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilePart(value) {
    return String(value || '').replace(/[^0-9a-z._-]/giu, '-');
}

function summarizeRoute(route) {
    return {
        ip: route.ip,
        prefixLength: route.prefixLength,
        prefix: route.prefix,
        rd: route.rd,
        pathId: route.pathId,
        isAddPath: route.isAddPath,
        routeType: route.routeType,
        labels: route.labels,
        nextHop: route.nextHop,
        med: route.med,
        localPreference: route.localPreference,
        asPath: route.asPath,
        communities: route.communities,
        largeCommunities: route.largeCommunities,
        extendedCommunities: route.extendedCommunities,
        routeState: route.routeState,
        parseStatus: route.parseStatus,
        pathStatusText: route.pathStatusText,
        pathStatus: route.pathStatus,
        pathStatusReasonText: route.pathStatusReasonText,
        encapsulationType: route.encapsulationType || route.nlriDetail?.encapsulationType || null
    };
}

function sessionMatchesFamily(session, family) {
    const enabledAddressFamilies = session.enabledAddrFamilyTypes || session.addressFamilies || [];
    if (!enabledAddressFamilies.includes(family.af)) return false;
    const vrfs = session.vrfTableNames || [];
    if (family.vrf) return vrfs.includes(family.vrf);
    return !vrfs.length || vrfs.includes('global');
}

class HuaweiBmpLiveScenario {
    constructor({ scenario, controller } = {}) {
        this.scenario = typeof scenario === 'string' ? getScenario(scenario) : scenario;
        if (!this.scenario) throw new Error('HuaweiBmpLiveScenario requires a scenario');
        this.controller = controller || new BmpE2eController();
        this.ownsController = !controller;
        this.lab = HuaweiBmpLab.fromEnvironment();
        this.report = {
            schemaVersion: 1,
            scenario: this.scenario.key,
            name: this.scenario.name,
            startedAt: new Date().toISOString(),
            codeIssues: [],
            deviceLimitations: [],
            setupIssues: [],
            devices: []
        };
        this.collectorStarted = false;
        this.cleanedUp = false;
    }

    async startCollector(config = {}) {
        const result = await this.controller.call('startBmp', {
            port: this.lab.collectorPort,
            listenHost: '0.0.0.0',
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19,
            logLevel: 'off',
            ...config
        });
        if (result.status !== 'success') {
            throw new Error(`Unable to start BMP collector: ${JSON.stringify(result)}`);
        }
        this.collectorStarted = true;
        return result;
    }

    async apply({ trialSeconds = 900 } = {}) {
        await this.lab.applyScenario(this.scenario, { trialSeconds });
    }

    async getOnlineClients() {
        const result = await this.controller.call('getClientList');
        if (result.status !== 'success') return [];
        return (result.data || []).filter(client => client.isOnline === true);
    }

    async collectDevice(client) {
        const sessionsResult = await this.controller.call('getBgpSessions', client);
        const instancesResult = await this.controller.call('getBgpInstances', client);
        const device = {
            remoteIp: client.remoteIp,
            sysName: client.sysName,
            bmpVersion: client.bmpVersion,
            bmpV4TlvDraft: client.bmpV4TlvDraft,
            sessions: [],
            locRib: []
        };

        for (const session of sessionsResult.data || []) {
            const families = this.scenario.families.filter(family => sessionMatchesFamily(session, family));
            if (!families.length) continue;
            const item = {
                sessionIp: session.sessionIp,
                sessionAs: session.sessionAs,
                peerType: session.peerType,
                vrfTableNames: session.vrfTableNames,
                ribTypes: session.ribTypes,
                addressFamilies: session.enabledAddrFamilyTypes,
                routes: []
            };
            for (const family of families) {
                for (const ribType of session.ribTypes || []) {
                    const result = await this.controller.call('getBgpRoutes', {
                        client,
                        session,
                        af: family.af,
                        ribType,
                        page: 1,
                        pageSize: 100,
                        routeState: 'all',
                        prefixFilter: ''
                    });
                    item.routes.push({
                        af: family.af,
                        ribType,
                        status: result.status,
                        total: result.data?.total || 0,
                        summary: result.data?.summary || null,
                        samples: (result.data?.list || []).slice(0, 8).map(summarizeRoute)
                    });
                }
            }
            device.sessions.push(item);
        }

        for (const instance of instancesResult.data || []) {
            const family = this.scenario.families.find(item => item.locRib && item.af === instance.addrFamilyType);
            if (!family) continue;
            const result = await this.controller.call('getBgpInstanceRoutes', {
                client,
                instance,
                page: 1,
                pageSize: 100,
                routeState: 'all',
                prefixFilter: ''
            });
            device.locRib.push({
                af: instance.addrFamilyType,
                afi: instance.afi,
                safi: instance.safi,
                isAddPath: instance.isAddPath === true,
                addPathMap: instance.addPathMap || null,
                vrfTableNames: instance.vrfTableNames,
                status: result.status,
                total: result.data?.total || 0,
                summary: result.data?.summary || null,
                samples: (result.data?.list || []).slice(0, 8).map(summarizeRoute)
            });
        }
        return device;
    }

    classifyReport() {
        const evpnPeerHasNoReceivedRoutes =
            this.scenario.key.startsWith('evpn') &&
            this.report.deviceState?.length === 2 &&
            this.report.deviceState.every(state =>
                /\bEstablished\s+0\s*$/mu.test(state.commands?.['display bgp evpn peer'] || '')
            );
        if (evpnPeerHasNoReceivedRoutes) {
            this.report.setupIssues = this.report.setupIssues.filter(
                issue => issue.detail !== 'Timed out waiting for minimum real-device BMP data'
            );
            this.report.setupIssues.push({
                detail: 'EVPN Type 5 routes are valid/best in both device Loc-RIBs, but both established EVPN peers report PrefRcv 0; Adj-RIB stages are not generated by this lab topology'
            });
        }
        for (const family of this.scenario.families) {
            if (family.limitation) {
                this.report.deviceLimitations.push({ af: family.af, detail: family.limitation });
            }
        }
        for (const device of this.report.devices) {
            for (const family of this.scenario.families) {
                const sessions = device.sessions.filter(session =>
                    session.routes.some(route => route.af === family.af)
                );
                for (const ribType of ALL_ADJ_RIB_TYPES) {
                    if (family.af === BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN && evpnPeerHasNoReceivedRoutes) continue;
                    if (ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN && !family.prePolicy) continue;
                    const total = sessions.reduce(
                        (sum, session) =>
                            sum +
                            session.routes
                                .filter(route => route.af === family.af && route.ribType === ribType)
                                .reduce((routeSum, route) => routeSum + route.total, 0),
                        0
                    );
                    if (total === 0) {
                        this.report.codeIssues.push({
                            device: device.remoteIp,
                            af: family.af,
                            ribType,
                            detail: 'Expected route stage is present in device BMP monitoring but API returned no routes'
                        });
                    }
                }
                if (family.locRib) {
                    const total = device.locRib
                        .filter(instance => instance.af === family.af)
                        .reduce((sum, instance) => sum + instance.total, 0);
                    if (total === 0) {
                        this.report.codeIssues.push({
                            device: device.remoteIp,
                            af: family.af,
                            ribType: 'loc-rib',
                            detail: 'Expected Loc-RIB routes but API returned none'
                        });
                    }
                }
            }
        }
    }

    hasMinimumData() {
        if (this.report.devices.length < 2) return false;
        return this.report.devices.every(device =>
            this.scenario.families.every(family => {
                const sessions = device.sessions.filter(session => sessionMatchesFamily(session, family));
                const requiredRibTypes = ALL_ADJ_RIB_TYPES.filter(
                    ribType => ribType !== BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN || family.prePolicy
                );
                const allAdjRibStages = requiredRibTypes.every(ribType =>
                    sessions.some(session =>
                        session.routes.some(
                            route => route.af === family.af && route.ribType === ribType && route.total > 0
                        )
                    )
                );
                const locRib =
                    !family.locRib || device.locRib.some(instance => instance.af === family.af && instance.total > 0);
                return allAdjRibStages && locRib;
            })
        );
    }

    async waitForData({ timeoutMs = 120000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const clients = await this.getOnlineClients();
            if (clients.length >= 2) {
                this.report.devices = [];
                for (const client of clients.slice(0, 2)) {
                    this.report.devices.push(await this.collectDevice(client));
                }
                if (this.hasMinimumData()) return this.report.devices;
            }
            await delay(2000);
        }
        this.report.setupIssues.push({ detail: 'Timed out waiting for minimum real-device BMP data' });
        return this.report.devices;
    }

    async collectFinal() {
        const clients = await this.getOnlineClients();
        this.report.devices = [];
        for (const client of clients.slice(0, 2)) {
            this.report.devices.push(await this.collectDevice(client));
        }
        this.report.deviceState = await this.lab.collectScenarioDeviceState();
        this.classifyReport();
        return this.report;
    }

    async cleanup() {
        if (this.cleanedUp) return this.report.restore || [];
        this.cleanedUp = true;
        try {
            if (this.collectorStarted || this.ownsController) await this.controller.cleanup();
        } catch (error) {
            this.report.setupIssues.push({ detail: `Collector cleanup failed: ${error.message}` });
        }
        try {
            this.report.restore = await this.lab.restore();
        } catch (error) {
            this.report.setupIssues.push({ detail: `Device restore failed: ${error.message}` });
            throw error;
        }
        return this.report.restore;
    }

    writeReport(variant = '') {
        this.report.finishedAt = new Date().toISOString();
        const suffix = variant ? `-${sanitizeFilePart(variant)}` : '';
        const reportPath = path.join(
            this.lab.artifactDirectory,
            `scenario-${sanitizeFilePart(this.scenario.key)}${suffix}.json`
        );
        fs.writeFileSync(reportPath, `${JSON.stringify(this.report, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
        return reportPath;
    }
}

module.exports = {
    HuaweiBmpLiveScenario,
    sanitizeFilePart,
    sessionMatchesFamily,
    summarizeRoute
};
