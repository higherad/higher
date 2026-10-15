// hi-store.js 핵심 로직 자가검사 — 메모리 가짜 RTDB에 붙여 실행: node hi-store.test.mjs
// (firebase CDN import를 가짜로 바꿔 로드. 브라우저 전용 부분(리스너·로그인)은 검사 안 함)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const tree = {};
const parts = p => p.split('/').filter(Boolean);
const read = p => parts(p).reduce((n, k) => (n == null ? undefined : n[k]), tree);
function write(p, v) {
  const ks = parts(p), last = ks.pop();
  let n = tree;
  for (const k of ks) n = n[k] ??= {};
  if (v === null || v === undefined) delete n[last]; else n[last] = structuredClone(v);
}
const snap = (path, v) => ({ key: parts(path).pop(), exists: () => v !== undefined && v !== null, val: () => structuredClone(v ?? null) });
let seq = 0;
const fb = {
  initializeApp: () => ({}), getDatabase: () => ({}), getAuth: () => ({ authStateReady: () => Promise.resolve(), currentUser: { getIdToken: async () => 't' } }),
  ref: (_db, path = '') => ({ path }),
  query: (r, ...f) => ({ path: r.path, filters: f }),
  orderByChild: f => ({ child: f }), equalTo: v => ({ eq: v }), startAt: v => ({ start: v }), orderByKey: () => ({}), limitToLast: () => ({}),
  get: async r => {
    let v = read(r.path);
    const child = r.filters?.find(f => f.child)?.child, eq = r.filters?.find(f => 'eq' in f);
    if (child && eq && v) v = Object.fromEntries(Object.entries(v).filter(([, x]) => x[child] === eq.eq));
    return snap(r.path, v && Object.keys(v).length === 0 ? undefined : v);
  },
  set: async (r, v) => write(r.path, v),
  update: async (r, obj) => { for (const [k, v] of Object.entries(obj)) write(`${r.path}/${k}`, v); },
  remove: async r => write(r.path, null),
  push: r => ({ path: `${r.path}/k${++seq}`, key: `k${++seq}` }),
  onValue: (r, cb) => { cb(snap(r.path, read(r.path))); return () => {}; }, onChildAdded() {}, onChildChanged() {}, onChildRemoved() {},
  onDisconnect: () => ({ remove() {}, cancel: () => Promise.resolve() }),
  goOffline() {}, goOnline() {},
  runTransaction: async (r, fn) => { const nv = fn(read(r.path) ?? null); if (nv === undefined) return { committed: false }; write(r.path, nv); return { committed: true }; },
  signInWithEmailAndPassword: async () => ({ user: { uid: 'u' } }), signOut: async () => {},
};
globalThis.__fb = fb;
globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem: () => null };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

let src = readFileSync(new URL('./hi-store.js', import.meta.url), 'utf8')
  .replace(/import \{([^}]*)\}\s*from "[^"]+";/g, (_, names) =>
    `const {${names.replace(/(\w+) as (\w+)/g, '$1: $2')}} = globalThis.__fb;`);
const { default: HI, remainingAfterCancel, kwCategoryOf } = await import('data:text/javascript,' + encodeURIComponent(src));

// ── 접수: live + 키워드 분리 ──
tree.hi = { users: { u1: { username: 'u1', agencyId: 'A', unitPrice: 30 } } };
const c = await HI.addCampaign({ agencyId: 'A', userId: 'u1', mid: '111', searchKeyword: 'kw1', days: 3, dailyTarget: 10, createdAt: '2026-10-01T01:02:03.000Z' });
assert.equal(tree.hi.campaigns.live[c._key].unitPrice, 30, '접수 시 회원 단가 고정');
assert.equal(tree.hi.campaigns.live[c._key].searchKeyword, undefined, '캠페인 레코드엔 키워드 없음');
assert.equal(tree.hi.campaign_keywords[c._key].search, 'kw1');

// ── 키워드 수정 → 이력 ──
assert.equal(tree.hi.campaigns.live[c._key].searchKwCount, 1);
await HI.updateCampaign(c._key, { searchKeyword: 'kw2, kw3 ,', memo: 'm' });
assert.equal(tree.hi.campaigns.live[c._key].searchKwCount, 2, '키워드 개수 필드 갱신');
await HI.updateCampaign(c._key, { searchKeyword: 'kw2' });
assert.equal(tree.hi.campaign_keywords[c._key].search, 'kw2');
assert.equal(tree.hi.campaign_keywords[c._key].history.search.at(-1).keyword, 'kw2');
assert.equal(tree.hi.campaigns.live[c._key].memo, 'm');

