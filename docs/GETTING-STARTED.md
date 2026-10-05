# Getting started with OneCard Lab

From nothing to your first card tap in about 15 minutes. No hardware, no cloud account:
the server, the machines and the cards all run on your own computer.

[中文版 → GETTING-STARTED.zh.md](GETTING-STARTED.zh.md)

## What you will have

One virtual **OneCard platform** (the "cloud server": MQTT broker, platform and database)
serving two fictional schools, each a separate tenant:

| School | Machines | Cards |
|---|---|---|
| SMK Seri Contoh (`smk-contoh`) | CANTEEN-01, CANTEEN-02 (network cable unplugged), WATER-01 (unplugged), KIOSK-01 | 6 students, 1 teacher |
| SJK(C) Contoh (`sjkc-contoh`) | CANTEEN-01, WATER-01, KIOSK-01 | 4 pupils |

Plus 6 parents (one of them has a child in each school) and some money already on the
cards, put there the real way: parent pays, student taps at the kiosk.

## Step 1 — Install Node.js (one time)

**Windows**
1. Go to <https://nodejs.org/> and download the **LTS** version (Windows Installer, `.msi`).
2. Run it and keep the defaults (Next, Next, Install).
3. Open **PowerShell** (Start menu → type `powershell` → Enter) and check:
   ```powershell
   node -v
   ```
   You should see `v22.13.0` or newer (for example `v24.x`).

**Mac**
1. Download the **LTS** installer (`.pkg`) from <https://nodejs.org/> and run it.
2. Open **Terminal** (⌘ Space → `terminal`) and check `node -v`.

## Step 2 — Get the code

- **Easiest:** on the GitHub page of this repository click **Code → Download ZIP**, then unzip
  it, for example to `C:\OneCard-demo` (Windows) or your Desktop (Mac).
- **With Git:** `git clone https://github.com/Rogerkkong/OneCard-demo.git`

## Step 3 — Start the lab

1. Open a terminal **in the project folder**:
   - Windows: open the folder in File Explorer, click the address bar, type `powershell`, press Enter.
   - Mac: in Terminal type `cd ` (with a space), drag the folder into the window, press Enter.
2. The first time only, download the two libraries the lab uses:
   ```sh
   npm install
   ```
3. Start it:
   ```sh
   npm start
   ```
4. You should see:
   ```text
   OneCard Lab is running (lab data only — nothing here is real).

     Lab console     http://127.0.0.1:8080/lab/
     Operator        http://127.0.0.1:8080/operator/
     School office   http://127.0.0.1:8080/admin/
     Parent app      http://127.0.0.1:8080/parent/
     ...
   ```

Keep this window open: it **is** the server. **Ctrl+C** stops it. Every start begins again
from the same fresh demo, so you cannot break anything for good.

## Step 4 — Your first tap (browser)

Open **<http://localhost:8080/lab/>**: the lab console, your view of the whole virtual system.

- At the top, the **Virtual cloud server** (MQTT broker · Platform · Database), with
  **Switch server off** and **Restart broker**.
- Below it, one panel per school. One server serving many schools is the SaaS idea.
- In each school panel, the machines: canteen readers, the water machine and the top-up kiosk.
  Each has its own little **screen**, its cable, and the versions of prices and block list it holds.
- On the right, the **Messages** tab (every message, live) and the **Console** tab.

**Buy something**
1. In **SMK Seri Contoh**, on **CANTEEN-01**, press **Tap card**.
2. Choose the card *Ahmad Faiz bin Rahman · 04A13B5C7D2E80 · RM 30.00*.
3. Press **+** next to *Nasi lemak* and *Teh tarik*, then **Tap card · pay RM 5.30**.
4. The machine's screen shows **Paid RM 5.30 · Balance RM 24.70**. In **Messages** you can follow
   the sale step by step: the reader sends `sale.recorded` over MQTT, the platform accepts it, books
   it in the ledger, and the card's new balance is written.

**Pull the network cable**
1. On **CANTEEN-01** press **Pull cable**. Its status turns to *No network*.
2. Wait 3 seconds (the same card cannot pay twice within 3 s), then **Tap card** again and buy a
   Roti canai. The sale still works: the card is the wallet. The record waits in the journal
   (*1 unsent*).
3. Press **Plug cable in**. The machine reconnects and uploads what it kept (`journal.batch`).

