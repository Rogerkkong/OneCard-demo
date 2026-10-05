# OneCard Lab exercises

Hands-on exercises, like Packet Tracer labs: each one has a goal, the steps, and what
you should see. Start the lab (`npm start`) and keep three tabs open: the **lab console**
(`/lab/`), the **school office** (`/admin/`) and the **parent app** (`/parent/`).
Optionally watch the raw MQTT traffic with the read-only `viewer` login (see the README).

All amounts below come from the demo seed and the default price list:
Nasi lemak RM 3.50 · Mee goreng RM 4.00 · Roti canai RM 1.50 · Teh tarik RM 1.80 ·
Milo ais RM 2.20 · Air sirap RM 1.20 · Fruit RM 1.00 · water RM 0.20 per litre, minimum
RM 0.05. Starting balances (SMK Seri Contoh): Ahmad Faiz (S1001) RM 30.00 on the card
plus RM 20.00 waiting at the kiosk; Lee Mei Ling (S1002) RM 25.00; Arjun (S1003) RM 40.00;
Siti Aisyah (S1004) RM 15.00; Wong Jia Hui (S1005) RM 0.00 plus a RM 10.00 school
subsidy waiting; Muhammad Irfan (S1006) RM 0.00.

The machines in SMK Seri Contoh: `CANTEEN-01` (networked), `CANTEEN-02` (no network),
`WATER-01` (no network), `KIOSK-01` (networked, the only machine that can add money).

---

## 1. Pay at a networked canteen reader

1. Lab console: tap Ahmad Faiz's card on `CANTEEN-01`, choosing Nasi lemak + Teh tarik.
2. The reader shows **Paid RM 5.30 · Balance RM 24.70**.
3. In the message inspector, a `sale.recorded` message goes to
   `lab/v1/smk-contoh/CANTEEN-01/records`, and the platform accepts it.
4. School office → Ahmad Faiz: the platform's balance is **RM 24.70**, the same as the card,
   and the purchase appears with price version 1.

*What it shows:* the card is the wallet — the reader charged the card by itself, and the
platform's books follow when the record arrives.

## 2. Pay at a reader with no network, and three ways records come back

1. Tap Lee Mei Ling's card on `CANTEEN-02` and buy Roti canai (RM 1.50).
   The card now holds RM 23.50, but the school office still shows RM 25.00: the record is
   waiting in `CANTEEN-02`'s journal.
2. Bring it back in any of these ways (try all three — each record still counts once):
   - **Kiosk read-back:** tap Lee Mei Ling's card on `KIOSK-01`. The kiosk reads the card's
     recent records and uploads them (`card.readback`).
   - **USB export:** export `CANTEEN-02`'s journal and import the file in the school office.
   - **Plug the cable:** connect `CANTEEN-02` to the network; it uploads its unsent records
     as a `journal.batch`.
3. The school office now shows RM 23.50. Repeated uploads appear as duplicates, not as
   extra charges.

## 3. Water by the litre

1. Tap Arjun's card on `WATER-01` and pour 650 ml → **RM 0.13** (650 ml × RM 0.20/L, rounded).
2. Pour 10 ml → **RM 0.05**, the minimum charge. (Give it a few seconds: a machine refuses the same
   card twice within 3 s with *Please wait … and tap again*.)
3. Try Muhammad Irfan's empty card → refused, *Not enough balance*.
4. Bring the records back (exercise 2) and check the amounts in the school office.

## 4. A parent tops up

1. Parent app: sign in as **Rahman bin Yusof**. Ahmad Faiz shows the balance and
   **RM 20.00 waiting**, side by side and never added together.
2. Top up RM 15.00 and pay at the mock bank. Waiting becomes RM 35.00; the balance does not move.
3. Lab console: tap Ahmad Faiz's card on `KIOSK-01` → **Added RM 35.00**.
4. The parent app shows the new balance and nothing waiting.
5. School office → books: each payment is *debit cash received / credit waiting to be added*;
   each kiosk write is *debit waiting to be added / credit student wallet*. The trial balance balances.

## 5. A new parent signs up with an invitation code

1. School office → parents: find the open invitation for Muhammad Irfan (S1006).
2. Parent app: register a new parent, enter the code. The link is *pending*.
3. School office: approve it. The parent now sees Muhammad Irfan.

