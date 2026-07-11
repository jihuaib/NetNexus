import { defineComponent } from 'vue';

export default defineComponent({
    name: 'NnRenderContent',
    props: {
        content: {
            type: null,
            default: ''
        }
    },
    setup(props) {
        return () => (typeof props.content === 'function' ? props.content() : props.content);
    }
});