**Top up like a parent**
1. Click **Parent app** at the top right and sign in as **Rahman bin Yusof**.
2. Open Ahmad Faiz, **Top up the card**, choose RM 10, continue to the mock bank and press **Pay**.
   The app shows the money **waiting at the kiosk**: it is paid, but not on the card yet.
3. Back in the lab console, on **KIOSK-01** press **Tap card** with Ahmad Faiz's card. The kiosk
   writes the waiting money onto the card (RM 20.00 his parent paid earlier + your RM 10.00) and
   its screen shows the new balance.

**Switch the cloud server off**
1. Press **Switch server off**. Canteen readers and water machines keep selling offline. The other
   web apps say the server is unreachable, and the kiosk adds nothing.
2. Sell something, then press **Switch server on**. The machines reconnect by themselves within
   about 10 seconds and upload what they kept.

**Look at the books**
Click **School office** at the top right and sign in as **Tan Wei Ming** (Finance). **Books**
shows the trial balance (it must say *Balanced*), and **Reconciliation** lists anything that does
not add up. The **Operator console** (top right) is the SaaS owner's view of every school; you can
onboard a third school there and watch it appear in the lab console.

Changed something you did not mean to? **Reset the demo…** (in the lab clock box) starts again from
the fresh demo.

## Step 5 — Simulation mode: follow one sale hop by hop (like Packet Tracer)

In Packet Tracer you switch from *Realtime* to *Simulation* and watch each packet move. The lab console does the
same for OneCard.

**Watch a sale, step by step**
1. At the top of the lab console, click **Simulation** (next to **Realtime**). The **Simulation** tab opens on the right.
2. On **CANTEEN-01**, press **Tap card**, choose *Ahmad Faiz bin Rahman*, add *Nasi lemak*, and pay.
3. The Simulation tab now shows the whole sale as a list of steps, one per row:

   | # | What happens |
   |---|---|
   | 1 | You tap the card on CANTEEN-01 |
   | 2 | The reader reads the card: RM 30.00 on the chip |
   | 3 | It checks the rules: meal time ✓, daily limit ✓, balance ✓ … |
   | 4 | It writes the new balance onto the card |
   | 5 | It saves the sale in its journal |
   | 6 | It sends `sale.recorded` to the MQTT broker, signed with its own key |
   | 7 | The broker checks this machine may use this topic, and passes it on |
   | 8 | The platform checks it: signature ✓, not a repeat ✓, in order ✓ … |
   | 9 | The money is booked: student wallet −RM 3.50, owed to the canteen +RM 3.50 |
   | 10 | The broker confirms delivery to the reader (PUBACK) |

4. Use **◀ / ▶** to step through it, or **▶ Play** to watch it run. The envelope moves on the topology from the card
   to the machine, up the cable to the cloud server, and into the books.
5. Click any step to open its **packet details**, layer by layer: what was on the card, the machine's checks, the
   message itself, its signature, the MQTT topic and delivery, the platform's checks, and the money entries.

**Break it half-way (live)**
1. In the Simulation tab, turn on **Hold at each hop (live)**.
2. Tap a card on **CANTEEN-01** again. The sale stops *inside the machine*, before it is sent. The envelope waits
   there with a pause sign.
3. Now press **Pull cable** on CANTEEN-01, then **Next hop**. The machine has no network: the sale stays in its
   journal ("kept, not sent").
4. Press **Plug cable in**. Watch the stored sale upload and get booked, exactly once.
5. Try the other hold points:
   - Release the message from the machine. It then waits *at the platform*, already received and stored.
   - Switch the server off and press **Next hop**: nothing happens, because the platform is down.
   - Switch the server back on: the message is processed, once.
   - At the kiosk, the top-up waits before each call to the platform. Switch the server off in between and see the
     kiosk refuse ("Cannot reach the platform") without losing anything.

Press **Release all**, turn **Hold at each hop (live)** off, or click **Realtime** to let everything waiting continue.

The console does the same with `simulation on`, `hold on`, `next`, `show held`, `show traces` and `show trace 1`.

## Step 6 — Log in to a machine like a switch (PuTTY)

Every virtual machine, and the server itself, has a text console — just like a switch's CLI.

**Windows (PuTTY)**
1. Install PuTTY from <https://www.putty.org/> (or use the one you already have).
2. *Session*: **Host Name** `127.0.0.1`, **Port** `2323`, **Connection type** **Telnet**.
   (Optional: type `OneCard Lab` under *Saved Sessions* and click **Save**.)
