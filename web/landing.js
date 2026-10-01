// Landing page: language switch and strings.
import { createI18n } from '/shared/i18n.js';
const i18n = createI18n({
  en: {
    ribbon: 'LAB · not real money',
    lede: 'A virtual school card system, run as SaaS for many schools, that you can try before any hardware exists. Everything is virtual, including the cloud server: cards, canteen readers, water machines and top-up kiosks talk to the platform through a real MQTT broker.',
    labTitle: 'Lab console',
    labText: 'Tap cards on machines, pull network cables, carry the admin card, inject faults and watch every message.',
    operatorTitle: 'Operator console',
    operatorText: "The SaaS owner's view: every school on the platform, onboard a new school with its machines, suspend or reactivate one.",
    adminTitle: 'School office',
    adminText: 'Students and cards, lost cards, machines, prices, top-ups, the books and reconciliation.',
    parentTitle: 'Parent app',
    parentText: 'Phone-first web app: link a child with an invitation code, see the balance and top up.',
    watchTitle: 'Watch the device messages',
    watchText: 'Connect any MQTT tool to the lab broker with the read-only login (default viewer / viewer; the terminal that started the lab prints the exact details).',
    safety: 'Everything here is fictional: schools, people, money and keys. Do not put real data or real keys into the lab.',
  },
  zh: {
    ribbon: '实验室 · 不是真钱',
    lede: '在任何硬件到货之前就能试的虚拟校园一卡通，以 SaaS 方式服务很多学校。全部都是虚拟的，包括云端服务器：卡、食堂刷卡机、饮水机和充值机，通过真正的 MQTT broker 和平台通信。',
    labTitle: '实验室控制台',
    labText: '在机器上刷卡、拔网线、带参数卡、制造故障，看每一条消息。',
    operatorTitle: '平台运营后台',
    operatorText: 'SaaS 运营方的视角：平台上所有学校，开通新学校（连机器一起），停用或恢复学校。',
    adminTitle: '学校后台',
    adminText: '学生和卡、挂失、机器、价格、充值、账本和对账。',
    parentTitle: '家长网页',
    parentText: '手机优先的网页：用邀请码绑定孩子，看余额，在线充值。',
    watchTitle: '看设备消息',
    watchText: '用任何 MQTT 工具连到实验室的 broker，用只读账号登录（默认 viewer / viewer；启动实验室的终端会印出准确资料）。',
    safety: '这里的一切都是虚构的：学校、人名、钱和密钥。不要把真资料或真密钥放进实验室。',
  },
});
document.getElementById('lang').append(i18n.switcher());
i18n.apply();
