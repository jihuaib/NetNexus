import {
    ApiOutlined,
    AppstoreOutlined,
    ClockCircleOutlined,
    CloudDownloadOutlined,
    ClusterOutlined,
    CodeOutlined,
    DatabaseOutlined,
    FileSearchOutlined,
    FileTextOutlined,
    FolderOutlined,
    KeyOutlined,
    RouteOutlined,
    SafetyOutlined,
    SettingOutlined,
    SwapOutlined,
    ToolOutlined,
    WifiOutlined
} from './icons';

export const moduleNavigationIcons = Object.freeze({
    tools: AppstoreOutlined,
    bgp: RouteOutlined,
    bmp: ClusterOutlined,
    rpki: SafetyOutlined,
    ftp: FolderOutlined,
    snmp: CodeOutlined,
    yang: FileSearchOutlined,
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
    dataManagement: DatabaseOutlined,
    runtime: ToolOutlined,
    update: CloudDownloadOutlined
});