// ── 종료: live → closed 이동, 필드 보존 ──
await HI.updateCampaign(c._key, { status: 'expired' });
assert.equal(tree.hi.campaigns.live[c._key], undefined, 'live에서 빠짐');
assert.equal(tree.hi.campaigns.closed[c._key].status, 'expired');
assert.equal(tree.hi.campaigns.closed[c._key].memo, 'm', '이동 시 필드 보존');

// ── 휴지통 → 복구(원래 상태가 live면 live로) ──
await HI.updateCampaign(c._key, { status: 'active' });
const cs = tree.hi.campaigns.live[c._key], cgk = HI.settleGroupKey(cs), cTgt = cs.dailyTarget * cs.days;
tree.hi.settle_snapshots = { [cgk]: { amount: 10000, totalTarget: 500, slotCount: 3, unitPrice: 20 } };
await HI.trash(c._key);
assert.equal(tree.hi.campaigns.closed[c._key].originalStatus, 'active');
assert.equal(tree.hi.settle_snapshots[cgk].amount, 10000 - cTgt * (cs.unitPrice || 20), '휴지통 → 저장된 정산 금액에서 빠짐');
assert.equal(tree.hi.settle_snapshots[cgk].slotCount, 2);
await HI.restore(c._key);
assert.deepEqual(tree.hi.settle_snapshots[cgk], { amount: 10000, totalTarget: 500, slotCount: 3, unitPrice: 20 }, '복구 → 원래 금액');
delete tree.hi.settle_snapshots;
assert.equal(tree.hi.campaigns.live[c._key].status, 'active');
assert.equal(tree.hi.campaigns.live[c._key].originalStatus, undefined, '복구 후 휴지통 필드 제거');
assert.equal(tree.hi.campaigns.closed[c._key], undefined);

// ── 일괄 종료 + MID 조회(양쪽 노드) ──
await HI.expire([c._key]);
assert.equal(tree.hi.campaigns.closed[c._key].status, 'expired');
assert.equal((await HI.getByMid('111')).length, 1);

// ── 예약 취소 후 일수·종료일 ──
assert.deepEqual(remainingAfterCancel({ startDate: '2026-10-01', endDate: '2026-10-05', days: 5 }, ['2026-10-04', '2026-10-05'], []),
  { days: 3, endDate: '2026-10-03' });
assert.deepEqual(remainingAfterCancel({ startDate: '2026-10-01', endDate: '2026-10-05', days: 5 }, ['2026-10-05'], ['2026-10-05']),
  { days: 5, endDate: '2026-10-05' }, '남은 항목 있는 날짜는 유지');

// ── 정산 묶음 키·대상 ──
const base = { createdAt: '2026-10-01T01:02:03.000Z', agencyId: '[단독]A.B', userId: 'u1' };
assert.ok(HI.settleGroupKey({ ...base, origin: 'ha' }).endsWith('___단독_A_B__u1'));
assert.ok(HI.settleGroupKey({ ...base, origin: 'kp' }).endsWith('___단독_A_B__u1'), '옛 김프로 출처도 회원 아이디로 묶음');
assert.ok(!HI.settleGroupKey(base).includes('['), 'RTDB 금지문자 치환');
assert.equal(HI.isBillable({ status: 'expired' }), true);
assert.equal(HI.isBillable({ status: 'deleted' }), false);
assert.equal(HI.isBillable({ status: 'active', isRequeue: true }), false);

// ── 영구삭제 ──
tree.hi.billing = { paid: { [c._key]: true } };
await HI.permanentDelete(c._key);
assert.equal(tree.hi.campaigns.closed[c._key], undefined);
assert.equal(tree.hi.campaign_keywords[c._key], undefined);
assert.equal(tree.hi.billing.paid?.[c._key], undefined);

