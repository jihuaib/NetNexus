import {
    ApiOutlined,
    AppstoreOutlined,
    ClockCircleOutlined,
    CloudDownloadOutlined,
    CloudServerOutlined,
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
} from 'netnexus-ui/icons';

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
    syslog: FileTextOutlined,
    grpc: CloudServerOutlined
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
