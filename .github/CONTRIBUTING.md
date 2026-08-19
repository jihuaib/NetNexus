# 贡献指南

感谢你对 NetNexus 项目的兴趣！我们欢迎任何形式的贡献。

## 如何贡献

### 🐛 报告 Bug

1. 在 [Issues](https://github.com/jihuaib/NetNexus/issues) 页面搜索是否已存在相似问题
2. 如果没有，请创建新的 Issue，使用 Bug 报告模板
3. 提供详细的问题描述、重现步骤和环境信息

### 💡 提出新功能

1. 在 [Issues](https://github.com/jihuaib/NetNexus/issues) 页面搜索是否已有相似建议
2. 创建新的 Issue，使用功能请求模板
3. 详细描述功能需求和使用场景

### 🔧 提交代码

1. Fork 本仓库
2. 创建你的功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 开发设置

### 环境要求

- Node.js 16.20.2 或更高版本（应用 CI 固定使用 16.20.2）
- npm 8.19.4 或更高版本
- Git

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/jihuaib/NetNexus.git
cd NetNexus

# 安装依赖
npm install

# 启动开发环境
npm run dev

# 代码检查
npm run lint

# 修复代码格式
npm run lint:fix
```

## 代码规范

- 遵循项目的 ESLint 配置
- 使用 Prettier 进行代码格式化
- 组件使用 Vue 3 Composition API
- 保持代码简洁和可读性
- 添加必要的注释

## 提交规范

请使用以下格式提交代码：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式修改
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建或辅助工具相关

### Scope 范围

- `bgp`: BGP 模拟器
- `bmp`: BMP 监控器
- `rpki`: RPKI 验证器
- `parser`: 报文解析器
- `tools`: 工具模块
- `ui`: 用户界面
- `core`: 核心功能

### 示例

```
feat(bgp): 添加 BGP 对等体状态监控功能

- 新增对等体连接状态显示
- 添加状态变化通知
- 优化状态更新性能

Closes #123
```

## 测试

在提交 PR 之前，请确保：

- [ ] 代码通过 lint 检查
- [ ] 功能正常工作
- [ ] 没有破坏现有功能
- [ ] 添加了必要的文档

## 社区准则

请参考我们的 [行为准则](CODE_OF_CONDUCT.md)，确保友好和包容的社区环境。

## 获得帮助

如果你有任何问题，可以：

- 查看项目文档
- 在 Issues 中搜索相关问题
- 创建新的 Issue 提问

感谢你的贡献！🎉