// ── 승인 시 충전·입금 도장(오렌지) — 실제 충전 없이 기록만, 새 묶음은 금액 필드까지, 기존 스냅샷은 금액 보존 ──
globalThis.sessionStorage.getItem = () => JSON.stringify({ username: 'admin', name: '관리자' });
tree.hi.users = { o: { username: 'o', agencyId: '[단독]오렌지', unitPrice: 20 } };
const o1 = { _key: 'o1', status: 'active', agencyId: '[단독]오렌지', userId: 'o', createdAt: '2026-10-13T10:00:05.000Z', dailyTarget: 10, days: 3, unitPrice: 20, deductAmount: 7 };
const o2 = { ...o1, _key: 'o2', status: 'pending', dailyTarget: 5 };
const gk = HI.settleGroupKey(o1);
await HI.stampChargeAndPaid([o1, o2]);
assert.equal(tree.hi.settle_snapshots?.[gk], undefined, '묶음에 미승인 건이 있으면 도장 안 찍음');
await HI.stampChargeAndPaid([o1, { ...o2, status: 'deleted' }]);
assert.equal(tree.hi.settle_snapshots[gk].amount, 30 * 20, '미승인 건을 지우면 남은 건만으로 도장');
delete tree.hi.settle_snapshots[gk]; delete tree.hi.billing.paid.o1;
await HI.stampChargeAndPaid([o1, { ...o2, status: 'split' }]);
const s1 = tree.hi.settle_snapshots[gk];
assert.equal(s1.amount, (30 + 15) * 20, '새 묶음 금액 = 묶음 전체');
assert.equal(s1.slotCount, 2);
assert.equal(s1.deductAmt, 14);
assert.equal(s1.chargeConfirmedByName, '관리자', '충전 담당자 = 로그인 직원');
assert.equal(s1.confirmedBy, 'admin', '입금 담당자 = 로그인 직원');
assert.equal(s1.chargeApiAmount, 900);
assert.ok(tree.hi.billing.paid.o1 && tree.hi.billing.paid.o2, '묶음 캠페인 입금 표시');
tree.hi.settle_snapshots = { [gk]: { amount: 123, timeKey: s1.timeKey } };  // 과거 날짜 고정분
await HI.stampChargeAndPaid([o1]);
assert.equal(tree.hi.settle_snapshots[gk].amount, 123, '고정 금액은 건드리지 않음');
assert.equal(tree.hi.settle_snapshots[gk].chargeConfirmedByName, '관리자');

// ── 강제종료: 같은 MID 진행 중만 force_stopped, 남은 기간 재접수 1회, 다음 날 종료 ──
const f1 = await HI.addCampaign({ agencyId: 'A', userId: 'u1', mid: '777', searchKeyword: 'fk', days: 10, dailyTarget: 50, unitPrice: 20,
  startDate: '2026-10-10', endDate: '2026-10-19' });
const fPending = await HI.addCampaign({ agencyId: 'A', userId: 'u1', mid: '777', days: 5, dailyTarget: 10, startDate: '2026-10-14', endDate: '2026-10-18' });
await HI.updateCampaign(f1._key, { status: 'active', changeRequest: { to: '찰리/카키', by: 'a' } });
assert.deepEqual(await HI.forceStopMid('777', '2026-10-14'), { stopped: 1, requeued: 1 });
const fs1 = tree.hi.campaigns.live[f1._key];
assert.equal(fs1.status, 'force_stopped');
assert.equal(fs1.origEndDate, '2026-10-19');
assert.equal(fs1.forceStoppedAt, '2026-10-14');
assert.equal(fs1.days, 10, '원 캠페인 일수(금액) 그대로');
assert.equal(HI.isBillable(fs1), true, '강제종료도 정산 대상');
assert.equal(tree.hi.campaigns.live[fPending._key].status, 'pending', '승인 전 캠페인은 안 건드림');
const rq = Object.entries(tree.hi.campaigns.live).find(([k, v]) => v.isRequeue && v.mid === '777');
assert.ok(rq, '재접수 캠페인 생성');
assert.equal(rq[1].status, 'requeue');
assert.equal(rq[1].startDate, '2026-10-15');
assert.equal(rq[1].endDate, '2026-10-19');
assert.equal(rq[1].days, 5, '남은 일수 = 내일~원래 종료일');
assert.equal(rq[1].changeTo, '찰리/카키', '변경 요청 상품을 재접수에 넘김');
assert.equal(tree.hi.campaign_keywords[rq[0]].search, 'fk', '검색키워드 이어받음');
assert.equal(HI.isBillable(rq[1]), false, '재접수는 정산 제외');
await HI.updateCampaign(f1._key, { status: 'active' });
assert.deepEqual(await HI.forceStopMid('777', '2026-10-14'), { stopped: 1, requeued: 0 }, '재접수는 1회만');
assert.equal(HI.shouldExpire(tree.hi.campaigns.live[f1._key], '2026-10-14'), false, '강제종료 당일은 유지');
assert.equal(HI.shouldExpire(tree.hi.campaigns.live[f1._key], '2026-10-15'), true);
await HI.expire([f1._key]);
assert.equal(tree.hi.campaigns.closed[f1._key].status, 'expired');
assert.equal(tree.hi.campaigns.closed[f1._key].endDate, '2026-10-14', '종료일 = 강제종료일');

