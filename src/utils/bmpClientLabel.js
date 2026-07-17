const normalizeLabelPart = value => (typeof value === 'string' ? value.trim() : '');

export const formatBmpClientLabel = client => {
    const systemName = [client?.sysName, client?.systemName, client?.hostName, client?.name]
        .map(normalizeLabelPart)
        .find(Boolean);
    const remoteIp = normalizeLabelPart(client?.remoteIp);
    const distinctRemoteIp = remoteIp && remoteIp !== systemName ? remoteIp : '';

    return [systemName, distinctRemoteIp].filter(Boolean).join(' · ') || '-';
};