## 6. Money that never reaches the card is refunded

1. Top up a child, but do not tap the card at the kiosk.
2. Lab console: move the clock forward 15 days (the add window is 14 days).
3. The order becomes **refunded**; the books show a reversal of the payment, and the parent
   app shows the refund.

## 7. A lost card, and the window before offline machines know

1. School office: report Lee Mei Ling's card lost. The block-list version goes up.
2. Networked machines (`CANTEEN-01`, `KIOSK-01`) get the new list at once (a retained
   message on their `commands/blocklist` topic). Tap the card on `CANTEEN-01` →
   **Card unavailable, please contact the front desk** (it never says why).
3. Tap the same card on `CANTEEN-02` (no network, old list) → **still accepted**: this is the
   lost-card window.
4. Lab console: load the admin card at `KIOSK-01`, tap it on `CANTEEN-02`, then tap it on
   the kiosk again to upload the receipts. `CANTEEN-02` now refuses the card, and the school
   office shows it on the new list version (via admin card).
5. When the window purchase reaches the platform, reconciliation shows
   **Card used after it was reported lost**, with "machine had the updated list: no".

## 8. A replacement card

1. School office: replace Lee Mei Ling's card with a new card UID.
2. Her platform balance moves into a transfer that waits at the kiosk.
3. Lab console: tap the new card on `KIOSK-01` → the balance is added to the new card.

## 9. New prices

1. School office: publish a new price list (e.g. Nasi lemak RM 3.80).
2. Networked machines get it immediately; their settings and block list are untouched
   (each has its own retained topic).
3. `CANTEEN-02` keeps the old price until the admin card visits it.
4. Each sale records its price version, and the platform checks the amount against the
   version the machine used, not today's price.

## 10. Device security

Use the fault panel in the lab console:
- **Forged message** → refused with `SIGNATURE_INVALID` (school office → device log).
- **Publish to another machine's topic** → the broker refuses it and closes that connection; nothing
  reaches the platform. (The fault logs in with the machine's own login, so the real machine is knocked
  off the broker for about a second and reconnects by itself.)
- **Sequence rollback** → refused with `SEQUENCE_ROLLBACK`.
- School office: switch a machine off → the broker disconnects it at once.
- Operator console: suspend the school (suspending a school is the SaaS operator's action, not the
  school's) → uploads are refused and machines are disconnected; reactivate it and the machines send
  their records again.

## 11. Kiosk power cuts and lost confirmations

1. Top up a child, then tap the card on `KIOSK-01` with **power cut before writing** →
   nothing is written; the money keeps waiting.
2. Tap again with **power cut after writing** → the money is on the card, but the platform
   never heard back. After the add window the order is **parked for a person**, never
   refunded automatically (the money may already be on the card).
3. Tap the card on the kiosk again: the kiosk finds the write on the card and confirms it →
   the order becomes **added**.
4. **Confirmation timeout:** the kiosk looks the result up by the same kiosk transaction
   number and resends it. It never writes the card a second time.

## 12. Copied and tampered cards

1. Fault panel: **copy a card**, then spend on both the original and the copy.
   Reconciliation flags **two purchases with the same card counter** and the card balance no
   longer matches the platform's books (tap the original at the kiosk: its read-back shows the
   mismatch). This is why cards holding money must be uncopyable.
2. **Tamper with a card** (change its balance by hand) → every machine refuses it, because
   the card's security code no longer matches.

## 13. Reconciliation

1. School office → reconciliation shows every open difference with an explanation.
2. Move the clock forward a day: machines still on an old block list are flagged (there is one once
   a card has been reported lost, as in exercise 7, and an offline machine has not had the new list).
3. Resolve each difference with a note; it stays in the history.

## 14. One system, many schools (SaaS tenants)

1. Operator console (`/operator/`): every school is listed with its own status, machines,
   sales and open differences — one platform serving them all.
2. **Onboard a third school**: give it a code and name, its first staff, a canteen reader, a
   water machine and a kiosk, and a few demo students. It gets the default prices and settings.
3. Lab console: the new school's site appears with its machines and cards straight away.
   Tap a card there — it works like the other schools, on the same server. Its demo cards start
   empty, so the reader answers *Not enough balance* until money is added: grant a subsidy in that
   school's office (as its ADMIN or FINANCE staff) and tap the card at its kiosk.
