# dsh-plugin-bootreport

启动自报账本：web 启动时把「本进程加载了哪些插件构建」落一行到 <DSH_HOME>/plugin-boot.jsonl，一条命令判全生态「构建是否生效」（治 §5.11 规则 6 的生态级盲区）

## 工具
- `plugin_boot_status`：读启动自报账本：最近一次 web 启动时间、被判「已生效/需重启」的插件清单（构建生效判据：lib mtime ≤ 进程启动时间）

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

组合行 id：`agent-plugin-bootreport`
