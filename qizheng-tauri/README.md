# 人生规划

Windows 本地排盘与文字整理工具。界面使用 Tauri 2，排盘与天文计算由 Moira 1.50 的 Java 源码通过 GraalVM 编译为随包本机计算程序；使用时无需另装 Java 或 Moira。程序使用随包城市、历史时区和星历数据，生成的文字可以复制或导出。Windows 需要 Microsoft Edge WebView2 Runtime。

新建资料默认使用“中国北京时间（自动）”，按 IANA 历史规则处理 1986—1991 年夏令时。生效时采用 UTC+9，输入区和命盘文本会提示校正 1 小时。交接时刻校验跳时与回拨。既有档案按已保存的最终 UTC 偏移载入，可切换自动模式重新核对。

输入区以双栏一页显示。地区时区模式会检查历史夏令时、重复时刻和跳时，旧版 `.mprofile` 可从资料库导入。资料默认保存在当前 Windows 用户的本地应用数据目录。

`engine/src` 包含原计算源码及文字计算入口。`Resource.java` 去除了图形字体枚举，`DiagramTip.java` 用标准点类型替换旧界面的 SWT 点类型。`Geomag.java` 包含 WMM 模型年代修正。原项目和星历库的版权与许可见源文件及 `src-tauri/resources/runtime/moira`。

## 构建

需要 Windows x64、Visual Studio C++ 构建工具和 Windows SDK、Rust、Node.js、GraalVM Community JDK 21.0.2 与 WebView2 Runtime。

1. 在 x64 开发者命令环境设置 `JAVA_HOME` 指向 GraalVM，执行 `powershell -ExecutionPolicy Bypass -File engine/build.ps1`。
2. 执行 `python engine/verify.py`，以合成资料对照原 Moira 的输出哈希。
3. 执行 `npm ci` 和 `npm run build:portable`，可执行程序位于 `src-tauri/target/release/jinshu-qizheng.exe`。将它与 `src-tauri/resources/runtime` 文件夹放在同一个目录即可运行。

仓库根目录的 GitHub Actions 工作流执行上述 Windows 云端构建，产物包含“人生规划.exe”和 runtime 文件夹，可从对应运行记录的 Artifacts 下载。

## 资料与许可

IANA 2026f 时区和 GeoNames 2026-11-05 城市快照在 `src-tauri/resources/runtime/data`。已有档案记录的是最终 UTC 偏移，地区标识和回拨选项本身不写入旧档案格式。

本项目沿用 Moira 1.50 的 GPL 许可和原随包 Swiss Ephemeris Free Edition 1.64.01 的 SEPL 许可。独立分发和商业使用应核对实际使用版本的授权条款。源码中的版权声明应与相关资源及许可证一起保留。

排盘统一使用产品内置计算核心。计算结果已用 8 组合成资料与原版逐字节对照，这不代表所有日期和盘式均已验证。可执行程序与 runtime 文件夹须放在一起；建议放在较短的路径。