3. Click **Open**.

**Mac / Linux:** in Terminal type `nc 127.0.0.1 2323` (or `telnet 127.0.0.1 2323`).

Then try this (type one line, press Enter, read the answer):

```text
onecard> machines                                   ← every machine of every school
onecard> connect smk-contoh/CANTEEN-01              ← log in to one canteen reader
smk-contoh/CANTEEN-01> show status
smk-contoh/CANTEEN-01> tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK
Screen: Paid RM 5.30 · Balance RM 24.70
smk-contoh/CANTEEN-01> cable unplug                  ← pull the network cable
smk-contoh/CANTEEN-01> tap 04A13B5C7D2E80 ROTI-CANAI
Screen: Paid RM 1.50 · Balance RM 23.20
Record CANTEEN-01-000002 waits in the journal (no network).
smk-contoh/CANTEEN-01> show journal                 ← the offline sale is "unsent"
smk-contoh/CANTEEN-01> cable plug                    ← plug it back: "1 unsent record uploaded"
smk-contoh/CANTEEN-01> disconnect
onecard> connect smk-contoh/KIOSK-01
smk-contoh/KIOSK-01> tap 04A13B5C7D2E80              ← adds the RM 20.00 his parent paid
smk-contoh/KIOSK-01> disconnect
onecard> connect server                              ← the virtual cloud server itself
server# show schools                                 ← every school (tenant) on this server
server# server down                                  ← switch the whole server off
server# server up                                    ← and on again; machines reconnect
server# exit
onecard> exit
```

- `04A13B5C7D2E80` is the card of Ahmad Faiz (S1001). `machines` and the lab console show every card's number.
- Wait 3 seconds before tapping **the same card** again: like a real reader, the machine refuses a
  second tap within 3 s ("Please wait 3 s and tap again"), so one tap is never charged twice.
- Type `?` or `help` at any prompt to see what works there. The lab console's **Console** tab has
  the same console in the browser.

## Step 7 — Watch the machine messages (MQTT Explorer)

Like Wireshark, but for the messages between the machines and the server.

1. Install MQTT Explorer from <https://mqtt-explorer.com/>.
2. Click **+** to add a connection: **Host** `127.0.0.1`, **Port** `1883`, **Username** `viewer`,
   **Password** `viewer`, *Encryption (tls)* off.
3. Click **Connect**. Open the tree `lab → v1 → smk-contoh → CANTEEN-01 → records` and tap a card:
   the sale message appears the moment it is sent.

The `viewer` login can only watch. The machines each have their own login and may only use their
own topics; the server refuses everything else (exercise 10 in [SCENARIOS.md](SCENARIOS.md) shows it).

## Step 8 — The parent app on your phone

1. Stop the lab (Ctrl+C) and start it with `npm run start:lan` instead.
2. It prints a line like `On a phone on the same Wi-Fi: http://192.168.1.20:8080/parent/`.
3. Open that address on a phone connected to the **same Wi-Fi**. If Windows asks whether Node.js
   may use the network, allow **Private networks**.

Only do this on a network you trust: the lab has no passwords.

## Step 9 — The exercises

[SCENARIOS.md](SCENARIOS.md) has 16 guided exercises with the expected result for each: offline
sales, lost cards, kiosk power cuts, copied cards, onboarding a third school, switching the whole
cloud server off, and more.

## Trouble?

| You see | Do this |
|---|---|
| `node` is not recognized | Close and reopen PowerShell after installing Node.js (or restart Windows). |
| `OneCard Lab needs Node.js 22.13 or newer` | Install the current LTS from nodejs.org. |
| `EADDRINUSE` / port already in use | Another program uses 8080, 1883 or 2323. Stop it, or pick other ports, e.g. PowerShell: `$env:LAB_HTTP_PORT=8090; npm start` (Mac: `LAB_HTTP_PORT=8090 npm start`). |
| PuTTY: "Connection refused" | The lab is not running, or you chose SSH instead of **Telnet**, or the port is not 2323. |
| PuTTY shows every letter twice | In PuTTY → *Terminal*, set *Local echo* to **Auto**. |
| MQTT Explorer shows nothing | Check port 1883 and the `viewer` / `viewer` login; tap a card to make traffic. |
| The phone cannot open the page | Use `npm run start:lan`, the same Wi-Fi, and allow Node.js through the Windows firewall (Private networks). Some guest Wi-Fi networks block devices from seeing each other. |