// ── 일 목표 분할 표시: 승인 때 고정한 값이 있을 때만 ──
assert.equal(HI.dailySplitHtml({ dailyTarget: 100, days: 3 }), '', '승인 전(고정값 없음)은 표시 안 함');
const splitHtml = HI.dailySplitHtml({ dailyTarget: 100, days: 3, yupflTarget: 35, deductTarget: 90 });
assert.ok(splitHtml.includes('일반 35') && splitHtml.includes('유입플 35') && splitHtml.includes('차감 30'), splitHtml);

// ── 순위키워드 분류: 접수·승인 때 1회 저장, 이후 설정이 바뀌어도 유지 ──
const cats = [{ name: '맛집', keywords: ['맛집', '식당'] }, { name: '병원', keywords: ['피부과'] }];
assert.equal(kwCategoryOf('강남 맛집', cats), '맛집', '공백 무시 포함');
assert.equal(kwCategoryOf('강남피부과', cats), '병원');
assert.equal(kwCategoryOf('강남카페', cats), '', '해당 없음');
tree.hi.kw_categories = cats;
const k1 = await HI.addCampaign({ agencyId: 'A', userId: 'u1', mid: '222', rankKeyword: '역삼 식당', days: 1, dailyTarget: 1 });
assert.equal(tree.hi.campaigns.live[k1._key].category, undefined, '대기 상태엔 없음');
await HI.updateCampaign(k1._key, { status: 'accepted' });
assert.equal(tree.hi.campaigns.live[k1._key].category, '맛집', '접수 때 저장');
tree.hi.kw_categories = [{ name: '기타', keywords: ['식당'] }];
await HI.updateCampaign(k1._key, { status: 'active' });
assert.equal(tree.hi.campaigns.live[k1._key].category, '맛집', '이미 있으면 안 바꿈');

// 정산 금액: 업체 분류 전은 전체 × 리워드 단가, 분류 후엔 유입플 몫만 업체 단가(없으면 0 + missing)
const u1 = { unitPrice: 30, yupflPrices: { 풀스택: 20 } };
assert.deepEqual(HI.slotBill({ dailyTarget: 100, days: 2, yupflAmount: 5 }, u1), { amount: 6000, yupfl: 5, missing: [], byVendor: { '업체 분류 전': 5 } });
assert.deepEqual(HI.slotBill({ dailyTarget: 100, days: 2, yupflByVendor: { 풀스택: 28, 제이엔: 12 } }, u1),
  { amount: 60 * 2 * 30 + 28 * 2 * 20, yupfl: 28 * 2 * 20, missing: ['제이엔'], byVendor: { 풀스택: 28 * 2 * 20, 제이엔: 0 } });
assert.equal(HI.slotBill({ dailyTarget: 10, days: 1, unitPrice: 50, yupflByVendor: { 풀스택: 4 } }, u1).amount, 6 * 50 + 4 * 20, '캠페인 고정 단가 우선');

// 지출: 리워드 = 전체 − 유입플 − 차감 수량 × 리워드 원가, 유입플 업체별 × 업체 원가(없으면 0 + missing), 차감 = 정산 차감 금액
const costs = { reward: 10, yupfl: { 풀스택: 8 } };
assert.deepEqual(HI.slotCost({ dailyTarget: 100, days: 2, deductTarget: 20, deductAmount: 600, yupflByVendor: { 풀스택: 28, 제이엔: 12 } }, costs),
  { rewardQty: 200 - 80 - 20, reward: 1000, yupfl: { 풀스택: 448, 제이엔: 0 }, total: 1448, deduct: 600, missing: ['제이엔'] });
assert.deepEqual(HI.slotCost({ dailyTarget: 100, days: 1, yupflTarget: 40 }, costs).yupfl, { 풀스택: 320 }, '업체 분류 전 유입플은 풀스택');
assert.deepEqual(HI.slotCost({ dailyTarget: 10, days: 1 }, {}).missing, ['리워드']);
assert.equal(HI.slotCost({ dailyTarget: 10, days: 1 }, { reward: [{ name: '리워드', price: 7 }, { name: '블랙', price: 99 }] }).reward, 70, '리워드 원가는 첫 줄');

// 지출 고정은 없는 키만 — 이미 고정된 묶음은 덮지 않음
assert.equal(await HI.freezeCostSnapshots({ g1: { total: 100 } }), 1);
assert.equal(await HI.freezeCostSnapshots({ g1: { total: 999 }, g2: { total: 5 } }), 1);
assert.equal(tree.hi.cost_snapshots.g1.total, 100, '고정 금액 유지');

console.log('hi-store 자가검사 통과');
