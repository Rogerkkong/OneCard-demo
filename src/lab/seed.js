// Demo data for the lab: two fictional schools with staff, cardholders, parents and
// machines. Everything here is made up (example.com addresses, invented names).
//
// seedDemo() only writes the database. Starting balances must go through the real
// flows (parent pays → kiosk adds to the card), so the lab runs START_PLAN after the
// machines are online; that keeps every card balance equal to its mirror balance.

import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../platform/configs.js';

export const DEMO_SCHOOLS = [
  {
    code: 'smk-contoh',
    name: 'SMK Seri Contoh',
    staff: [
      { name: 'Nur Aisyah', role: 'OFFICE' },
      { name: 'Tan Wei Ming', role: 'FINANCE' },
      { name: 'Kavitha Raj', role: 'ADMIN' },
    ],
    members: [
      { memberNo: 'S1001', name: 'Ahmad Faiz bin Rahman', className: '4 Bestari', uid: '04A13B5C7D2E80' },
      { memberNo: 'S1002', name: 'Lee Mei Ling', className: '4 Bestari', uid: '04B2194E6A3C81' },
      { memberNo: 'S1003', name: 'Arjun a/l Suresh', className: '5 Cemerlang', uid: '04C35D2F8B1A82' },
      { memberNo: 'S1004', name: 'Siti Aisyah binti Omar', className: '3 Amanah', uid: '04D47E3A9C2B83' },
      { memberNo: 'S1005', name: 'Wong Jia Hui', className: '2 Dinamik', uid: '04E5814BAD3C84' },
      { memberNo: 'S1006', name: 'Muhammad Irfan bin Hakim', className: '1 Gemilang', uid: '04F6925CBE4D85' },
      { memberNo: 'T2001', name: 'Ong Siew Lan (teacher)', className: 'Staff', group: 'STAFF', uid: '0407A36DCF5E86' },
    ],
    devices: [
      { code: 'CANTEEN-01', type: 'CANTEEN', location: 'Canteen counter A', cablePlugged: true },
      { code: 'CANTEEN-02', type: 'CANTEEN', location: 'Canteen counter B (no network)', cablePlugged: false },
      { code: 'WATER-01', type: 'WATER', location: 'Block A water point (no network)', cablePlugged: false },
      { code: 'KIOSK-01', type: 'KIOSK', location: 'Front office', cablePlugged: true },
    ],
  },
  {
    code: 'sjkc-contoh',
    name: 'SJK(C) Contoh',
    staff: [
      { name: 'Chong Mei Yee', role: 'OFFICE' },
      { name: 'Goh Kian Huat', role: 'FINANCE' },
      { name: 'Lim Bee Hoon', role: 'ADMIN' },
    ],
    members: [
      { memberNo: 'P101', name: 'Lee Jun Hao', className: '3 Merah', uid: '0418B47ED06F87' },
      { memberNo: 'P102', name: 'Tan Xin Yi', className: '4 Biru', uid: '0429C58FE17A88' },
      { memberNo: 'P103', name: 'Ng Zhi Hao', className: '5 Hijau', uid: '043AD69AF28B89' },
      { memberNo: 'P104', name: 'Chan Kai Wen', className: '6 Kuning', uid: '044BE7AB039C8A' },
    ],
    devices: [
      { code: 'CANTEEN-01', type: 'CANTEEN', location: 'Canteen', cablePlugged: true },
      { code: 'WATER-01', type: 'WATER', location: 'Hall water point', cablePlugged: true },
      { code: 'KIOSK-01', type: 'KIOSK', location: 'School office', cablePlugged: true },
    ],
  },
];

// Parents and the children they are linked to (links are approved by the school in the seed).
// "Lee Kah Seng" has a child in each school, to show one parent login across schools.
export const DEMO_PARENTS = [
  { email: 'rahman.yusof@example.com', name: 'Rahman bin Yusof', children: [['smk-contoh', 'S1001']] },
  { email: 'lee.kahseng@example.com', name: 'Lee Kah Seng', children: [['smk-contoh', 'S1002'], ['sjkc-contoh', 'P101']] },
  { email: 'suresh.kumar@example.com', name: 'Suresh Kumar', children: [['smk-contoh', 'S1003']] },
  { email: 'omar.zainal@example.com', name: 'Omar bin Zainal', children: [['smk-contoh', 'S1004']] },
  { email: 'tan.kokwai@example.com', name: 'Tan Kok Wai', children: [['sjkc-contoh', 'P102']] },
  { email: 'ng.sookching@example.com', name: 'Ng Sook Ching', children: [['sjkc-contoh', 'P103']] },
];

