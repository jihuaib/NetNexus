# NetNexus UI

NetNexus UI 是项目内置的 Vue 3 组件库，不依赖第三方完整 UI 框架。组件统一使用 `Nn` 前缀，并由 `registerUiComponents.js` 全局注册。

## 约定

- 组件文件使用 `NnXxx.vue`，模板使用 `<nn-xxx>`。
- 表单控件沿用 `v-model:value`；开关和复选框沿用 `v-model:checked`；弹窗、抽屉使用 `v-model:open`。
- 视觉值只引用 `src/assets/styles/theme.css` 中的 `--nn-*` token，同时支持亮色、蓝色和暗色主题。
- Modal、Drawer、Select、Dropdown、Tooltip、Popconfirm 等浮层使用 `Teleport`，避免被业务容器的 `overflow` 裁剪。
- Modal 和 Drawer 默认不会因点击外部遮罩关闭；确需该行为时显式传入 `:mask-closable="true"`。
- 业务页不应直接依赖组件内部 DOM；确需布局覆盖时，只使用 `.nn-*` 类。

## 组件范围

- 基础：Button、Card、Tag、Badge、Alert、Divider、Space、Row、Col、TypographyText。
- 输入：Input、Textarea、InputNumber、InputPassword、InputSearch、Select、Checkbox、Radio、Switch、RangePicker。
- 数据：Table、Tree、List、Descriptions、Statistic、Empty。
- 导航：Menu、Tabs、Segmented、Dropdown。
- 反馈：Modal、Drawer、Tooltip、Popconfirm、Spin，以及通知和确认服务。

运行 `npm test` 会执行 UI 依赖守卫，阻止旧组件标签、旧 DOM 类或完整第三方 UI 框架重新进入项目。
