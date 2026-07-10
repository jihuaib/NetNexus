<template>
    <span ref="textRef" class="nn-typography-text">
        <span class="nn-typography-content">
            <slot />
        </span>
        <button v-if="copyable" class="nn-typography-copy" type="button" @click="copyText">复制</button>
    </span>
</template>

<script setup>
    import { ref } from 'vue';

    defineProps({
        copyable: {
            type: [Boolean, Object],
            default: false
        }
    });

    const textRef = ref(null);

    const fallbackCopy = text => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    };

    const copyText = async () => {
        const text = textRef.value?.querySelector('.nn-typography-content')?.textContent?.trim() || '';
        if (!text) {
            return;
        }

        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        fallbackCopy(text);
    };
</script>

<style scoped>
    .nn-typography-text {
        display: inline;
        color: inherit;
        overflow-wrap: inherit;
        word-break: inherit;
    }

    .nn-typography-copy {
        display: inline-flex;
        align-items: center;
        margin-inline-start: 4px;
        padding: 0 4px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-link);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        line-height: 18px;
    }

    .nn-typography-copy:hover {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary-hover);
    }
</style>
