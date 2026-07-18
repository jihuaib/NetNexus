# NETCONF Mock 测试 Fixture

`netconfMockHostKey.pem` 是故意提交到仓库中的公开、固定 SSH Host Key，只供 `npm run mock:netconf` 在本机回环地址上进行开发和自动化测试。

该 PEM 不是秘密。任何能够读取此仓库的人都持有同一私钥，因此它不能证明远端身份，也不能用于生产设备、共享实验室、CI 之外的长期服务或任何不可信网络。固定 Key 的唯一目的，是让本地 Mock Server 多次启动时保持稳定的 SSH Host Key 指纹，避免 NetNexus Profile 已固定的指纹在重启后失效。

Mock Server 默认只监听 `127.0.0.1`，并拒绝在未显式提供 `--allow-remote` 时绑定非回环地址。`--allow-remote` 不会让这把公开 Key 变得安全。如确实需要在隔离实验网络中监听远端地址，请通过 `--host-key` 提供自行生成且妥善保管的私钥，同时更换默认用户名和密码：

```bash
npm run mock:netconf -- \
  --host 0.0.0.0 \
  --allow-remote \
  --host-key /absolute/path/to/private-host-key.pem \
  --username lab-user \
  --password 'replace-with-a-strong-lab-password'
```

不要在本目录中添加真实设备私钥、个人 SSH 私钥、生产凭据或其他秘密。
