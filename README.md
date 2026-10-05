# OneCard Lab

A virtual lab for a school NFC card system — **try every flow before any hardware exists.**

Students tap a card to pay in the canteen and for water; parents top up online; the school
office handles cards, top-ups, lost cards and reconciliation. It is **SaaS**: one system
serves many schools, each one a separate tenant with its own data, cards, machines, prices
and keys.

In this lab **everything is virtual, including the server**: the cloud server (MQTT broker,
platform and database), every school's virtual chip cards, canteen readers, water machines,
top-up kiosk and admin card. They talk through a **real MQTT broker** and **real signed
HTTP**, exactly as hardware would. When real machines arrive, they speak the same messages
and take the place of the virtual ones.

It is the Packet Tracer idea applied to a payment system: build the whole topology, pull
cables, switch the server off, break things on purpose, and watch what every message does.

> Everything in this lab is fictional — schools, people, money and keys. It is an
> independent reference implementation, not a production system. Never put real data,
> real keys or confidential integration documents into this repository.

**New here?** Follow the step-by-step guide, from installing Node.js to your first card tap: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) · 中文：[docs/GETTING-STARTED.zh.md](docs/GETTING-STARTED.zh.md)

**中文简介在下面 ↓**

## Quick start

You need [Node.js](https://nodejs.org/) 22.13 or newer.

```sh
npm install
npm start
```

Then open:

| App | URL | What you do there |
|---|---|---|
| Lab console | http://localhost:8080/lab/ | The whole virtual topology: switch the cloud server off, tap cards on machines, pull network cables, carry the admin card, inject faults, move the clock, watch the messages |
| Operator console | http://localhost:8080/operator/ | The SaaS owner's view: every school (tenant), onboard a new school with its machines, suspend or reactivate one |
| School office | http://localhost:8080/admin/ | One school's staff: students and cards, lost cards, machines, prices, top-ups, the books, reconciliation |
| Parent app | http://localhost:8080/parent/ | Phone-first web app: invitation code, balance, top-up with a mock bank |

Every restart begins from a fresh demo: two fictional schools (SMK Seri Contoh and SJK(C)
Contoh) on one platform, with their staff, students, parents and machines. Onboard more
schools from the operator console.

With Docker instead of Node: `docker compose up --build`.

`npm start -- --open` also opens the lab console in your browser, and `npm start -- --help` lists every
option and setting. Rather not use Terminal? [Double-click a launcher](#start-it-without-terminal), or take
the [desktop app](#desktop-app-no-nodejs-needed), which needs no Node.js at all.

## Start it without Terminal

In the project folder, double-click the launcher for your computer:

| Computer | Double-click |
|---|---|
| Mac | `Start OneCard Lab.command` |
| Windows | `Start OneCard Lab.bat` |
| Linux | `start-onecard-lab.sh` (or run `./start-onecard-lab.sh` in a terminal) |

A window opens, and once the lab is up the lab console opens in your web browser. Keep the window
open while you use the lab: close it, or press Ctrl+C in it, to stop the lab.

What happens the first time:

- It needs [Node.js](https://nodejs.org/en/download) 22.13 or newer. If Node.js is missing or too old, the
  window says so in English and 中文 and opens the download page: install the LTS version, then
  double-click again.
- It downloads the two libraries the lab uses (needs the internet, about a minute). After an update
  (a `git pull`, or a newer download) it does this again by itself.
- **Mac**, if the folder came as a ZIP from the internet: macOS may say it cannot check the launcher.
  Right-click it → **Open** → **Open**. On macOS 15 (Sequoia) and later: double-click it once, close the
  message, then **System Settings → Privacy & Security** → **Open Anyway**. (A folder from `git clone` or
  GitHub Desktop opens straight away.) If macOS asks whether Terminal may access files in your Desktop,
  Documents or Downloads folder, click **Allow** (or **OK**).
- **Windows**: unzip the folder first (right-click the ZIP → **Extract All**); a launcher inside the ZIP
  cannot find the rest. If SmartScreen says "Windows protected your PC": **More info** → **Run anyway**.

If another program already uses port 8080, 1883 or 2323, the lab takes a free port instead and says so in
the window. If a OneCard Lab is already running, the browser opens that one.

## Desktop app (no Node.js needed)

The desktop app is one file with the whole lab and Node.js inside: nothing to install. Download it:

- **Release** (for everyone): on the GitHub page, **Releases** → the newest one → **Assets** → the ZIP for
  your computer.
- **GitHub Actions run** (the newest build, for testing; you must be signed in to GitHub):
  **Actions** → **Desktop app** → a run with a green tick → **Artifacts** at the bottom of the page.

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1, M2, M3, M4…) | `onecard-lab-mac-arm64` |
| Mac with an Intel processor | `onecard-lab-mac-x64` |
| Windows (64-bit) | `onecard-lab-win-x64.exe` |
| Linux (64-bit) | `onecard-lab-linux-x64` |

Which Mac? Apple menu → **About This Mac**: "Chip: Apple M…" is Apple silicon, "Processor: … Intel" is Intel.

Unzip it and double-click the file. A window opens (Terminal on a Mac) and the lab console opens in your
browser; close the window to stop the lab. The first start unpacks the web apps into the computer's
temporary folder. The ports and settings are the same as `npm start` (`--help` lists them).

The apps are not signed, so the first time:

- **macOS 15 (Sequoia) and later**: double-click the file once and close the message, then open
  **System Settings → Privacy & Security**, scroll down, click **Open Anyway** and confirm. Or in Terminal:
  `xattr -d com.apple.quarantine ~/Downloads/onecard-lab-mac-arm64` (your file's name and folder).
- **macOS 14 and earlier**: right-click the file → **Open** → **Open**.
- If macOS asks whether Terminal may access files in your Downloads (or Desktop, Documents) folder, click
  **Allow** (or **OK**).
- **Windows**: if SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**.
- A Mac or Linux file from an **Actions run** loses its "can run" mark in the download (Release ZIPs keep
  it). In Terminal: `chmod +x ~/Downloads/onecard-lab-mac-arm64`.

To check the app on a computer, start it in a terminal with `--self-test`: it starts the lab on free
ports, checks the web apps answer, stops, and says whether it passed. To build it yourself for your own
computer: `npm install`, then `npm run build:app` (the file lands in `dist/`).

## What you need on your computer

| Tool | What it is for | Needed? |
|---|---|---|
| [Node.js](https://nodejs.org/) 22 LTS, **or** [Docker Desktop](https://www.docker.com/products/docker-desktop/), **or** the [desktop app](#desktop-app-no-nodejs-needed) | Runs the whole lab: the virtual cloud server, the broker and every virtual machine | Yes, one of the three |
| A web browser (Chrome, Edge, Safari) | Lab console, operator console, school office, parent app | Yes |
| Git, or *Code → Download ZIP* on GitHub | Getting the code | Yes |
| [PuTTY](https://www.putty.org/) (Windows) or Terminal (Mac/Linux) | Logging in to a machine's or the server's console, like a switch | Optional |
| [MQTT Explorer](https://mqtt-explorer.com/) | Watching every device message live, like Wireshark | Optional |

Nothing else: no real cards, readers, kiosk or cloud account.

## Operating the virtual hardware

**In the browser (lab console, `/lab/`).** Each school's machines are drawn as a topology
under the cloud server. Pick a card from the tray and tap it on a machine; choose food at a
canteen reader or a volume at a water machine; unplug or plug a machine's network cable;
load the admin card at the kiosk and tap it on offline machines; switch the server off. Each
machine shows its own screen, just like the real one would.

**Build it like Packet Tracer.** The **Add to the lab** bar under the lab console's header holds a canteen
reader, a water machine, a top-up kiosk and a school. Drag a machine onto a school, or a school onto the
internet line, fill in the small window and press **Add machine** or **Add school**. The platform registers it as it would a real one,
and it arrives with its cable unplugged. Then draw the cable: drag the machine's cable end onto the school
network line. Every drag has a button too (**Add machine** on each school, **Add school** in the bar), and the
text console has `add machine <school> canteen|water|kiosk` and `add school <code> <name>`.

**Like PuTTY into a switch.** Every machine and the server has a text console on port 2323:

1. PuTTY → *Host Name* `127.0.0.1`, *Port* `2323`, *Connection type* **Telnet** → *Open*
   (Mac/Linux: `telnet 127.0.0.1 2323`, or `nc 127.0.0.1 2323`).
2. Type `machines` to list them, then for example:

```text
onecard> connect smk-contoh/CANTEEN-01
smk-contoh/CANTEEN-01> show status
smk-contoh/CANTEEN-01> tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK
smk-contoh/CANTEEN-01> cable unplug
smk-contoh/CANTEEN-01> show journal
smk-contoh/CANTEEN-01> disconnect
onecard> connect server
server# show schools
server# server down
```

The same console is also in the lab console's **Console** tab.

**Watch the messages like Wireshark.** MQTT Explorer → host `127.0.0.1`, port `1883`,
username `viewer`, password `viewer` → *Connect*. The topic tree shows `lab/v1/<school>/<machine>/…`
and every message as it happens.

**On your phone.** The parent app is made for phone browsers. If the lab runs on your laptop,
start it with `npm run start:lan` instead of `npm start`; it prints the address to open
(`http://<laptop-IP>:8080/parent/`) on a phone on the same Wi-Fi. Windows may ask whether
Node.js may use the network: allow *Private networks*. The lab has no passwords, so only do
this on a network you trust.

**PuTTY and the real server.** When the real system goes onto a cloud server, PuTTY (SSH) is
how you log in to that server. In the lab the server is virtual, so you use its console above.

## Simulation mode (like Packet Tracer)

Click **Simulation** at the top of the lab console. The **Simulation** tab shows each flow as a list of steps, like
Packet Tracer's event list:

1. the card is read
2. every rule is checked
3. the message is signed and sent over MQTT
4. the broker checks the machine's topic
5. the platform checks the signature, duplicates and order
6. the money is booked

Step through it with ◀ ▶ and watch the envelope travel on the topology. Click any step for its packet details, layer
by layer.

Turn on **Hold at each hop (live)** and a flow really waits: inside the machine, before each kiosk call, and in the
platform's inbox. Each **Next hop** moves it on. Pull a cable or switch the server off in between and watch what
the system does about it. In the consoles, use `simulation on`, `hold on`, `next` and `show trace 1`.

## Watch the device messages

The broker listens on port 1883 with a read-only login (`viewer` / `viewer`; the terminal
that started the lab prints the exact details). Use MQTT Explorer, or:

```sh
mosquitto_sub -h 127.0.0.1 -p 1883 -u viewer -P viewer -t 'lab/v1/#' -v
```

Topics look like `lab/v1/<school>/<machine>/records`, `…/status` and
`…/commands/<kind>`. Each machine has its own login and can only use its own topics; the
broker refuses everything else.

## Exercises

[docs/SCENARIOS.md](docs/SCENARIOS.md) has 17 guided exercises with expected results:
online and offline canteen sales, water by the litre, parent top-ups, refunds of money
never added, lost cards and the window before offline machines know, replacement cards,
new prices, device security, kiosk power cuts, copied cards, reconciliation, onboarding
more schools (SaaS tenants), switching the whole cloud server off, Simulation mode, and
building a school by drag and drop.

## What is simulated, and what is not

| Simulated here | Needs real hardware |
|---|---|
| Card balance on the card, card counters and the card's security code | The real chip cryptography of the card type you choose |
| Readers, water machines and the kiosk: rules, journals, retries, network loss | Firmware timing, atomic writes on a real chip, flow-meter pulses |
| MQTT broker accounts, per-machine topics, retained settings, TLS (optional) | The school's real Wi-Fi or 4G coverage |
| Platform: double-entry books, top-ups, refunds, lost cards, reconciliation | A real payment provider (the lab has a mock bank) |

## Safety notes

The lab is for your own computer or a network you trust. It has **no passwords**: the sign-in
pages list every demo person, and the lab console can switch anything off or reset everything.

- By default it listens on `127.0.0.1` only. `npm run start:lan` opens it to your network.
- It answers only to `localhost` and IP addresses, so a website you visit cannot point its own
  name at your computer and drive the lab (DNS rebinding). Use `LAB_ALLOWED_HOSTS` for other names.
- Never put it on the public internet, and never put real names, cards, money or keys into it.

## Optional: TLS like a real device

```sh
scripts/make-lab-certs.sh            # add names/IPs devices will use, e.g. 192.168.1.20
LAB_MQTT_TLS_CERT=lab-certs/server.crt LAB_MQTT_TLS_KEY=lab-certs/server.key npm start
```

On Windows, run the script in Git Bash (it comes with [Git for Windows](https://git-scm.com/)
and includes OpenSSL), then start the lab from PowerShell:

```powershell
$env:LAB_MQTT_TLS_CERT="lab-certs/server.crt"; $env:LAB_MQTT_TLS_KEY="lab-certs/server.key"; npm start
```

The script makes a throwaway CA and a broker certificate. Devices trust the CA and check
that the broker's name is in the certificate — the same checks a real terminal must make.

## Settings

| Variable | Default | |
|---|---|---|
| `LAB_HTTP_PORT` | 8080 | web apps and APIs |
| `LAB_MQTT_PORT` | 1883 | MQTT broker |
| `LAB_CONSOLE_PORT` | 2323 | machine and server consoles for PuTTY / telnet (`0` turns them off) |
| `LAB_ALLOWED_HOSTS` | — | host names the web apps answer to besides `localhost` and IP addresses, comma-separated (e.g. `mylaptop.local`); `*` turns the check off (only behind a forwarding service you control) |
| `LAB_HOST` | 127.0.0.1 | listen address; anything else exposes the lab (which has no passwords) to your network (`npm run start:lan` = `0.0.0.0`) |
| `LAB_MQTT_TLS_CERT`, `LAB_MQTT_TLS_KEY`, `LAB_MQTT_TLS_PORT` | — , — , 8883 | optional TLS listener |

Options (after `npm start --`, or after the desktop app's name): `--open` opens the lab console in your
browser (the launchers and the desktop app do this; `--no-open` turns it off), `--lan` is what
`npm run start:lan` does, `--self-test` starts on free ports, checks the web apps and stops (exit code 0
when it works), `--help` lists everything.

## How it is built

One Node.js process, two dependencies (`aedes` for the broker, `mqtt` for clients), and
Node's built-in SQLite. The platform is a set of small modules — schools, devices, prices
and block lists, double-entry ledger, top-ups, settlement, reconciliation and the MQTT
intake — behind one facade. [docs/DESIGN.md](docs/DESIGN.md) is the full design: the money
model, the device protocol, every module's contract and the HTTP API.

```sh
npm test            # unit tests and end-to-end scenarios
npm run build:app   # the single-file desktop app for this computer, in dist/
```

---

## 中文简介

OneCard Lab 是一个**虚拟测试环境**：在任何硬件到货之前，就能把整套校园一卡通跑起来试。

**第一次用？** 按照 [上手指南](docs/GETTING-STARTED.zh.md) 一步一步来：从安装 Node.js 到刷第一张卡。

这是 **SaaS**：一个系统服务很多学校，每所学校是一个独立的租户（tenant），资料、卡、机器、价格和密钥都分开。

实验室里**全部都是虚拟的，包括服务器**：云端服务器（MQTT broker、平台、数据库），还有每所学校的虚拟卡、
食堂刷卡机、饮水机、充值机和参数卡。它们通过**真正的 MQTT broker** 和**带签名的 HTTP** 通信，跟真机器一样。
等真机器到了，它们发一样的消息，直接取代虚拟的。

就像 Packet Tracer：先把整个拓扑搭起来，拔网线、故意制造故障，看每一条消息怎么走。

**怎么跑：** 装 Node.js 22.13 以上，然后 `npm install`、`npm start`，打开：
- 实验室控制台 http://localhost:8080/lab/ ：整个虚拟拓扑；关掉云端服务器、在机器上刷卡、拔网线、带参数卡、制造故障、调时间
- 平台运营后台 http://localhost:8080/operator/ ：SaaS 运营方看所有学校、开通新学校（连机器一起）、停用或恢复学校
- 学校后台 http://localhost:8080/admin/ ：单一学校的职员：学生和卡、挂失、机器、价格、充值、账本、对账
- 家长网页 http://localhost:8080/parent/ ：邀请码绑定、看余额、用模拟银行充值

**不用 Terminal 启动：** 在项目文件夹里双击你电脑的启动文件：Mac 用 `Start OneCard Lab.command`，Windows 用
`Start OneCard Lab.bat`（Linux：`start-onecard-lab.sh`，或在终端输入 `./start-onecard-lab.sh`）。会打开一个窗口，实验室起来后，
浏览器会自动打开实验室控制台。用实验室的时候不要关这个窗口；关掉它，或在里面按 Ctrl+C，就会停止实验室。第一次：
- 要有 Node.js 22.13 或更新的版本。没有或太旧的话，窗口会用英文和中文说明，并打开 Node.js 下载页：装好 LTS 版本后再双击一次。
- 它会下载实验室用的两个库（需要网络，大约一分钟）。以后更新了（`git pull` 或下载了新版本），它会自己再装一次。
- **Mac**：如果文件夹是从网上下载的 ZIP，macOS 可能说无法检查这个启动文件。右键点它 → **打开** → **打开**。macOS 15（Sequoia）
  以后：先双击一次、关掉提示，再到 **系统设置 → 隐私与安全性** → **仍要打开**。（用 `git clone` 或 GitHub Desktop 拿到的文件夹不会这样。）
  如果 macOS 问 Terminal 能不能访问"桌面""文稿"或"下载"文件夹里的文件，按 **允许**（或 **好**）。
- **Windows**：先把 ZIP 解压（右键点 ZIP → **全部解压缩**），在 ZIP 里面直接双击会找不到其他文件。如果 SmartScreen 显示
  "Windows 已保护你的电脑"：按 **更多信息** → **仍要运行**。

如果 8080、1883 或 2323 端口已经被别的程序占用，实验室会自己换一个空的端口，并在窗口里说明。如果已经有一个 OneCard Lab 在跑，
浏览器会直接打开那一个。

**桌面版（不用装 Node.js）：** 一个文件就包含整个实验室和 Node.js，什么都不用装。下载：
- **Release**（给所有人用）：在 GitHub 页面按 **Releases** → 最新的版本 → **Assets** → 选你电脑的 ZIP。
- **GitHub Actions 运行**（最新的测试版，要先登录 GitHub）：**Actions** → **Desktop app** → 一次打绿勾的运行 → 页面最下面的 **Artifacts**。

哪个文件：Apple 芯片的 Mac（M1、M2、M3、M4……）用 `onecard-lab-mac-arm64`，Intel 处理器的 Mac 用 `onecard-lab-mac-x64`，
Windows（64 位）用 `onecard-lab-win-x64.exe`，Linux（64 位）用 `onecard-lab-linux-x64`。不知道是哪种 Mac？苹果菜单 → **关于本机**：
写"芯片：Apple M……"的是 Apple 芯片，写"处理器：……Intel"的是 Intel。

解压后双击这个文件：会打开一个窗口（Mac 上是 Terminal），浏览器会打开实验室控制台；关掉窗口就停止实验室。第一次启动会把网页文件
解压到电脑的暂存文件夹。端口和设置跟 `npm start` 一样（`--help` 会全部列出）。这些文件没有签名，所以第一次：
- **macOS 15（Sequoia）以后**：先双击一次、关掉提示，再打开 **系统设置 → 隐私与安全性**，往下拉，按 **仍要打开** 并确认。
  或在 Terminal 输入 `xattr -d com.apple.quarantine ~/Downloads/onecard-lab-mac-arm64`（换成你的文件名和文件夹）。
- **macOS 14 以前**：右键点这个文件 → **打开** → **打开**。
- 如果 macOS 问 Terminal 能不能访问"下载"（或"桌面""文稿"）文件夹里的文件，按 **允许**（或 **好**）。
- **Windows**：如果 SmartScreen 显示"Windows 已保护你的电脑"，按 **更多信息** → **仍要运行**。
- 从 **Actions 运行** 下载的 Mac 和 Linux 文件会丢掉"可以运行"的标记（Release 的 ZIP 不会）。在 Terminal 输入
  `chmod +x ~/Downloads/onecard-lab-mac-arm64`。

想检查桌面版在一台电脑上能不能用：在终端用 `--self-test` 启动它，它会在空的端口上启动实验室、检查网页能打开、再停止，并说明结果。
自己打包：`npm install`，再 `npm run build:app`（文件在 `dist/` 里）。

**电脑上要装什么：**
- Node.js 22 LTS，或者 Docker Desktop，或者桌面版（三选一）：跑整个实验室，包括虚拟云端服务器、broker 和所有虚拟机器
- 浏览器（Chrome、Edge、Safari 都可以）
- Git，或在 GitHub 上按 *Code → Download ZIP* 下载代码
- （可选）PuTTY（Windows）或 Mac 的 Terminal：像登录交换机一样登录机器或服务器的控制台
- （可选）MQTT Explorer：像 Wireshark 一样实时看每一条设备消息

不需要真的卡、刷卡机、充值机或云端账号。

**怎么操作虚拟硬件：**
- **浏览器（实验室控制台 `/lab/`）：** 每所学校的机器画成拓扑图，挂在云端服务器下面。从卡盒拿一张卡，在机器上刷；
  食堂机选食物、饮水机选水量；拔插机器的网线；在充值机装参数卡，再到离线机器上刷；也可以关掉服务器。
  每台机器都有自己的屏幕，跟真机器一样。
- **像 Packet Tracer 一样搭建：** 实验室控制台标题下面的 **加到实验室** 栏里有食堂刷卡机、饮水机、充值机和学校。
  把机器拖到一所学校上，或把学校拖到互联网线上，填好小窗口再按 **加机器** 或 **加学校**。平台会像登记真机器一样登记它，装好时网线是拔掉的；
  再把机器的网线头拖到学校网络线上，就插上了。每个拖放都有按钮可以代替（每所学校的 **加机器**、栏里的 **加学校**），
  文字控制台也有 `add machine <学校> canteen|water|kiosk` 和 `add school <代码> <名称>`。
- **像用 PuTTY 登录交换机：** PuTTY → Host Name `127.0.0.1`，Port `2323`，Connection type 选 **Telnet** → Open
  （Mac：`telnet 127.0.0.1 2323`）。输入 `machines` 看所有机器，`connect smk-contoh/CANTEEN-01` 连到一台，
  `show status`、`tap <卡号> NASI-LEMAK`、`cable unplug`、`show journal`；`connect server` 再 `server down` 就是关服务器。
  控制台的 **Console** 页签里也有一样的东西。
- **像 Wireshark 一样看消息：** MQTT Explorer → host `127.0.0.1`，port `1883`，用户名 `viewer`，密码 `viewer`。
- **用手机看家长网页：** 实验室在你电脑上跑时，改用 `npm run start:lan` 启动，它会印出手机要打开的地址
  （`http://<电脑IP>:8080/parent/`），手机连同一个 Wi-Fi 打开就行。Windows 问 Node.js 能不能用网络时，选允许
  *专用网络*。实验室没有密码，只在信任的网络里这样做。
- **PuTTY 和真服务器：** 等真系统上了云端服务器，PuTTY（SSH）是用来登录那台服务器的；实验室里服务器是虚拟的，用上面的控制台就行。

**模拟模式（像 Packet Tracer）：** 在实验室控制台最上面点 **模拟**，**模拟** 页签会把每一个流程列成一步一步：读卡、检查每条规则、
签名后用 MQTT 发出、broker 检查机器的 topic、平台检查签名、重复和顺序、记账。用 ◀ ▶ 一步一步看，信封会在拓扑图上移动；
点任何一步就能一层一层看封包详情。打开 **每一跳都停（实时）**，流程会真的停在机器里、每次找平台之前、和平台的收件箱，
每按一次 **下一跳** 才往前走一步。可以在中间拔网线或关掉服务器，看系统怎么处理。控制台里也有 `simulation on`、`hold on`、`next`、`show trace 1`。

**看设备消息：** 用 MQTT Explorer 或 `mosquitto_sub`，只读账号 `viewer` / `viewer`，订阅 `lab/v1/#`。

**练习：** [docs/SCENARIOS.md](docs/SCENARIOS.md) 有 17 个带预期结果的练习，从在线、离线消费，到挂失窗口、
充值机断电、复制卡、对账、新增学校（多租户）、整台云端服务器停机，还有用拖放建一所学校。

**安全须知：** 实验室只适合在你自己的电脑或信任的网络里用：它**没有密码**，登录页会列出所有示范人物，实验室控制台可以关掉任何东西或整个重置。默认只听 `127.0.0.1`；`npm run start:lan` 才开放给局域网。它只回应 `localhost` 和 IP 地址，所以你浏览的网站没法把自己的域名指到你的电脑来操控实验室（DNS rebinding）；要用别的名字就设 `LAB_ALLOWED_HOSTS`。不要放到公网上。

**注意：** 实验室里的学校、人名、钱和密钥都是虚构的。这个 repo 是公开的，不要放真资料、真密钥或保密的对接文件。
