# OneCard Lab 上手指南

从零开始，大约 15 分钟就能刷第一张卡。不需要任何硬件，也不需要云端账号：
服务器、机器和卡全部在你自己的电脑上跑。

[English → GETTING-STARTED.md](GETTING-STARTED.md)

## 你会得到什么

一个虚拟的 **OneCard 平台**（"云端服务器"：MQTT broker、平台和数据库），同时服务两所虚构的学校，
每所学校是一个独立的租户（tenant）：

| 学校 | 机器 | 卡 |
|---|---|---|
| SMK Seri Contoh（`smk-contoh`） | CANTEEN-01、CANTEEN-02（网线没插）、WATER-01（网线没插）、KIOSK-01 | 6 个学生、1 个老师 |
| SJK(C) Contoh（`sjkc-contoh`） | CANTEEN-01、WATER-01、KIOSK-01 | 4 个学生 |

另外还有 6 位家长（其中一位在两所学校都有孩子），卡里也已经有一些钱——是用真实流程放进去的：
家长付款，学生到充值机刷卡。

## 第 1 步：安装 Node.js（只需一次）

> 不想装 Node.js？**桌面版**是一个文件，什么都包含在里面：看 README 里的
> [桌面版（不用装 Node.js）](../README.md#中文简介)，然后直接跳到第 4 步。

**Windows**
1. 打开 <https://nodejs.org/>，下载 **LTS** 版本（Windows Installer，`.msi`）。
2. 运行安装程序，全部用默认值（Next、Next、Install）。
3. 打开 **PowerShell**（开始菜单 → 输入 `powershell` → Enter），检查版本：
   ```powershell
   node -v
   ```
   看到 `v22.13.0` 或更新的版本（例如 `v24.x`）就可以。

**Mac**
1. 在 <https://nodejs.org/> 下载 **LTS** 安装包（`.pkg`）并安装。
2. 打开 **Terminal**（⌘ 空格 → 输入 `terminal`），输入 `node -v` 检查。

## 第 2 步：下载代码

- **最简单：** 在这个仓库的 GitHub 页面按 **Code → Download ZIP**，解压到例如 `C:\OneCard-demo`（Windows）或桌面（Mac）。
- **用 Git：** `git clone https://github.com/Rogerkkong/OneCard-demo.git`

## 第 3 步：启动实验室

**最简单：双击（Mac 和 Windows）**

1. 打开项目文件夹（解压后的文件夹，或 GitHub Desktop、Git 下载的文件夹）。
2. 双击启动文件：
   - Mac：**Start OneCard Lab.command**
   - Windows：**Start OneCard Lab.bat**
3. 会打开一个窗口（Mac 上是 Terminal）。第一次会先下载实验室用的两个库（需要网络，大约一分钟）。
   然后实验室启动，**浏览器会自己打开实验室控制台**。

只有第一次，电脑可能会先问你：

- **Mac**，如果文件夹是从网上下载的 ZIP：macOS 会说无法检查这个文件。右键点启动文件 → **打开** → **打开**。
  macOS 15（Sequoia）以后：先双击一次、关掉提示，再打开 **系统设置 → 隐私与安全性**，往下拉，按 **仍要打开** 并确认。
  （用 Git 或 GitHub Desktop 拿到的文件夹不会这样。）
- **Mac**：如果 macOS 问 Terminal 能不能访问"桌面"（或"文稿""下载"）文件夹里的文件，按 **允许**（或 **好**）：实验室的文件就在那里。
- **Windows**：如果 SmartScreen 显示"Windows 已保护你的电脑"，按 **更多信息** → **仍要运行**。
  要在*解压后*的文件夹里双击，不要在 ZIP 里面双击。
- 如果没有 Node.js 或版本太旧，窗口会（用英文和中文）说明，并打开 Node.js 下载页：做完第 1 步，再双击一次启动文件。

**用终端（Terminal）**

1. 在**项目文件夹里**打开终端：
   - Windows：用文件资源管理器打开这个文件夹，点一下地址栏，输入 `powershell`，按 Enter。
   - Mac：在 Terminal 输入 `cd `（后面有一个空格），把文件夹拖进窗口，按 Enter。
2. 第一次才需要：下载实验室用到的两个库：
   ```sh
   npm install
   ```
3. 启动：
   ```sh
   npm start
   ```
   （`npm start -- --open` 会顺便在浏览器里打开实验室控制台。）
4. 你会看到：
   ```text
   OneCard Lab is running (lab data only — nothing here is real).

     Lab console     http://127.0.0.1:8080/lab/
     Operator        http://127.0.0.1:8080/operator/
     School office   http://127.0.0.1:8080/admin/
     Parent app      http://127.0.0.1:8080/parent/
     ...
   ```

不管用哪种方法，实验室的窗口都不要关：**它就是服务器**。关掉它，或在里面按 **Ctrl+C**，就会停止实验室。
每次启动都会回到同一份全新的示范资料，所以怎么玩都不会弄坏。

## 第 4 步：刷第一张卡（浏览器）

打开 **<http://localhost:8080/lab/>**：实验室控制台，可以看到整个虚拟系统。

- 最上面是**虚拟云端服务器**（MQTT broker · 平台 · 数据库），有**关掉服务器**和**重启 broker**两个按钮。
- 下面每所学校一个区块：一台服务器服务很多学校，这就是 SaaS。
- 每所学校区块里是它的机器：食堂刷卡机、饮水机、充值机。每台都有自己的小**屏幕**、网线状态，
  还有它手上的价格和黑名单版本。
- 右边是**消息**页签（实时看每一条消息）和**控制台**页签。

**买东西**
1. 在 **SMK Seri Contoh** 的 **CANTEEN-01** 上按**刷卡**。
2. 选卡：*Ahmad Faiz bin Rahman · 04A13B5C7D2E80 · RM 30.00*。
3. 在 *Nasi lemak* 和 *Teh tarik* 旁边按 **+**，再按**刷卡 · 付 RM 5.30**。
4. 机器屏幕显示 **Paid RM 5.30 · Balance RM 24.70**。在**消息**里可以一步步看这笔消费：
   刷卡机用 MQTT 发出 `sale.recorded`，平台接收、记账，卡上的新余额写进卡里。

**拔网线**
1. 在 **CANTEEN-01** 按**拔网线**，状态变成 *No network*。
2. 等 3 秒（同一张卡 3 秒内不能付两次），再按**刷卡**买一个 Roti canai。照样能买：钱在卡里。
   这笔记录先存在机器的日志里（*1 unsent*）。
3. 按**插上网线**。机器重新连上，把存着的记录上传（`journal.batch`）。

**像家长一样充值**
1. 点右上角的**家长网页**（Parent app），用 **Rahman bin Yusof** 登录。
2. 打开 Ahmad Faiz，按**为卡充值**，选 RM 10，去模拟银行按 **Pay**。家长网页会显示这笔钱**在充值机等着加**：
   已经付了，但还没到卡上。
3. 回到实验室控制台，在 **KIOSK-01** 按**刷卡**，选 Ahmad Faiz 的卡。充值机把等着的钱写进卡里
   （家长之前付的 RM 20.00 + 你刚付的 RM 10.00），屏幕显示新余额。

**关掉云端服务器**
1. 按**关掉服务器**。食堂机和饮水机照样离线卖东西；其他网页会说服务器连不上；充值机不会加钱。
2. 卖点东西，再按**打开服务器**。机器大约 10 秒内自己重新连上，把存着的记录上传。

**看账本**
点右上角的**学校后台**（School office），用 **Tan Wei Ming**（Finance，财务）登录。**Books** 里有试算表
（一定要显示 *Balanced*），**Reconciliation**（对账）列出所有对不上的地方。右上角的**平台运营后台**
（Operator console）是 SaaS 运营方看所有学校的地方；可以在那里开通第三所学校，看它出现在实验室控制台。

不小心改乱了？按实验室时钟框里的**重置演示…**，就会回到全新的示范资料。

## 第 5 步：模拟模式——一跳一跳跟着一笔消费走（像 Packet Tracer）

在 Packet Tracer 里，你可以从 *Realtime* 切换到 *Simulation*，看每个封包怎么走。实验室控制台对 OneCard 也一样。

**一步一步看一笔消费**
1. 在实验室控制台最上面，点 **模拟**（在 **实时** 旁边；英文界面是 Simulation / Realtime）。右边会打开 **模拟** 页签。
2. 在 **CANTEEN-01** 按**刷卡**，选 *Ahmad Faiz bin Rahman*，加一个 *Nasi lemak*，付款。
3. 模拟页签会把整笔消费列成一步一步：

   | # | 发生什么 |
   |---|---|
   | 1 | 你在 CANTEEN-01 刷卡 |
   | 2 | 刷卡机读卡：卡里有 RM 30.00 |
   | 3 | 检查规则：用餐时间 ✓、每日上限 ✓、余额 ✓ …… |
   | 4 | 把新余额写进卡里 |
   | 5 | 把这笔消费存进机器的日志 |
   | 6 | 用自己的密钥签名，把 `sale.recorded` 发给 MQTT broker |
   | 7 | broker 检查这台机器能不能用这个 topic，再转给平台 |
   | 8 | 平台检查：签名 ✓、不是重复 ✓、顺序对 ✓ …… |
   | 9 | 记账：学生钱包 −RM 3.50，欠食堂 +RM 3.50 |
   | 10 | broker 告诉刷卡机"收到了"（PUBACK） |

4. 用 **◀ / ▶** 一步一步看，或按 **▶ 播放**让它自己跑。拓扑图上会有一个信封，从卡移到机器，沿着网线上到云端服务器，再进账本。
5. 点任何一步，就会打开它的**封包详情**，一层一层看：卡里有什么、机器的检查、消息本身、签名、MQTT 的 topic 和送达、
   平台的检查、记了哪些账。

**半路弄坏它（实时）**
1. 在模拟页签打开 **每一跳都停（实时）**。
2. 再在 **CANTEEN-01** 刷一次卡。这笔消费会停在*机器里面*，还没发出去。信封停在那里，有一个暂停标志。
3. 现在在 CANTEEN-01 按**拔网线**，再按 **下一跳**。机器没有网络：这笔消费留在日志里（"存着，没发出去"）。
4. 按**插上网线**。看着存着的消费上传、记账，而且只记一次。
5. 试试其他停顿点：
   - 把消息从机器放出去，它会停在*平台*（已经收到并存好了）。
   - 关掉服务器再按**下一跳**：什么都不会发生，因为平台关着。
   - 再打开服务器：这条消息会被处理，而且只处理一次。
   - 在充值机，每次要找平台之前都会停一下。在中间关掉服务器，会看到充值机拒绝（"连不上平台"），而且什么都不会丢。

按 **全部放行**、关掉 **每一跳都停（实时）**，或点回 **实时**，所有在等的东西就会继续。

控制台（PuTTY / nc）也可以做一样的事：`simulation on`、`hold on`、`next`、`show held`、`show traces`、`show trace 1`。

## 第 6 步：像登录交换机一样登录机器（PuTTY）

每一台虚拟机器，还有服务器本身，都有一个文字控制台，就像交换机的 CLI。

**Windows（PuTTY）**
1. 从 <https://www.putty.org/> 安装 PuTTY（已经有的话直接用）。
2. *Session* 页：**Host Name** 填 `127.0.0.1`，**Port** 填 `2323`，**Connection type** 选 **Telnet**。
   （可选：在 *Saved Sessions* 输入 `OneCard Lab`，按 **Save** 保存。）
3. 按 **Open**。

**Mac / Linux：** 在 Terminal 输入 `nc 127.0.0.1 2323`（或 `telnet 127.0.0.1 2323`）。

然后试试（每次打一行，按 Enter，看回应）：

```text
onecard> machines                                   ← 列出所有学校的所有机器
onecard> connect smk-contoh/CANTEEN-01              ← 登录一台食堂刷卡机
smk-contoh/CANTEEN-01> show status
smk-contoh/CANTEEN-01> tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK
Screen: Paid RM 5.30 · Balance RM 24.70
smk-contoh/CANTEEN-01> cable unplug                  ← 拔网线
smk-contoh/CANTEEN-01> tap 04A13B5C7D2E80 ROTI-CANAI
Screen: Paid RM 1.50 · Balance RM 23.20
Record CANTEEN-01-000002 waits in the journal (no network).
smk-contoh/CANTEEN-01> show journal                 ← 离线那笔是 "unsent"（还没上传）
smk-contoh/CANTEEN-01> cable plug                    ← 插回网线："1 unsent record uploaded"
smk-contoh/CANTEEN-01> disconnect
onecard> connect smk-contoh/KIOSK-01
smk-contoh/KIOSK-01> tap 04A13B5C7D2E80              ← 把家长已付的 RM 20.00 加到卡上
smk-contoh/KIOSK-01> disconnect
onecard> connect server                              ← 登录虚拟云端服务器本身
server# show schools                                 ← 这台服务器上的所有学校（租户）
server# server down                                  ← 关掉整台服务器
server# server up                                    ← 再打开；机器会自己重新连上
server# exit
onecard> exit
```

- `04A13B5C7D2E80` 是 Ahmad Faiz（S1001）的卡。实验室控制台里看得到每张卡的号码。
- **同一张卡**要隔 3 秒才能再刷：跟真的刷卡机一样，3 秒内第二次刷会被拒绝（"Please wait 3 s and tap again"），
  这样一次刷卡绝不会被扣两次。
- 在任何提示符下输入 `?` 或 `help`，就会列出那里能用的命令。实验室控制台的 **Console** 页签里也有一样的控制台。

## 第 7 步：看机器的消息（MQTT Explorer）

就像 Wireshark，不过看的是机器和服务器之间的消息。

1. 从 <https://mqtt-explorer.com/> 安装 MQTT Explorer。
2. 按 **+** 新增连接：**Host** `127.0.0.1`，**Port** `1883`，**Username** `viewer`，**Password** `viewer`，
   *Encryption (tls)* 关掉。
3. 按 **Connect**。展开 `lab → v1 → smk-contoh → CANTEEN-01 → records`，再去刷一张卡：消费消息一发出就会出现。

`viewer` 这个账号只能看。每台机器都有自己的账号，只能用自己的 topic；其他的服务器一律拒绝
（[SCENARIOS.md](SCENARIOS.md) 的练习 10 会示范）。

## 第 8 步：用手机看家长网页

1. 先停掉实验室（Ctrl+C），改用 `npm run start:lan` 启动。
2. 它会印出一行，例如 `On a phone on the same Wi-Fi: http://192.168.1.20:8080/parent/`。
3. 用连着**同一个 Wi-Fi** 的手机打开这个地址。如果 Windows 问 Node.js 能不能使用网络，选允许**专用网络**。

只在你信任的网络里这样做：实验室没有密码。

## 第 9 步：练习

[SCENARIOS.md](SCENARIOS.md) 有 16 个带预期结果的练习：离线消费、挂失、充值机断电、复制卡、
开通第三所学校、整台云端服务器停机等等。

## 遇到问题？

| 你看到 | 这样做 |
|---|---|
| `node` 不是内部或外部命令 | 装好 Node.js 后关掉 PowerShell 再重新打开（或重启 Windows）。 |
| `OneCard Lab needs Node.js 22.13 or newer` | 到 nodejs.org 装最新的 LTS。 |
| `Port 1883 (the MQTT broker) is already in use`（或 8080、2323）／端口被占用 | 有别的程序在用这个端口。把它关掉，或换端口，例如 PowerShell：`$env:LAB_HTTP_PORT=8090; npm start`（Mac：`LAB_HTTP_PORT=8090 npm start`）。双击启动和桌面版会自己换一个空的端口。 |
| `OneCard Lab is already running` | 另一个窗口里已经开着实验室：用那一个就好（双击启动会直接在浏览器里打开它），或先关掉那个窗口。 |
| Mac："无法打开"、"Apple 无法验证……" | 右键 → **打开** → **打开**。macOS 15 以后：先试一次，再到 **系统设置 → 隐私与安全性** → **仍要打开**。 |
| Windows："Windows 已保护你的电脑" | **更多信息** → **仍要运行**。 |
| 启动文件说文件不全 | 你是在 ZIP 里面打开的。先把文件夹解压（Windows：右键点 ZIP → **全部解压缩**），再在解压后的文件夹里双击启动文件。 |
| PuTTY 显示 "Connection refused" | 实验室没在跑，或选了 SSH 而不是 **Telnet**，或端口不是 2323。 |
| PuTTY 每个字出现两次 | PuTTY → *Terminal*，把 *Local echo* 设为 **Auto**。 |
| MQTT Explorer 什么都没有 | 检查端口 1883 和账号 `viewer` / `viewer`；去刷一张卡制造一些消息。 |
| 手机打不开 | 用 `npm run start:lan`、连同一个 Wi-Fi，并允许 Node.js 通过 Windows 防火墙（专用网络）。有些访客 Wi-Fi 不让设备互相看到。 |
