<template>
    <section class="hero">
        <div class="hero-content container">
            <div class="hero-badge animate-fade-in">免费开源 · 跨平台 · 专业级</div>
            <h1 class="hero-title animate-fade-in">
                <span class="gradient-text">NetNexus</span>
                <br />
                专业网络工具集
            </h1>
            <p class="hero-desc animate-fade-in" style="animation-delay: 0.2s">
                基于 Vue3 + Electron 构建的一站式网络协议工具集，集成 BGP 模拟器、BMP 监控器、RPKI 验证器、SNMP
                管理器、FTP 服务器以及报文解析、TCP-AO MAC 计算等多种实用开发工具，助力网络协议研发与调试。
            </p>
            <div class="hero-actions animate-fade-in" style="animation-delay: 0.4s">
                <button class="btn btn-primary" @click="learnMore">了解更多</button>
            </div>
            <DownloadStats class="animate-fade-in" style="animation-delay: 0.5s" />
            <div class="hero-platforms animate-fade-in" style="animation-delay: 0.6s">
                <span>支持平台：</span>
                <span class="platform-tag">Windows x64</span>
                <span class="platform-tag">macOS x64</span>
                <span class="platform-tag">macOS arm64</span>
            </div>
        </div>
        <div class="hero-background">
            <div class="glow-sphere sphere-1"></div>
            <div class="glow-sphere sphere-2"></div>
        </div>
    </section>
</template>

<script setup>
    import DownloadStats from './DownloadStats.vue';

    const learnMore = () => {
        document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
    };
</script>

<style scoped>
    .hero {
        position: relative;
        min-height: 100vh;
        display: flex;
        align-items: center;
        overflow: hidden;
        padding-top: 4rem; /* For header if any */
    }

    .hero-content {
        position: relative;
        z-index: 10;
        text-align: center;
        max-width: 800px;
    }

    .hero-title {
        font-size: 4rem;
        font-weight: 800;
        line-height: 1.2;
        margin-bottom: 1.5rem;
        letter-spacing: -0.02em;
    }

    .hero-desc {
        font-size: 1.25rem;
        color: var(--text-secondary);
        margin-bottom: 3rem;
        max-width: 600px;
        margin-left: auto;
        margin-right: auto;
    }

    .hero-actions {
        display: flex;
        gap: 1.5rem;
        justify-content: center;
    }

    .btn {
        padding: 0.875rem 2rem;
        border-radius: 9999px;
        font-weight: 600;
        font-size: 1rem;
        transition: all 0.3s ease;
    }

    .btn-primary {
        background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
        color: white;
        box-shadow: 0 4px 15px var(--accent-glow);
    }

    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px var(--accent-glow);
    }

    .btn-secondary {
        background: var(--glass-bg);
        color: var(--text-primary);
        border: 1px solid var(--glass-border);
    }

    .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .hero-background {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 1;
        pointer-events: none;
    }

    .glow-sphere {
        position: absolute;
        border-radius: 50%;
        filter: blur(100px);
        opacity: 0.4;
    }

    .sphere-1 {
        width: 500px;
        height: 500px;
        background: var(--accent-primary);
        top: -100px;
        left: -200px;
        animation: float 10s infinite alternate;
    }

    .sphere-2 {
        width: 400px;
        height: 400px;
        background: var(--accent-secondary);
        bottom: -50px;
        right: -100px;
        animation: float 8s infinite alternate-reverse;
    }

    @keyframes float {
        0% {
            transform: translate(0, 0);
        }
        100% {
            transform: translate(50px, 50px);
        }
    }

    .hero-badge {
        display: inline-block;
        padding: 0.35rem 1rem;
        border-radius: 9999px;
        border: 1px solid rgba(99, 102, 241, 0.4);
        background: rgba(99, 102, 241, 0.1);
        color: var(--accent-secondary);
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 1.5rem;
        letter-spacing: 0.03em;
    }

    .hero-platforms {
        margin-top: 2rem;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        justify-content: center;
        color: var(--text-secondary);
        font-size: 0.875rem;
        flex-wrap: wrap;
    }

    .platform-tag {
        padding: 0.2rem 0.75rem;
        border-radius: 9999px;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        color: var(--text-primary);
        font-size: 0.8rem;
    }

    @media (max-width: 768px) {
        .hero-title {
            font-size: 2.5rem;
        }
    }
</style>
