import { h } from 'vue';
import {
    AppWindow,
    Bell,
    ChartNetwork,
    CheckCircle,
    CircleAlert,
    Clock,
    CloudDownload,
    Code,
    Copy,
    Download,
    Edit,
    Eye,
    FileSearch,
    FileText,
    Folder,
    FolderOpen,
    Import,
    Info,
    KeyRound,
    LayoutGrid,
    List,
    LoaderCircle,
    Network,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    RefreshCw,
    Repeat,
    Route,
    Save,
    Search,
    Send,
    Server,
    Settings,
    Shield,
    setLucideProps,
    StepForward,
    Trash2,
    Upload,
    UploadCloud,
    Wifi,
    Wrench
} from '@lucide/vue';

function createIcon(IconComponent) {
    return {
        inheritAttrs: false,
        setup(_, { attrs }) {
            setLucideProps({});

            return () => {
                const { class: className, spin, size, strokeWidth, ...restAttrs } = attrs;

                return h(IconComponent, {
                    ...restAttrs,
                    class: ['nn-icon', spin ? 'nn-icon-spin' : null, className],
                    size: size || '1em',
                    strokeWidth: strokeWidth || 2,
                    'aria-hidden': restAttrs['aria-label'] ? undefined : 'true'
                });
            };
        }
    };
}

export const ApiOutlined = createIcon(Network);
export const AppstoreOutlined = createIcon(LayoutGrid || AppWindow);
export const BellOutlined = createIcon(Bell);
export const CheckCircleOutlined = createIcon(CheckCircle);
export const ClockCircleOutlined = createIcon(Clock);
export const CloudDownloadOutlined = createIcon(CloudDownload);
export const CloudServerOutlined = createIcon(Server);
export const CloudUploadOutlined = createIcon(UploadCloud);
export const ClusterOutlined = createIcon(ChartNetwork);
export const CodeOutlined = createIcon(Code);
export const CopyOutlined = createIcon(Copy);
export const DeleteOutlined = createIcon(Trash2);
export const DownloadOutlined = createIcon(Download);
export const EditOutlined = createIcon(Edit);
export const ExclamationCircleOutlined = createIcon(CircleAlert);
export const EyeOutlined = createIcon(Eye);
export const FileSearchOutlined = createIcon(FileSearch);
export const FileTextOutlined = createIcon(FileText);
export const FolderOpenOutlined = createIcon(FolderOpen);
export const FolderOutlined = createIcon(Folder);
export const ImportOutlined = createIcon(Import);
export const InfoCircleOutlined = createIcon(Info);
export const KeyOutlined = createIcon(KeyRound);
export const LoadingOutlined = createIcon(LoaderCircle);
export const MenuFoldOutlined = createIcon(PanelLeftClose);
export const MenuUnfoldOutlined = createIcon(PanelLeftOpen);
export const PlusOutlined = createIcon(Plus);
export const ProfileOutlined = createIcon(FileText);
export const ReloadOutlined = createIcon(RefreshCw);
export const RouteOutlined = createIcon(Route);
export const SafetyOutlined = createIcon(Shield);
export const SaveOutlined = createIcon(Save);
export const SearchOutlined = createIcon(Search);
export const SendOutlined = createIcon(Send);
export const SettingOutlined = createIcon(Settings);
export const StepForwardOutlined = createIcon(StepForward);
export const SwapOutlined = createIcon(Repeat);
export const ToolOutlined = createIcon(Wrench);
export const UnorderedListOutlined = createIcon(List);
export const UploadOutlined = createIcon(Upload);
export const WifiOutlined = createIcon(Wifi);
