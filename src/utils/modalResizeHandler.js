/**
 * 弹出框缩放自适应处理工具
 * 用于处理页面缩放时弹出框的自适应调整
 */

class ModalResizeHandler {
    constructor() {
        this.isListening = false;
        this.resizeTimer = null;
        this.zoomLevel = 1;
        this.callbacks = [];
        this.boundHandleResize = this.handleResize.bind(this);
        this.boundHandleWheel = this.handleWheel.bind(this);
        this.boundHandleKeydown = this.handleKeydown.bind(this);
    }

    /**
     * 开始监听窗口变化
     */
    startListening() {
        if (this.isListening) return;

        this.isListening = true;
        this.updateZoomLevel();

        // 监听窗口大小变化
        window.addEventListener('resize', this.boundHandleResize);

        // 监听页面缩放变化
        window.addEventListener('wheel', this.boundHandleWheel, { passive: true });

        // 监听键盘缩放快捷键
        window.addEventListener('keydown', this.boundHandleKeydown);
    }

    /**
     * 停止监听窗口变化
     */
    stopListening() {
        if (!this.isListening) return;

        this.isListening = false;
        window.removeEventListener('resize', this.boundHandleResize);
        window.removeEventListener('wheel', this.boundHandleWheel);
        window.removeEventListener('keydown', this.boundHandleKeydown);
    }

    /**
     * 处理窗口大小变化
     */
    handleResize() {
        // 防抖处理
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
        }

        this.resizeTimer = setTimeout(() => {
            this.updateZoomLevel();
            this.adjustModalSizes();
        }, 100);
    }

    /**
     * 处理鼠标滚轮缩放
     */
    handleWheel(event) {
        // 检测是否是Ctrl+滚轮的缩放操作
        if (event.ctrlKey) {
            setTimeout(() => {
                this.updateZoomLevel();
                this.adjustModalSizes();
            }, 50);
        }
    }

    /**
     * 处理键盘缩放快捷键
     */
    handleKeydown(event) {
        // 检测Ctrl + +/-/0 缩放快捷键
        if (event.ctrlKey && (event.key === '+' || event.key === '-' || event.key === '0')) {
            setTimeout(() => {
                this.updateZoomLevel();
                this.adjustModalSizes();
            }, 50);
        }
    }

    /**
     * 更新缩放级别
     */
    updateZoomLevel() {
        // 通过比较实际像素和逻辑像素来检测缩放级别
        const devicePixelRatio = window.devicePixelRatio || 1;
        const viewport = {
            width: window.innerWidth,
            height: window.innerHeight
        };

        // 计算缩放比例
        this.zoomLevel = Math.round((devicePixelRatio + viewport.width / screen.width) * 50) / 100;

        // 设置CSS自定义属性，可以在CSS中使用
        document.documentElement.style.setProperty('--zoom-level', this.zoomLevel);
        document.documentElement.style.setProperty('--viewport-width', `${viewport.width}px`);
        document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
    }

    /**
     * 调整弹出框大小
     */
    adjustModalSizes() {
        const modals = document.querySelectorAll('.nn-modal');

        modals.forEach(modal => {
            // 获取弹出框类型
            const modalType = this.getModalType(modal);

            // 根据缩放级别和弹出框类型调整样式
            this.applyModalStyles(modal, modalType);
        });

        // 执行注册的回调函数
        this.callbacks.forEach(callback => {
            try {
                callback(this.zoomLevel);
            } catch (error) {
                console.warn('Modal resize callback error:', error);
            }
        });
    }

    /**
     * 获取弹出框类型
     */
    getModalType(modal) {
        if (modal.classList.contains('modal-small')) return 'small';
        if (modal.classList.contains('modal-medium')) return 'medium';
        if (modal.classList.contains('modal-large')) return 'large';
        if (modal.classList.contains('modal-xlarge')) return 'xlarge';
        return 'medium'; // 默认中型
    }

    /**
     * 应用弹出框样式
     */
    applyModalStyles(modal, type) {
        const zoomFactor = Math.max(0.7, Math.min(1.3, this.zoomLevel));

        // 调整字体大小
        const baseFontSize = {
            small: 13,
            medium: 14,
            large: 14,
            xlarge: 15
        };

        const fontSize = Math.max(12, baseFontSize[type] * zoomFactor);
        modal.style.fontSize = `${fontSize}px`;

        // 调整内容区域的最小高度
        const modalBody = modal.querySelector('.nn-modal-body');
        if (modalBody) {
            const minHeight = Math.max(150, 200 * zoomFactor);
            modalBody.style.minHeight = `${minHeight}px`;
        }
    }

    /**
     * 注册缩放变化回调
     */
    onZoomChange(callback) {
        if (typeof callback === 'function') {
            this.callbacks.push(callback);
        }
    }

    /**
     * 移除缩放变化回调
     */
    offZoomChange(callback) {
        const index = this.callbacks.indexOf(callback);
        if (index > -1) {
            this.callbacks.splice(index, 1);
        }
    }

    /**
     * 获取当前缩放级别
     */
    getZoomLevel() {
        return this.zoomLevel;
    }
}

// 创建全局实例
const modalResizeHandler = new ModalResizeHandler();

// 自动启动监听
if (typeof window !== 'undefined') {
    // 页面加载完成后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            modalResizeHandler.startListening();
        });
    } else {
        modalResizeHandler.startListening();
    }
}

export default modalResizeHandler;
