<template>
    <div class="config-section">
        <div class="section-title">AS Path</div>
        <nn-row :gutter="[16, 0]">
            <nn-col :xs="24" :md="8">
                <nn-form-item label="随机生成">
                    <nn-switch
                        :checked="config.randomAsPathEnabled"
                        @update:checked="value => emit('change', 'randomAsPathEnabled', value)"
                    />
                </nn-form-item>
            </nn-col>
            <nn-col :xs="24" :md="8">
                <nn-form-item label="起始 AS">
                    <nn-input
                        :value="config.asMin"
                        :disabled="!config.randomAsPathEnabled"
                        @update:value="value => emit('change', 'asMin', value)"
                    />
                </nn-form-item>
            </nn-col>
            <nn-col :xs="24" :md="8">
                <nn-form-item label="结束 AS">
                    <nn-input
                        :value="config.asMax"
                        :disabled="!config.randomAsPathEnabled"
                        @update:value="value => emit('change', 'asMax', value)"
                    />
                </nn-form-item>
            </nn-col>
            <nn-col :xs="24" :md="12">
                <nn-form-item label="最少 AS 数">
                    <nn-input
                        :value="config.asPathMinLength"
                        :disabled="!config.randomAsPathEnabled"
                        @update:value="value => emit('change', 'asPathMinLength', value)"
                    />
                </nn-form-item>
            </nn-col>
            <nn-col :xs="24" :md="12">
                <nn-form-item label="最多 AS 数">
                    <nn-input
                        :value="config.asPathMaxLength"
                        :disabled="!config.randomAsPathEnabled"
                        @update:value="value => emit('change', 'asPathMaxLength', value)"
                    />
                </nn-form-item>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    const emit = defineEmits(['change']);

    defineProps({
        config: {
            type: Object,
            required: true
        }
    });
</script>
