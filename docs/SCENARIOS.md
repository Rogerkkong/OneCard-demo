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
2. Pour 10 ml → **RM 0.05**, the minimum charge.
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
- **Publish to another machine's topic** → the broker refuses it.
- **Sequence rollback** → refused with `SEQUENCE_ROLLBACK`.
- School office: switch a machine off → the broker disconnects it at once.
- School office (ADMIN): suspend the school → uploads are refused and machines are
  disconnected; reactivate it and the machines send their records again.

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
   longer matches the platform's books. This is why cards holding money must be uncopyable.
2. **Tamper with a card** (change its balance by hand) → every machine refuses it, because
   the card's security code no longer matches.

## 13. Reconciliation

1. School office → reconciliation shows every open difference with an explanation.
2. Move the clock forward a day: machines still on an old block list are flagged.
3. Resolve each difference with a note; it stays in the history.