// Starting money, run by the lab through the real flows once the machines are online:
// - added:    the parent pays, then the student taps at the kiosk (money ends up on the card)
// - waiting:  the parent pays but the student has not tapped yet ("waiting to be added")
// - subsidy:  the school grants a subsidy, waiting at the kiosk
// Members not listed start at RM 0.00 (S1006 and P104 show what an empty card looks like).
export const START_PLAN = [
  { school: 'smk-contoh', memberNo: 'S1001', added: 3000, waiting: 2000 },
  { school: 'smk-contoh', memberNo: 'S1002', added: 2500 },
  { school: 'smk-contoh', memberNo: 'S1003', added: 4000 },
  { school: 'smk-contoh', memberNo: 'S1004', added: 1500 },
  { school: 'smk-contoh', memberNo: 'S1005', subsidy: 1000 },
  { school: 'sjkc-contoh', memberNo: 'P101', added: 2000 },
  { school: 'sjkc-contoh', memberNo: 'P102', added: 3000, waiting: 1000 },
  { school: 'sjkc-contoh', memberNo: 'P103', added: 1000 },
];

/**
 * Write the demo schools, staff, members, cards, parents, links, devices, the first price
 * list and settings, and an empty block list. Uses the platform services so every rule and
 * audit entry applies.
 *
 * @param {object} platform  from createPlatform(ctx)
 * @returns {{ schools: Array<{ id, code, name, cardKey, staff, members, devices }>, parents: Array<{ id, email, name }> }}
 */
export function seedDemo(platform) {
  const { schools, devices, configs } = platform.services;
  const actor = 'seed';
  const out = { schools: [], parents: [] };

  for (const s of DEMO_SCHOOLS) {
    const school = schools.createSchool({ code: s.code, name: s.name });
    const staff = s.staff.map((p) => schools.addStaff({ schoolId: school.id, name: p.name, role: p.role }));
    const members = s.members.map((m) => {
      const member = schools.addMember({
        schoolId: school.id,
        memberNo: m.memberNo,
        name: m.name,
        className: m.className,
        group: m.group ?? 'STUDENT',
      });
      const card = schools.issueCard({ schoolId: school.id, memberId: member.id, uid: m.uid, actor });
      return { id: member.id, memberNo: m.memberNo, name: m.name, group: m.group ?? 'STUDENT', cardUid: card.uid };
    });
    const machines = s.devices.map((d) => {
      const { device, secret } = devices.registerDevice({ schoolId: school.id, code: d.code, type: d.type, location: d.location, actor });
      return { id: device.id, code: d.code, type: d.type, location: d.location, secret, cablePlugged: d.cablePlugged };
    });
    configs.publish({ schoolId: school.id, kind: 'prices', content: DEFAULT_PRICES, actor });
    configs.publish({ schoolId: school.id, kind: 'settings', content: DEFAULT_SETTINGS, actor });
    // machines refuse every card until they hold a block list, so start with an empty one
    configs.ensureBlockList({ schoolId: school.id, actor });
    out.schools.push({
      id: school.id,
      code: school.code,
      name: school.name,
      cardKey: schools.schoolCardKey(school.id),
      staff,
      members,
      devices: machines,
    });
  }

  const memberIdOf = (schoolCode, memberNo) => {
    const school = out.schools.find((x) => x.code === schoolCode);
    const member = school && school.members.find((m) => m.memberNo === memberNo);
    if (!member) throw new Error(`seed: unknown member ${schoolCode}/${memberNo}`);
    return { schoolId: school.id, memberId: member.id };
  };

  for (const p of DEMO_PARENTS) {
    const parent = schools.registerParent({ email: p.email, name: p.name });
    for (const [schoolCode, memberNo] of p.children) {
      const { schoolId, memberId } = memberIdOf(schoolCode, memberNo);
      const invite = schools.createInvite({ schoolId, memberId, actor });
      const link = schools.redeemInvite({ parentId: parent.id, code: invite.code });
      schools.decideLink({ schoolId, linkId: link.id, approve: true, actor });
    }
    out.parents.push({ id: parent.id, email: parent.email, name: parent.name, children: p.children });
  }

  // One open invitation per school, for trying the parent sign-up flow by hand.
  for (const [schoolCode, memberNo] of [['smk-contoh', 'S1006'], ['sjkc-contoh', 'P104']]) {
    const { schoolId, memberId } = memberIdOf(schoolCode, memberNo);
    const invite = schools.createInvite({ schoolId, memberId, actor });
    out.schools.find((x) => x.id === schoolId).openInvite = { code: invite.code, memberNo };
  }

  return out;
}
