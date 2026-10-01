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

## What you need on your computer

| Tool | What it is for | Needed? |
|---|---|---|
| [Node.js](https://nodejs.org/) 22 LTS, **or** [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Runs the whole lab: the virtual cloud server, the broker and every virtual machine | Yes, one of the two |
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
start it with `LAB_HOST=0.0.0.0 npm start` and open `http://<laptop-IP>:8080/parent/` on a
phone on the same Wi-Fi. The lab has no passwords, so only do this on a network you trust.

**PuTTY and the real server.** When the real system goes onto a cloud server, PuTTY (SSH) is
how you log in to that server. In the lab the server is virtual, so you use its console above.

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

[docs/SCENARIOS.md](docs/SCENARIOS.md) has 15 guided exercises with expected results:
online and offline canteen sales, water by the litre, parent top-ups, refunds of money
never added, lost cards and the window before offline machines know, replacement cards,
new prices, device security, kiosk power cuts, copied cards, reconciliation, onboarding
more schools (SaaS tenants) and switching the whole cloud server off.

## What is simulated, and what is not

| Simulated here | Needs real hardware |
|---|---|
| Card balance on the card, card counters and the card's security code | The real chip cryptography of the card type you choose |
| Readers, water machines and the kiosk: rules, journals, retries, network loss | Firmware timing, atomic writes on a real chip, flow-meter pulses |
| MQTT broker accounts, per-machine topics, retained settings, TLS (optional) | The school's real Wi-Fi or 4G coverage |
| Platform: double-entry books, top-ups, refunds, lost cards, reconciliation | A real payment provider (the lab has a mock bank) |

## Optional: TLS like a real device

```sh
scripts/make-lab-certs.sh            # add names/IPs devices will use, e.g. 192.168.1.20
LAB_MQTT_TLS_CERT=lab-certs/server.crt LAB_MQTT_TLS_KEY=lab-certs/server.key npm start
```

The script makes a throwaway CA and a broker certificate. Devices trust the CA and check
that the broker's name is in the certificate — the same checks a real terminal must make.

## Settings

| Variable | Default | |
|---|---|---|
| `LAB_HTTP_PORT` | 8080 | web apps and APIs |
| `LAB_MQTT_PORT` | 1883 | MQTT broker |
| `LAB_CONSOLE_PORT` | 2323 | machine and server consoles for PuTTY / telnet (`0` turns them off) |
| `LAB_HOST` | 127.0.0.1 | listen address; anything else exposes the lab (which has no passwords) to your network |
| `LAB_MQTT_TLS_CERT`, `LAB_MQTT_TLS_KEY`, `LAB_MQTT_TLS_PORT` | — , — , 8883 | optional TLS listener |

## How it is built

One Node.js process, two dependencies (`aedes` for the broker, `mqtt` for clients), and
Node's built-in SQLite. The platform is a set of small modules — schools, devices, prices
and block lists, double-entry ledger, top-ups, settlement, reconciliation and the MQTT
intake — behind one facade. [docs/DESIGN.md](docs/DESIGN.md) is the full design: the money
model, the device protocol, every module's contract and the HTTP API.

```sh
npm test            # unit tests and end-to-end scenarios
```

---

## 中文简介

OneCard Lab 是一个**虚拟测试环境**：在任何硬件到货之前，就能把整套校园一卡通跑起来试。

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

**电脑上要装什么：**
- Node.js 22 LTS，或者 Docker Desktop（二选一）：跑整个实验室，包括虚拟云端服务器、broker 和所有虚拟机器
- 浏览器（Chrome、Edge、Safari 都可以）
- Git，或在 GitHub 上按 *Code → Download ZIP* 下载代码
- （可选）PuTTY（Windows）或 Mac 的 Terminal：像登录交换机一样登录机器或服务器的控制台
- （可选）MQTT Explorer：像 Wireshark 一样实时看每一条设备消息

不需要真的卡、刷卡机、充值机或云端账号。

**怎么操作虚拟硬件：**
- **浏览器（实验室控制台 `/lab/`）：** 每所学校的机器画成拓扑图，挂在云端服务器下面。从卡盒拿一张卡，在机器上刷；
  食堂机选食物、饮水机选水量；拔插机器的网线；在充值机装参数卡，再到离线机器上刷；也可以关掉服务器。
  每台机器都有自己的屏幕，跟真机器一样。
- **像用 PuTTY 登录交换机：** PuTTY → Host Name `127.0.0.1`，Port `2323`，Connection type 选 **Telnet** → Open
  （Mac：`telnet 127.0.0.1 2323`）。输入 `machines` 看所有机器，`connect smk-contoh/CANTEEN-01` 连到一台，
  `show status`、`tap <卡号> NASI-LEMAK`、`cable unplug`、`show journal`；`connect server` 再 `server down` 就是关服务器。
  控制台的 **Console** 页签里也有一样的东西。
- **像 Wireshark 一样看消息：** MQTT Explorer → host `127.0.0.1`，port `1883`，用户名 `viewer`，密码 `viewer`。
- **用手机看家长网页：** 实验室在你电脑上跑时，用 `LAB_HOST=0.0.0.0 npm start` 启动，手机连同一个 Wi-Fi，
  打开 `http://<电脑IP>:8080/parent/`。实验室没有密码，只在信任的网络里这样做。
- **PuTTY 和真服务器：** 等真系统上了云端服务器，PuTTY（SSH）是用来登录那台服务器的；实验室里服务器是虚拟的，用上面的控制台就行。

**看设备消息：** 用 MQTT Explorer 或 `mosquitto_sub`，只读账号 `viewer` / `viewer`，订阅 `lab/v1/#`。

**练习：** [docs/SCENARIOS.md](docs/SCENARIOS.md) 有 15 个带预期结果的练习，从在线、离线消费，到挂失窗口、
充值机断电、复制卡、对账、新增学校（多租户）和整台云端服务器停机。

**注意：** 实验室里的学校、人名、钱和密钥都是虚构的。这个 repo 是公开的，不要放真资料、真密钥或保密的对接文件。