4. Try to cross the line:
   - Sign in to the school office as SMK Seri Contoh staff: nothing from the other schools
     is visible, not even by guessing an id in the URL.
   - Tap an SJK(C) Contoh card on an SMK Seri Contoh reader → **Card unavailable** (each
     school has its own card key, so the card means nothing to another school's machines).
   - Fault panel: a machine tries to publish to another school's topic → the broker refuses it.
   - Lee Kah Seng (parent) sees his two children in two different schools, and nobody else's.
5. Operator console: **suspend** one school. Its machines are disconnected and its uploads
   refused, its staff and parents are blocked — and the other schools carry on untouched.
   Reactivate it and its machines send what they kept.

## 15. The cloud server goes down

The whole server — broker, platform and database — is virtual too, so you can switch it off.

1. Lab console: switch the **cloud server off**. Every school loses it at the same moment.
2. Canteen readers and water machines keep selling (the money is on the cards); their
   records wait in their journals.
3. The kiosk adds nothing ("cannot reach the platform"); parents cannot pay; the school
   office cannot load. This is what one server means for every tenant.
4. Switch the server back on: machines reconnect and upload what they kept, and the
   platform sends every machine its current prices, settings and block list again.
5. **Restart only the broker**: retained messages are lost with it, and the platform puts
   them back as soon as it reconnects — check a machine's versions in the school office.

## 16. Simulation mode (step by step, like Packet Tracer)

Every action you take in the lab, and every change made in the web apps, is kept as a *trace*:
the whole flow, hop by hop — card → machine → broker → platform → books. The lab console replays
a trace step by step, and in simulation mode it can hold a flow at each hop while you break
things in between.

1. **Replay a tap.** Lab console: open the **Simulation** tab and tap Ahmad Faiz's card on
   `CANTEEN-01` (Nasi lemak). The newest trace, *Tap 04A13B5C7D2E80 on smk-contoh/CANTEEN-01*,
   is followed by itself. Step through it (or press play): the card is read (balance, counter,
   block list), the rules are checked one by one, the card is charged, the record goes into the
   journal, the screen shows **Paid RM 3.50 · Balance RM 26.50**, the signed `sale.recorded` goes
   to the broker, which acknowledges it, and the platform runs its ten checks and books it.
2. **Open the packet details.** Click a step: *Card* shows the chip data, *Machine checks* the
   rules ✓, *Message* the envelope, *Security* the signature (HMAC-SHA256 with the machine's own
   secret, checked by the platform), *MQTT* the topic, QoS 1 and the acknowledgement, *Platform
   checks* the pipeline steps ✓, *Books* the posting lines.
3. **Hold at each hop.** Switch the header to **Simulation** and switch on *Hold at each hop
   (live)*. Tap Lee Mei Ling's card on `CANTEEN-01` (Roti canai). The reader answers at once,
   **Paid RM 1.50 · Balance RM 23.50** (the money is already off the card), but the record waits
   in the reader's outbox with a pause badge.
4. **Pull the cable while the sale is in the machine.** Unplug `CANTEEN-01`, then press **Next
   hop**. The record finds no network: the trace shows the step *offline*, and `CANTEEN-01` has
   **1 unsent** record in its journal. Nothing is lost.
5. **Plug it back.** Plug `CANTEEN-01` in. Reconnecting is a flow of its own, and it waits too:
   press **Next hop** until its heartbeat and its `journal.batch` have passed the reader and the
   platform. The record arrives once (purchase **POSTED**, via the journal batch) and the school
   office shows RM 23.50, like the card. (The broker also hands the machine its retained prices,
   settings and block list again. Those belong to the flow that published them, such as an
   earlier price change, so their acknowledgements show up, and wait, in that flow's trace.)
6. **Hold at the platform, then switch the server off.** Tap Arjun's card on `CANTEEN-01` and
   press **Next hop** once: the broker takes the record (for the reader it is sent) and it waits
   at the platform's door. Switch the cloud server off: **Next hop** cannot let it go, the
   platform is off. Switch the server on: the record goes on by itself and is booked exactly
   once. The machines coming back belong to the server's own trace and wait at their outboxes
   too; switch back to **Realtime** to let everything go.
7. **The kiosk when the server goes off.** With hold on, tap Ahmad Faiz's card on `KIOSK-01` and
   press **Next hop** until the kiosk's `pending` call waits. Switch the server off and press
   **Next hop**: the call gets no answer, the kiosk writes nothing and shows *Cannot reach the
   platform, please come back later*. Switch the server on and back to **Realtime**: the next
   tap adds the **RM 20.00** waiting.

The same from a text console (PuTTY or the Console tab), at `onecard>` or `server#`:
`simulation on`, `hold on`, `show held`, `next`, `show traces`, `show trace <n>` (one line per
step), `hold off`, `simulation off`. A machine's own prompt has `next` and `show held` too.

*What it shows:* every hop is a separate step that can fail on its own, and the system is built
for it: the card is the wallet, the machine's journal keeps what could not be sent, the platform
keeps what it has acknowledged, and each record counts once whatever happens between the hops.

## 17. Build a school by drag and drop (like Packet Tracer)

Packet Tracer's way of building a network, for OneCard: take a machine from the device bar, drop it on a school,
and draw its cable. The lab does what a technician and the operator would do: the platform registers the machine,
gives it its own secret and the school's settings, and the lab installs it.

1. **Add a reader.** Lab console: drag **Canteen reader** from the **Add to the lab** bar (under the header) onto
   SMK Seri Contoh. The window suggests **CANTEEN-03**, the next free code. Press **Add machine**. CANTEEN-03
   appears with **No network**, its cable end hanging under the school network line. The school office's
   **Machines** page lists it too.
2. **Draw its cable.** Drag CANTEEN-03's cable end onto the school network line. It connects, holds prices v1,
   settings v1 and block list v1, and sells like CANTEEN-01: Lee Mei Ling's card with a Roti canai →
   **Paid RM 1.50 · Balance RM 23.50**.
3. **Pull it by dragging.** Drag the cable end off the line: **No network**. Wait 3 s and tap her card again (Teh
   tarik): the sale works offline and waits in the journal (**1 unsent**). Press **Plug cable in**: the record
   uploads and is booked once.
4. **Codes are checked.** Press **Add machine** on SMK Seri Contoh and type `CANTEEN-01` as the code: the window
   says the school already has it, and nothing is added. In the operator console, suspend SJK(C) Contoh: while you
   drag a machine it is dimmed, and dropping there says it is suspended. Reactivate it.
5. **Add a school.** Drag **School** onto the internet line. Name *SMK Bukit Indah* (the code *smk-bukit-indah* is
   made from it), **3** demo students, all three machines → **Add school**. Its site shows CANTEEN-01, KIOSK-01 and
   WATER-01 with their cables unplugged, three cards at RM 0.00 in the card tray (Aina Contoh D001, Boon Keat
   Contoh D002, Chitra Contoh D003) and its admin card. The operator console lists the new school.
6. **Make it work.** School office: sign in as **Encik Lim Chee Keong** (SMK Bukit Indah, finance) → **Top-ups**
   → grant Aina Contoh a subsidy of RM 5.00. Draw the cable of the new KIOSK-01 and tap Aina's card: **Added
   RM 5.00 · Balance RM 5.00**. Draw the cable of the new CANTEEN-01 and sell her a Roti canai and a Teh tarik:
   **Paid RM 3.30 · Balance RM 1.70**. The new school's **Books** say *Balanced*.
7. **Its own card key.** Tap an SMK Seri Contoh card on SMK Bukit Indah's CANTEEN-01 → **Card unavailable**: the
   new school got its own card key.
8. **Replay it.** Switch to **Simulation** and add a water machine to SMK Bukit Indah with **Plug its cable in
   now** ticked. The newest flow, *Add a water machine WATER-02 …*, shows the platform registering it
   (`device.registered`), publishing its prices, settings and block list, the cable going in, the machine logging in
   to the broker (`mqtt.connect`) and its first heartbeat. Pull a cable, or switch the server off: the machines'
   broker logouts are steps of those flows too.

At `onecard>` (PuTTY or the Console tab) the same works with `add machine smk-contoh kiosk` and
`add school smk-baru SMK Baru`. **Reset the demo…** removes everything you added.

*What it shows:* a new machine or a new school goes through the same doors as the first ones: registered by the
platform with its own secret, its own topics on the broker and, for a school, its own card key. It works the
moment its cable is in, and nothing about the protocol changes as the network grows.
