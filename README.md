# sb_auto

sb.sb 游戏辅助 Userscript 集合。

## 一键安装

先安装 [Tampermonkey](https://www.tampermonkey.net/)，然后点击对应按钮即可打开安装页：

| 脚本 | 一键安装 |
| --- | --- |
| Blackjack Auto Pro | [![安装 Blackjack](https://img.shields.io/badge/Tampermonkey-安装_Blackjack-2ea44f?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/Xiyueyy/sb_auto/main/sb_blackjack_auto.user.js) |
| 消消乐 Auto | [![安装消消乐](https://img.shields.io/badge/Tampermonkey-安装_消消乐-2ea44f?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/Xiyueyy/sb_auto/main/sb_match3_auto.user.js) |
| 雷霆战机 Auto | [![安装雷霆战机](https://img.shields.io/badge/Tampermonkey-安装_雷霆战机-2ea44f?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/Xiyueyy/sb_auto/main/sb_thunder_auto.user.js) |

> 已安装旧版本时，点击同一个按钮会进入 Tampermonkey 的更新/重新安装页面。

## 脚本

### Blackjack Auto Pro（v3）

文件：`sb_blackjack_auto.user.js` · 页面：https://sb.sb/games/blackjack/

**三种模式**

- **前台可视**：点网页原生按钮，保留发牌、drand 等待、动画和结算；决策读站点 state，不解析牌面。
- **后台稳定**：直接调用站点正常的 Start / Move / State 接口，按 `reveal_at` 精确等待，切到别的标签页也能继续（Worker 心跳防节流）。
- **仅提示**：不自动操作，只实时显示这一步该怎么打和剩余秒数，你自己点。

**策略**

- 针对本站规则的最优基本策略：6 副牌、每局重新洗牌、庄家无暗牌、软 17 停、黑杰克 3:2、分牌后可加倍、最多分 4 手、分 A 只补一张、庄家黑杰克只输原注。
- 用逐手精确期望值校验过全部 540 种起手（0 处偏差），300 万局模拟回报率约 99.5%。
- 永远不买保险（无暗牌且每局洗牌，保险是负期望）。
- 站点此刻不允许的动作（比如余额不够加倍）自动退化为最接近的合法动作，不会卡住等到超时。

**停止条件**（都可以运行中修改）

- 局数（0 = 不限）
- 止盈 / 止损：本轮净收益达到 +X 或 −Y 就停
- 余额保护：下注后余额会低于设定值就停
- 「打完本局停」按钮

**稳定性**

- 接口出错先快速重试，再逐步退避，避免拖过 10 秒决策时间被判停牌；连续失败 12 次自动停止。
- 用 `server_now` 校准时钟，等待和倒计时与服务器一致。
- 启动时如果已有进行中的局，会接管并计入本轮。

**界面**

- 独立 Shadow DOM 面板，不受站点样式影响；可拖动（双击标题复位），可折叠，手机上默认折叠。
- 本轮净收益、余额、盈亏曲线、实时状态和策略理由。
- 统计页：胜负平、胜率、RTP、总押注、最高/最低、黑杰克、加倍/分牌、爆牌、理论期望。
- 历史页：最近 300 局本地记录，点开直达站点的牌局详情（可验证 drand），支持导出 CSV；自动沿用 v2 的历史记录。

> 关于胜率：照最优策略打，长期每局平均仍会亏底注的 0.5% 左右，这是规则决定的。牌在你做决定之后才由 drand 生成、每局重新洗牌，算牌和倍投都改变不了期望。止盈止损只是帮你在运气好的时候收手。

### 消消乐 Auto

文件：`sb_match3_auto.user.js`

- 练习 / 正式计奖双模式，默认练习模式
- 正式计奖模式启动前二次确认；会检查游戏币余额和每日计奖上限（站点状态有返回时）
- 正式局每局按站点当前规则扣游戏币，并记录奖励与净收益
- 正式模式可设置目标分数；当前局达到目标后停止继续消除，等待该局结算，再按设定局数自动进入下一局
- 自动分析 8×8 棋盘，枚举所有相邻交换
- 优先选择即时消除数量更高的有效步
- 两种运行方式：
  - **前台可视**：通过网页原生 Pointer 事件操作，保留交换、消除、连消动画
  - **后台稳定**：直接使用站点正常 start / move / state API；不依赖棋盘 DOM，切后台更稳定，但棋盘动画可能不会实时刷新
- 可设置总局数（0 = 无限）和每步缓冲时间
- 当前分、剩余时间、游戏币、净收益、最高分、平均分、有效/无效步统计
- 最近 100 局本地历史，区分练习 / 正式计奖

页面：https://sb.sb/games/match-3/

### 雷霆战机 Auto

文件：`sb_thunder_auto.user.js`

- 练习 / 正式计奖双模式，正式模式启动前二次确认
- 可设置自动局数（0 = 无限），并按每日计奖上限自动停止
- 可设置保分分数（0 = 关闭）；后台模式达标后自动停火并以躲弹保命为主，前台模式达标后停止自动移动等待结算
- 三种 AI：保命优先 / 均衡 / 激进追分
- 自动开火、自动躲弹、自动追补给与敌机
- 两种运行方式：
  - **前台可视**：保留原站 WASM 渲染和正常提交，脚本只自动控制方向
  - **后台稳定**：脚本使用站点同一个 WASM 引擎本地推进，并按正常 60 帧 Input 分块提交，最后走 Finish 结算
- 当前分、剩余时间、生命、火力、游戏币、本轮净收益、最高分、平均分
- 最近 100 局本地历史，记录分数、击毁、结束原因和正式局净收益

页面：https://sb.sb/games/thunder-fighter/

## 安装

1. 安装 Tampermonkey。
2. 打开需要的 `.user.js` 文件。
3. 点击 GitHub 的 **Raw**，Tampermonkey 会识别并提示安装。
4. 打开对应游戏页面并刷新。

> 脚本针对 sb.sb 当前页面结构编写。站点页面或接口变化后可能需要更新。

> 后台稳定模式仍受浏览器页面休眠/冻结策略影响；完全休眠时任何 Userscript 都可能暂停。脚本不包含绕过站点检测或认证的逻辑。
