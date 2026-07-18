<template>
    <span
        v-for="(token, index) in tokens"
        :key="`${index}-${token.type}`"
        :class="`xml-token-${token.type}`"
        :data-xml-token="token.type"
    >
        {{ token.value }}
    </span>
</template>

<script setup>
    import { computed } from 'vue';
    import { tokenizeXml } from './xmlSyntax';

    defineOptions({ name: 'XmlHighlight' });

    const props = defineProps({
        value: {
            type: [String, Number],
            default: ''
        }
    });

    const tokens = computed(() => tokenizeXml(props.value));
</script>

<style scoped>
    .xml-token-tag {
        color: var(--nn-color-syntax-tag);
    }

    .xml-token-attribute {
        color: var(--nn-color-syntax-attribute);
    }

    .xml-token-value {
        color: var(--nn-color-syntax-value);
    }

    .xml-token-comment {
        color: var(--nn-color-syntax-comment);
        font-style: italic;
    }

    .xml-token-declaration {
        color: var(--nn-color-syntax-declaration);
    }

    .xml-token-cdata {
        color: var(--nn-color-syntax-cdata);
    }

    .xml-token-entity {
        color: var(--nn-color-syntax-entity);
    }

    .xml-token-punctuation {
        color: var(--nn-color-syntax-punctuation);
    }

    .xml-token-text,
    .xml-token-plain {
        color: var(--nn-color-text);
    }
</style>
