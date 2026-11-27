const normalizeLabelPart = value => (typeof value === 'string' ? value.trim() : '');

export const formatBmpClientLabel = client => {
    const systemName = [client?.sysName, client?.systemName, client?.hostName, client?.name]
        .map(normalizeLabelPart)
        .find(Boolean);
    const remoteIp = normalizeLabelPart(client?.remoteIp);
    const distinctRemoteIp = remoteIp && remoteIp !== systemName ? remoteIp : '';
    const bgpInstanceName = normalizeLabelPart(client?.bgpInstanceName);
    const instanceLabel = bgpInstanceName ? `BGP ${bgpInstanceName}` : '';

    return [systemName, distinctRemoteIp, instanceLabel].filter(Boolean).join(' · ') || '-';
};
