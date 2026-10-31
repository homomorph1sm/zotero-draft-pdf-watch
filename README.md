# Draft PDF Watch · 论文 PDF 版本监控

为固定 Zotero 文献条目监控本地论文 PDF 版本，发现更新后提示、一键替换，或按条目开启自动替换。

## 安装与升级

从 [最新 Release](https://github.com/homomorph1sm/zotero-draft-pdf-watch/releases/latest) 下载 `.xpi`，在 Zotero「工具 → 插件 → 齿轮 → 从文件安装插件」中安装。

**从本地 0.1.0 / 0.1.1 升级时，请手动安装一次 0.1.2 或更新版本。** 旧版没有有效在线更新地址；安装接入 GitHub 的版本后，后续可以在 Zotero 插件管理中检查更新，或使用 Zotero 的自动更新设置。插件 ID 保持不变，原监控规则保留。

## 使用

1. 选中论文父条目，右键选择「监控此条目的论文 PDF…」。
2. 选择版本文件夹，设置该论文专属匹配规则，例如 `paper_v*.pdf`。
3. 选择文件名自然排序（`v2 → v10`）或文件修改时间排序，预览候选文件。
4. 选择需要替换的现有 PDF，保存规则。默认发现更新后通知，手动点击更新。
5. 旧绑定失效时，点击「刷新附件列表 / 修复绑定」，核对当前 PDF，再保存。

新 PDF 复制并校验成功后，旧附件及其批注移入 Zotero 回收站；父条目、独立笔记及其他附件保留。来源文件不会被删除。自动模式可按条目开启。

窗口内的黄色通知条右侧有「×」关闭按钮。关闭会记住当前提醒，监控继续运行；同一提醒不会随定时检查或重启重复显示，新的 PDF 或错误会再次提醒。仍可从工具菜单打开监控面板处理待办。

## 运行范围

- 目标版本：Zotero 10.0.x；此前在 Windows Zotero 10.0.7 的隔离库验证过核心替换流程。
- Zotero 运行时每 15 秒检查，文件须至少两次检查且稳定 3 秒；仅扫描所选目录，不递归子目录。
- 自然排序比较整个文件名中的文字与数字；请保持同一论文的前缀和命名格式一致。
- 最大 PDF 大小为 256 MB；检查 PDF 头与结束标记，替换前后核对文件内容。
- 配置保存在本机 Zotero profile 的 `draft-pdf-watch.json`；本机路径绑定不跨设备同步。
- 单元测试使用模拟 Zotero API，不能替代所有原生界面及第三方插件组合测试。

## 拉取源码与本地构建

```sh
git clone https://github.com/homomorph1sm/zotero-draft-pdf-watch.git
cd zotero-draft-pdf-watch
python build.py
```

输出位于 `dist/`。以后可以 `git pull --ff-only` 后再次构建并安装新的 XPI。**仅执行 git pull 不会更新 Zotero 中已经安装的插件。**

测试无需 npm 依赖：

```sh
node --test tests/*.test.cjs
python -m unittest discover -s tests -p 'test_*.py'
```

## 发布新版（仓库维护者）

修改代码与 `manifest.json` 的版本号，通过测试后提交，并推送对应版本标签。例如下一版 `0.1.3`：

```sh
git add .
git commit -m "Release 0.1.3"
git tag v0.1.3
git push origin main
git push origin v0.1.3
```

Release workflow 会核对标签与版本号、执行测试，并发布 XPI、SHA-256 和 `updates.json`。应按递增版本发布；稳定更新地址指向最新正式 Release，XPI 链接固定到具体版本。

## 开源参考

调研了 [Replace PDF](https://github.com/adamsghaier/zotero-replace-pdf)、[Watch Folder](https://github.com/josesiqueira/zotero-watch-folder)、[Attanger](https://github.com/MuiseDestiny/zotero-attanger)。本插件独立实现逐条目绑定与替换状态，未复制这些项目源码。更新格式参考 [Zotero 开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson) 与 [GitHub Release 下载链接](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)。

MIT License，详见 [LICENSE](LICENSE)。
