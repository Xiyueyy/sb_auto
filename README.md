# sb_auto

sb.sb Blackjack 自动基本策略脚本。

## 安装

1. 安装 Tampermonkey。
2. 打开 `sb_blackjack_auto.user.js`。
3. 点击 GitHub 的 **Raw**，Tampermonkey 会识别并提示安装。
4. 打开 https://sb.sb/games/blackjack/ 。

## 当前功能

- 固定下注
- 指定自动局数（0 = 无限）
- 使用网页原生按钮操作，保留发牌 / drand 等待 / 动画 / 结算
- 6 副牌、S17、DAS 基本策略
- 自动不买保险
- 胜 / 负 / 平、本轮净收益、总押注、RTP
- 最近 100 局本地历史
- CSV 导出

> 该脚本针对 sb.sb 当前 Blackjack 页面结构编写。页面结构变化后可能需要更新。
