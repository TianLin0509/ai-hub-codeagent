# 开发群聊的项目准备

普通会话和「通用」群聊直接选择工作目录即可，不要求项目登记。公开版群聊默认打开通用场景。

「开发」群聊带作者/合并位和文件交付流程，需要项目自身有验证、分支与合并约定。推荐让 agent 按 [project-prep 仓库](https://github.com/TianLin0509/project-prep) 的 README 安装并使用该工具整理自己的 Git 仓库。它是独立可选工具，没有捆绑作者机器上的 skill。

完成准备且项目主目录具有有效 `.agents/project.json` 后，在 **Hub 源码目录** 执行：

```powershell
node scripts/prepared-projects.js register "D:\Projects\YourProject"
node scripts/prepared-projects.js list
```

把示例路径换成真实项目主目录；不要登记 linked worktree、临时测试副本或不属于用户的仓库。默认登记到当前公开版的 `.ai-hub-community`；隔离验证可显式加 `--data-dir`。

回到「开发」群聊刷新项目库，选择已登记项目。准备前已有未提交修改应先确认归属，不能 reset/stash 掩盖。项目的测试与合并要求以它自己的 AGENTS.md 和 `.agents` 合同为准。

如果只需要 AI 一起讨论或编写草稿，使用「通用」即可，不必为了开始聊天强行建立项目工作流。
