import {
    ApiOutlined,
    AppstoreOutlined,
    ClockCircleOutlined,
    CloudDownloadOutlined,
    CloudServerOutlined,
    ClusterOutlined,
    CodeOutlined,
    FileTextOutlined,
    FolderOutlined,
    KeyOutlined,
    RouteOutlined,
    SafetyOutlined,
    SettingOutlined,
    SwapOutlined,
    WifiOutlined
} from './icons';

export const moduleNavigationIcons = Object.freeze({
    tools: AppstoreOutlined,
    bgp: RouteOutlined,
    bmp: ClusterOutlined,
    rpki: SafetyOutlined,
    ftp: FolderOutlined,
    snmp: CodeOutlined,
    dhcp: WifiOutlined,
    ntp: ClockCircleOutlined,
    radius: KeyOutlined,
    tftp: SwapOutlined,
    syslog: FileTextOutlined
});

export const settingsNavigationIcons = Object.freeze({
    general: SettingOutlined,
    tools: moduleNavigationIcons.tools,
    ftp: moduleNavigationIcons.ftp,
    externalApi: ApiOutlined,
    serverDeployment: CloudServerOutlined,
    update: CloudDownloadOutlined
});
