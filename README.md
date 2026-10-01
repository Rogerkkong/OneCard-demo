# OneCard Lab

A virtual lab for a school NFC card system — **try every flow before any hardware exists.**

Students tap a card to pay in the canteen and for water; parents top up online; the school
office handles cards, top-ups, lost cards and reconciliation. In this lab, every piece of
that runs as software on your computer: virtual chip cards, canteen readers, water
machines, a top-up kiosk and an admin card talk to the platform through a **real MQTT
broker** and **real signed HTTP**, exactly as hardware would. When real machines arrive, they
speak the same messages and take the place of the virtual ones.

It is the Packet Tracer idea applied to a payment system: build the whole topology, pull
cables, break things on purpose, and watch what every message does.

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
| Lab console | http://localhost:8080/lab/ | Tap cards on machines, pull network cables, carry the admin card, inject faults, move the clock, watch the messages |
| School office | http://localhost:8080/admin/ | Students and cards, lost cards, machines, prices, top-ups, the books, reconciliation |
| Parent app | http://localhost:8080/parent/ | Phone-first web app: invitation code, balance, top-up with a mock bank |

Every restart begins from a fresh demo: two fictional schools (SMK Seri Contoh and SJK(C)
Contoh), their staff, students, parents and machines.

With Docker instead of Node: `docker compose up --build`.

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

[docs/SCENARIOS.md](docs/SCENARIOS.md) has 13 guided exercises with expected results:
online and offline canteen sales, water by the litre, parent top-ups, refunds of money
never added, lost cards and the window before offline machines know, replacement cards,
new prices, device security, kiosk power cuts, copied cards and reconciliation.

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

虚拟卡、食堂刷卡机、饮水机、充值机和参数卡，都通过**真正的 MQTT broker** 和**带签名的 HTTP**
跟平台通信，跟真机器一样。等真机器到了，它们发一样的消息，直接取代虚拟的。

就像 Packet Tracer：先把整个拓扑搭起来，拔网线、故意制造故障，看每一条消息怎么走。

**怎么跑：** 装 Node.js 22.13 以上，然后 `npm install`、`npm start`，打开：
- 实验室控制台 http://localhost:8080/lab/ ：在机器上刷卡、拔网线、带参数卡、制造故障、调时间
- 学校后台 http://localhost:8080/admin/ ：学生和卡、挂失、机器、价格、充值、账本、对账
- 家长网页 http://localhost:8080/parent/ ：邀请码绑定、看余额、用模拟银行充值

**看设备消息：** 用 MQTT Explorer 或 `mosquitto_sub`，只读账号 `viewer` / `viewer`，订阅 `lab/v1/#`。

**练习：** [docs/SCENARIOS.md](docs/SCENARIOS.md) 有 13 个带预期结果的练习，从在线、离线消费，到挂失窗口、
充值机断电、复制卡和对账。

**注意：** 实验室里的学校、人名、钱和密钥都是虚构的。这个 repo 是公开的，不要放真资料、真密钥或保密的对接文件。
