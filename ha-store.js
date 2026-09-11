/**
 * HA-STORE.JS — Firebase Realtime Database 스토어
 * 호출부 인터페이스는 동일하게 유지되며 내부는 async/await
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, query, orderByKey, orderByChild, equalTo, startAfter,
  set as _set, get as _get, push as _push, update as _update, remove as _remove, onValue as _onValue,
  onChildAdded, onChildChanged, onChildRemoved }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";

// ── Firebase 초기화 ──────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAF-Rn7tzIjQeyUDJKnvKTRNccsXUVsIjo",
  authDomain: "higherad-b9d62.firebaseapp.com",
  databaseURL: "https://higherad-b9d62-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "higherad-b9d62",
  storageBucket: "higherad-b9d62.firebasestorage.app",
  messagingSenderId: "938928195180",
  appId: "1:938928195180:web:8209b1e02a8caabe643a49",
  measurementId: "G-01T4L4ZGVV"
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// ── 인증 상태 복원 대기 래퍼 ─────────────────────────────────
// 새로고침 직후 세션 복원 전 get/onValue가 먼저 돌면 RTDB 규칙(auth != null)에 걸려 permission denied 발생 가능
const authReady = auth.authStateReady();

async function get(r)        { await authReady; return _get(r); }
async function set(r, v)     { await authReady; return _set(r, v); }
async function push(r, v)    { await authReady; return _push(r, v); }
async function update(r, v)  { await authReady; return _update(r, v); }
async function remove(r)     { await authReady; return _remove(r); }
function onValue(r, cb, ...args) {
  let unsub = () => {};
  let cancelled = false;
  authReady.then(() => { if (!cancelled) unsub = _onValue(r, cb, ...args); });
  return () => { cancelled = true; unsub(); };
}

// ── Cloud Run 엔드포인트 ─────────────────────────────────────
const CLOUD_RUN = 'https://higherad-auto-938928195180.asia-northeast3.run.app';

// higher_user 포털의 sendTelegram과 동일한 /notify 엔드포인트 — 같은 Firebase 프로젝트라
// 관리자 로그인 idToken도 그대로 통과됨.
async function sendTelegram(message) {
  try {
    await authReady;
    const idToken = await auth.currentUser.getIdToken();
    await fetch(`${CLOUD_RUN}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({ message }),
    });
  } catch (e) {
    console.warn('텔레그램 알림 실패:', e);
  }
}

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:           'ha/slots',
  users:           'ha/users',
  notices:         'ha/notices',
  paid:            'ha/paid_slots',
  refunds:         'ha/refunds',
  adClassify:      'ha/ad_classify',
  settleSnapshots: 'ha/settle_snapshots',
};

// ha/slots <-> ha/kimproSlots 양방향 동기화 시 상태값 매핑 — 두 시스템 상태값 어휘가 서로 달라서
// (ha: pending/accepted/active/expired/split/deleted, kp: pending/accepted/active/ended/paused/
// force_stopped/requeue/split) 글자 그대로 겹치는 값만 상태값도 같이 넘기고, 한쪽 전용 상태값은
// 반대편에 절대 안 보냄(예: kp의 force_stopped를 ha에 그대로 쓰면 ha가 모르는 값이라 필터·배지가 깨짐)
const HA_KP_SHARED_STATUSES = new Set(['pending', 'accepted', 'active', 'split']);

// 김프로 기능 데이터 전용(접수관리 ha/slots와 분리, 2026-09-10)
const KP_PATHS = {
  slots:           'ha/kimproSlots',
  paid:            'ha/kimproPaidSlots',
  refunds:         'ha/kimproRefunds',
  settleSnapshots: 'ha/kimproSettleSnapshots',
};

// ── 유틸: Firebase 스냅샷 → 배열 변환 ───────────────────────
function snapToArray(snapshot) {
  if (!snapshot.exists()) return [];
  const val = snapshot.val();
  return Object.entries(val).map(([key, data]) => ({ ...data, _key: key }));
}

// ── 내부 이벤트 버스 ─────────────────────────────────────────
function dispatch(event) {
  window.dispatchEvent(new CustomEvent(event));
}

// ── 실시간 슬롯 배열 공유 캐시 ────────────────────────────────
// 여러 구독자(대기/정산 배지 등)가 각자 getSlots()+구독을 따로 하면 초기 로드(5.8MB+)가 중복되므로, 배열 하나를 유지해 방송(broadcast)
let _liveSlotsPromise = null; // getSlots()+subscribeSlots() 초기 셋업 — 최초 구독자가 1회만 트리거
let _liveSlots         = [];  // 최신 배열(참조) — child 콜백이 계속 patch
const _liveSlotsSubs   = new Set();
let _liveSlotsNotifyPending = false;

function ensureLiveSlots() {
  if (!_liveSlotsPromise) {
    _liveSlotsPromise = (async () => {
      _liveSlots = await HA.getSlots();
      await HA.subscribeSlots(_liveSlots, {
        onAdded(slot)   { if (!_liveSlots.some(s => s._key === slot._key)) { _liveSlots.push(slot); notifyLiveSlots(); } },
        onChanged(slot) { const i = _liveSlots.findIndex(s => s._key === slot._key); if (i === -1) _liveSlots.push(slot); else _liveSlots[i] = slot; notifyLiveSlots(); },
        onRemoved(key)  { const i = _liveSlots.findIndex(s => s._key === key); if (i !== -1) _liveSlots.splice(i, 1); notifyLiveSlots(); },
      });
    })();
  }
  return _liveSlotsPromise;
}

function sortedLiveSlots() {
  return [..._liveSlots].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function notifyLiveSlots() {
  if (_liveSlotsNotifyPending) return;
  _liveSlotsNotifyPending = true;
  setTimeout(() => {
    _liveSlotsNotifyPending = false;
    const sorted = sortedLiveSlots();
    _liveSlotsSubs.forEach(cb => cb(sorted));
  }, 300);
}

// 구독 등록 — 최초 로드가 끝나면 즉시 1회, 이후 변경마다(디바운스되어) 호출됨. 반환값은 구독 해제 함수.
function subscribeLiveSlots(onChange) {
  let cancelled = false;
  ensureLiveSlots().then(() => { if (!cancelled) onChange(sortedLiveSlots()); });
  const wrapped = slots => { if (!cancelled) onChange(slots); };
  _liveSlotsSubs.add(wrapped);
  return () => { cancelled = true; _liveSlotsSubs.delete(wrapped); };
}

// ── 김프로(ha/kimproSlots) 실시간 슬롯 배열 공유 캐시 — 위쪽 패턴을 그대로 이식.
// 목록/정산/순위표 등 여러 호출부가 각자 getKpSlots()를 부르면 페이지 전환마다 ha/kimproSlots 전체가
// 중복 다운로드되므로, 세션 내 최초 호출자만 받고 이후는 캐시+구독으로 재사용한다.
let _liveKpSlotsPromise = null;
let _liveKpSlots         = [];
const _liveKpSlotsSubs   = new Set();
let _liveKpSlotsNotifyPending = false;

function ensureLiveKpSlots() {
  if (!_liveKpSlotsPromise) {
    _liveKpSlotsPromise = (async () => {
      _liveKpSlots = await HA.getKpSlots();
      await HA.subscribeKpSlots(_liveKpSlots, {
        onAdded(slot)   { if (!_liveKpSlots.some(s => s._key === slot._key)) { _liveKpSlots.push(slot); notifyLiveKpSlots(); } },
        onChanged(slot) { const i = _liveKpSlots.findIndex(s => s._key === slot._key); if (i === -1) _liveKpSlots.push(slot); else _liveKpSlots[i] = slot; notifyLiveKpSlots(); },
        onRemoved(key)  { const i = _liveKpSlots.findIndex(s => s._key === key); if (i !== -1) _liveKpSlots.splice(i, 1); notifyLiveKpSlots(); },
      });
    })();
  }
  return _liveKpSlotsPromise;
}

function sortedLiveKpSlots() {
  return [..._liveKpSlots].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function notifyLiveKpSlots() {
  if (_liveKpSlotsNotifyPending) return;
  _liveKpSlotsNotifyPending = true;
  setTimeout(() => {
    _liveKpSlotsNotifyPending = false;
    const sorted = sortedLiveKpSlots();
    _liveKpSlotsSubs.forEach(cb => cb(sorted));
  }, 300);
}

function subscribeLiveKpSlots(onChange) {
  let cancelled = false;
  ensureLiveKpSlots().then(() => { if (!cancelled) onChange(sortedLiveKpSlots()); });
  const wrapped = slots => { if (!cancelled) onChange(slots); };
  _liveKpSlotsSubs.add(wrapped);
  return () => { cancelled = true; _liveKpSlotsSubs.delete(wrapped); };
}

// 작은 노드(입금/충전여부·환불액·정산스냅샷 등, 전부 수백KB 이하) 전용 실시간 캐시 헬퍼 —
// onValue 리스너를 경로당 1개만 붙이고(최초 구독자가 트리거) 여러 구독자에게 공유. 정산관리.html처럼
// SPA 재방문마다 스크립트가 새로 실행되는 페이지에서 그때마다 onValue를 새로 붙이면 리스너가 방문
// 횟수만큼 누적되므로, 이 모듈(ha-store.js) 스코프에 한 번만 붙여 공유한다(ensureLiveKpSlots와 동일 취지).
function makeValueLiveCache(path, transform) {
  let started = false;
  let hasValue = false;
  let value;
  const subs = new Set();
  function start() {
    if (started) return;
    started = true;
    onValue(ref(db, path), snap => {
      value = transform(snap.exists() ? snap.val() : null);
      hasValue = true;
      subs.forEach(cb => cb(value));
    });
  }
  return function subscribe(cb) {
    subs.add(cb);
    if (hasValue) cb(value);
    start();
    return () => subs.delete(cb);
  };
}
const onPaidSetChangeShared            = makeValueLiveCache(PATHS.paid,            v => v ? new Set(Object.keys(v)) : new Set());
const onKpPaidSetChangeShared          = makeValueLiveCache(KP_PATHS.paid,         v => v ? new Set(Object.keys(v)) : new Set());
const onRefundsChangeShared            = makeValueLiveCache(PATHS.refunds,         v => v || {});
const onKpRefundsChangeShared          = makeValueLiveCache(KP_PATHS.refunds,      v => v || {});
const onSettleSnapshotsChangeShared    = makeValueLiveCache(PATHS.settleSnapshots, v => v || {});
const onKpSettleSnapshotsChangeShared  = makeValueLiveCache(KP_PATHS.settleSnapshots, v => v || {});

// ════════════════════════════════════════════════════════════
const HA = {

  // ── 현재 로그인 유저 ───────────────────────────────────────
  getCurrentUser() {
    return JSON.parse(sessionStorage.getItem('ha_current_user') || 'null');
  },

  // ── 로그인 ────────────────────────────────────────────────
  async login(username, password) {
    const email = `${username}@higherad.app`;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid  = cred.user.uid;

      // staff/admin 여부 확인 (ha/staff/{username})
      const staffSnap = await get(ref(db, `ha/staff/${username}`));
      if (staffSnap.exists()) {
        const s    = staffSnap.val();
        const user = { id: uid, username, role: s.role, name: s.name, agency: '-' };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }

      // 일반 회원 — Firebase RTDB 프로필 조회
      const snapshot = await get(ref(db, PATHS.users));
      const users    = snapToArray(snapshot);
      const found    = users.find(u => u.username === username);
      if (found) {
        if (found.approved === false) return { ok: false, reason: 'pending' };
        const user = { ...found, id: uid };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }

      await signOut(auth);
      return { ok: false };
    } catch (e) {
      return { ok: false };
    }
  },

  logout() {
    sessionStorage.removeItem('ha_current_user');
    signOut(auth).catch(() => {});
  },

  // ════════════════════════════════════════════════════════
  // 캠페인 CRUD
  // ════════════════════════════════════════════════════════

  async getSlots() {
    const snapshot = await get(ref(db, PATHS.slots));
    return snapToArray(snapshot).sort((a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
  },

  // getSlots() 이후 변경분만 child 이벤트로 구독(전체 재전송 방지). currentSlots의 최대 push key 이후만 "추가"로 취급해 기존 데이터 리플레이도 피함
  async subscribeSlots(currentSlots, { onAdded, onChanged, onRemoved } = {}) {
    await authReady;
    const afterKey = (currentSlots || []).reduce((m, s) => (s._key && (!m || s._key > m)) ? s._key : m, null);
    const base = ref(db, PATHS.slots);
    const addedRef = afterKey ? query(base, orderByKey(), startAfter(afterKey)) : base;
    const offAdded   = onChildAdded(addedRef, snap => onAdded   && onAdded({ ...snap.val(), _key: snap.key }));
    const offChanged = onChildChanged(base,   snap => onChanged && onChanged({ ...snap.val(), _key: snap.key }));
    const offRemoved = onChildRemoved(base,   snap => onRemoved && onRemoved(snap.key));
    return () => { offAdded(); offChanged(); offRemoved(); };
  },

  // ── 김프로(kimpro.kro.kr) 기능 데이터 전용 네임스페이스 ──────
  // ha/kimproSlots 등 — 접수관리(ha/slots)와는 완전히 분리된 별도 저장소(2026-09-10 결정: 데이터를 섞지 않고
  // 김프로.html이 독자적으로 소유). kimpro/slots(5,547건)를 그대로 복사해 마이그레이션 완료, ha/slots는 미접촉.
  async getKpSlotsByMid(mid) {
    const snap = await get(query(ref(db, KP_PATHS.slots), orderByChild('mid'), equalTo(mid)));
    return snapToArray(snap);
  },

  async getKpSlots() {
    const snap = await get(ref(db, KP_PATHS.slots));
    return snapToArray(snap).sort((a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
  },

  // 공유 캐시(ensureLiveKpSlots) 경유 — getKpSlots()와 인터페이스는 같지만 세션 내 최초 호출자만
  // ha/kimproSlots를 받고 이후는 캐시 재사용(getSlotsLive와 동일 패턴, 목록/정산/순위표 등에서 사용)
  async getKpSlotsLive() {
    await ensureLiveKpSlots();
    return sortedLiveKpSlots();
  },
  subscribeKpSlotsLive(callback) {
    return subscribeLiveKpSlots(callback);
  },

  async addKpSlot(data) {
    // 접수 시점 단가 스냅샷 — addSlot과 동일한 패턴(ha/users, 회원관리 데이터)을 그대로 사용.
    // 김프로 슬롯의 agencyId는 회원관리 username이 아니라 표시명("[단독]오렌지")이므로
    // ha/users의 agencyId/agency 필드와 매칭해야 함(예전엔 username과 잘못 비교해서 매칭이
    // 거의 항상 실패 — 단가 0원 버그의 근본 원인, 2026-09-10 수정). userId도 같은 매칭으로
    // 자동 채움(진행현황 등 병합 화면에서 검색·표시에 씀).
    let unitPriceSnapshot = data.unitPrice || 0;
    let resolvedUserId = data.userId || '';
    if (!unitPriceSnapshot || !resolvedUserId) {
      try {
        const uSnap = await get(ref(db, PATHS.users));
        const users = snapToArray(uSnap);
        const u = users.find(u => u.agencyId === (data.agencyId || '') || u.agency === (data.agencyId || ''));
        if (!unitPriceSnapshot) unitPriceSnapshot = u ? (u.unitPrice || 0) : 0;
        if (!resolvedUserId) resolvedUserId = u ? (u.username || '') : '';
      } catch(e) {}
    }
    const newSlot = {
      status:        'pending',
      createdAt:     data.createdAt || new Date().toISOString(),
      origin:        'kp', // 접수 출처(김프로 네이티브) — 진행현황 휴지통 분류에 사용, 절대 덮어쓰지 않음
      agencyId:      data.agencyId      || '',
      userId:        resolvedUserId,
      startDate:     data.startDate     || '',
      endDate:       data.endDate       || '',
      storeName:     data.storeName     || '',
      rankKeyword:   data.rankKeyword   || '',
      url:           data.url           || '',
      mid:           data.mid           || '',
      memo:          data.memo          || '',
      days:          Number(data.days)        || 0,
      dailyTarget:   Number(data.dailyTarget) || 0,
      searchKeyword: data.searchKeyword  || '',
      unitPrice:     unitPriceSnapshot,
    };
    const newRef = await push(ref(db, KP_PATHS.slots), newSlot);
    return { ...newSlot, _key: newRef.key };
  },

  async updateKpSlot(key, patch) {
    await update(ref(db, `${KP_PATHS.slots}/${key}`), patch);
    // ha/slots 역방향 동기화(신규, 2026-09-10) — updateSlot()의 ha/slots -> ha/kimproSlots 미러와
    // 반대 방향. 상태값이 없거나 공유값(HA_KP_SHARED_STATUSES)일 때만 필드 반영, kp 전용 상태
    // 전환(강제종료→종료 등)은 patch 통째로 무시 — endDate 등 일부 필드만 넘어가면 접수관리가
    // 자체 만료 로직으로 상태를 오판할 수 있어서(2026-09-11 수정, 강제종료가 "종료"로 잘못 보이던 문제).
    // 순수 김프로 네이티브 캠페인은 ha/slots에 대응 항목이 없다가 active/split 전환 시점에 처음 생성됨.
    try {
      const haSnap = await get(ref(db, `${PATHS.slots}/${key}`));
      if (haSnap.exists()) {
        if (!('status' in patch) || HA_KP_SHARED_STATUSES.has(patch.status)) {
          await update(ref(db, `${PATHS.slots}/${key}`), patch);
        }
      } else if (patch.status === 'active' || patch.status === 'split') {
        const kpSnap = await get(ref(db, `${KP_PATHS.slots}/${key}`));
        if (kpSnap.exists()) {
          const slot = kpSnap.val();
          await set(ref(db, `${PATHS.slots}/${key}`), { ...slot, searchKeyword: slot.searchKeyword || '' });
        }
      }
    } catch (e) { console.error('ha/slots 역방향 동기화 오류:', e); }
  },

  // ha/slots와 동일한 소프트 삭제(2026-09-10 변경 — 이전엔 하드 삭제였음, 진행현황.html 휴지통에서
  // 같이 보이고 복구할 수 있도록 통일). kpGetFiltered()가 이미 status:'deleted' 제외 처리 중.
  async deleteKpSlot(key) {
    const kpSnap = await get(ref(db, `${KP_PATHS.slots}/${key}`));
    if (!kpSnap.exists()) return;
    const slot = kpSnap.val();
    await update(ref(db, `${KP_PATHS.slots}/${key}`), {
      status: 'deleted', deletedAt: new Date().toISOString(), originalStatus: slot.status || 'pending',
    });
    // ha/slots 역방향 반영 — updateSlot()의 "ha에서 deleted면 kp 미러 remove"와 대칭되는 방향.
    // 미러된 캠페인(같은 key)이 있으면 소프트 삭제(ha 자체 삭제와 동일한 방식) 처리.
    try {
      const haSnap = await get(ref(db, `${PATHS.slots}/${key}`));
      if (haSnap.exists()) {
        await update(ref(db, `${PATHS.slots}/${key}`), {
          status: 'deleted', deletedAt: new Date().toISOString(), originalStatus: haSnap.val().status || 'pending',
        });
      }
    } catch (e) { console.error('ha/slots 역방향 삭제 동기화 오류:', e); }
  },

  async restoreKpSlot(key) {
    const kpSnap = await get(ref(db, `${KP_PATHS.slots}/${key}`));
    if (!kpSnap.exists()) return;
    const slot = kpSnap.val();
    // updateKpSlot을 거쳐야 ha/slots 역방향 동기화(deleteKpSlot의 소프트삭제와 대칭)까지 같이 반영됨
    await this.updateKpSlot(key, { status: slot.originalStatus || 'pending', deletedAt: null, originalStatus: null });
  },

  // 휴지통 보관기간 만료/수동 영구삭제용 — 되돌릴 수 없음
  async permanentDeleteKpSlot(key) {
    await remove(ref(db, `${KP_PATHS.slots}/${key}`));
  },

  // getKpSlots() 이후 변경분만 child 단위로 구독(subscribeSlots와 동일 패턴)
  async subscribeKpSlots(currentSlots, { onAdded, onChanged, onRemoved } = {}) {
    await authReady;
    const afterKey = (currentSlots || []).reduce((m, s) => (s._key && (!m || s._key > m)) ? s._key : m, null);
    const base = ref(db, KP_PATHS.slots);
    const addedRef = afterKey ? query(base, orderByKey(), startAfter(afterKey)) : base;
    const offAdded   = onChildAdded(addedRef, snap => onAdded   && onAdded({ ...snap.val(), _key: snap.key }));
    const offChanged = onChildChanged(base,   snap => onChanged && onChanged({ ...snap.val(), _key: snap.key }));
    const offRemoved = onChildRemoved(base,   snap => onRemoved && onRemoved(snap.key));
    return () => { offAdded(); offChanged(); offRemoved(); };
  },

  // 강제종료/키워드변경 처리 목록(ha/kimproBizfitStop, ha/kimproBizfitKeyword) — raw snapshot 반환
  async getKpDoc(path) {
    return get(ref(db, path));
  },
  async setKpDoc(path, val) {
    return set(ref(db, path), val);
  },
  // 멀티패스 업데이트(키에 '/' 허용, 값 null이면 그 위치 삭제) — 예약 분할 현황 취소 등 여러 경로를 한 번에 갱신할 때
  async updateKpDoc(path, patch) {
    return update(ref(db, path), patch);
  },

  // ── 김프로 정산관리(ha/kimproPaidSlots, ha/kimproRefunds, ha/kimproSettleSnapshots) ──
  // 접수관리 정산(ha/paid_slots, ha/refunds, ha/settle_snapshots)과 완전히 분리된 별도 노드.
  async getKpPaidSet() {
    const snap = await get(ref(db, KP_PATHS.paid));
    if (!snap.exists()) return new Set();
    return new Set(Object.keys(snap.val()));
  },
  async setKpPaid(key, val) {
    if (val) await set(ref(db, `${KP_PATHS.paid}/${key}`), true);
    else await remove(ref(db, `${KP_PATHS.paid}/${key}`));
  },
  async getKpRefunds() {
    const snap = await get(ref(db, KP_PATHS.refunds));
    return snap.exists() ? snap.val() : {};
  },
  async setKpRefundAmount(key, amount) {
    if (!amount || amount <= 0) await remove(ref(db, `${KP_PATHS.refunds}/${key}`));
    else await set(ref(db, `${KP_PATHS.refunds}/${key}`), amount);
  },
  async saveKpSettleSnapshot(snapKey, data, force = false) {
    const path = `${KP_PATHS.settleSnapshots}/${snapKey}`;
    if (!force) {
      const existing = await get(ref(db, path));
      if (existing.exists()) return;
    }
    await set(ref(db, path), { ...data, savedAt: new Date().toISOString() });
  },
  async deleteKpSettleSnapshot(snapKey) {
    await remove(ref(db, `${KP_PATHS.settleSnapshots}/${snapKey}`));
  },
  async getAllKpSettleSnapshots() {
    const snap = await get(ref(db, KP_PATHS.settleSnapshots));
    if (!snap.exists()) return {};
    const result = {};
    snap.forEach(node => { result[node.key] = node.val(); });
    return result;
  },

  // 접수 시점엔 김프로에 미러하지 않음 — updateSlot()의 자가치유 폴백(status가 active/split일 때만
  // 최초 미러 생성)이 승인/예약 시점에 만들어줌. "승인 전엔 김프로에 안 보여야 한다"는 요청(2026-09-11).
  async addSlot(data) {
    // 접수 시점 단가 스냅샷: userId로 현재 단가 조회 후 슬롯에 저장
    let unitPriceSnapshot = 0;
    try {
      const uSnap = await get(ref(db, PATHS.users));
      const users = snapToArray(uSnap);
      const u = users.find(u => u.username === (data.userId || ''));
      unitPriceSnapshot = u ? (u.unitPrice || 0) : 0;
    } catch(e) {}

    const newSlot = {
      status:        'pending',
      // 엑셀 일괄접수는 병렬 전송이라 서버 도착 순서≠엑셀 행순서 — 호출부가 행 인덱스로 어긋낸
      // createdAt을 넘기면 그대로 신뢰(위조 이득 없는 값이라 예외 허용, higher_user와 동일 패턴)
      createdAt:     data.createdAt || new Date().toISOString(),
      origin:        'ha', // 접수 출처(접수관리) — 김프로 미러/휴지통 분류에 사용, 절대 덮어쓰지 않음
      agencyId:      data.agencyId      || '',
      userId:        data.userId        || '',
      startDate:     data.startDate     || '',
      endDate:       data.endDate       || '',
      storeName:     data.storeName     || '',
      rankKeyword:   data.rankKeyword   || '',
      url:           data.url           || '',
      mid:           data.mid           || '',
      memo:          data.memo          || '',
      days:          Number(data.days)        || 0,
      dailyTarget:   Number(data.dailyTarget) || 0,
      unitPrice:     unitPriceSnapshot,
    };
    const newRef = await push(ref(db, PATHS.slots), newSlot);
    const result = { ...newSlot, _key: newRef.key };
    dispatch('ha:slots:updated');
    return result;
  },

  // ── 개별접수 텔레그램 알림 (higher_user 포털 notifySingle과 동일 포맷) ──
  async notifySingle(slot, opts = {}) {
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const unitPrice   = slot.unitPrice || 0;
    const totalTarget = (slot.dailyTarget || 0) * (slot.days || 0);
    const amount      = totalTarget * unitPrice;
    const amountVat   = Math.round(amount * 1.1);
    const label = opts.label || '개별';
    await sendTelegram(
`📥 <b>새 캠페인 접수 (${label})</b>
━━━━━━━━━━━━━━━━
• 대행사: ${slot.agencyId}
• 캠페인 수: 1건
• 전체 목표: ${totalTarget.toLocaleString()}개
• 단가: ${unitPrice.toLocaleString()}원
• 금액: ${amount.toLocaleString()}원(VAT 별도)
• 입금액: ${amountVat.toLocaleString()}원 (VAT 포함)
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  // ── 엑셀 일괄접수 텔레그램 알림 (higher_user 포털 notifyExcelBatch와 동일 포맷) ──
  async notifyExcelBatch(slots, opts = {}) {
    if (!slots.length) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const agencyId    = slots[0].agencyId || '-';
    const totalTarget = slots.reduce((sum, s) => sum + (s.dailyTarget || 0) * (s.days || 0), 0);
    const amount      = slots.reduce((sum, s) => sum + (s.dailyTarget || 0) * (s.days || 0) * (s.unitPrice || 0), 0);
    const unitPrice   = slots[0].unitPrice || 0;
    const amountVat   = Math.round(amount * 1.1);
    const label = opts.label || '엑셀';
    await sendTelegram(
`📊 <b>새 캠페인 접수 (${label})</b>
━━━━━━━━━━━━━━━━
• 대행사: ${agencyId}
• 캠페인 수: ${slots.length}건
• 전체 목표: ${totalTarget.toLocaleString()}개
• 단가: ${unitPrice.toLocaleString()}원
• 금액: ${amount.toLocaleString()}원(VAT 별도)
• 입금액: ${amountVat.toLocaleString()}원 (VAT 포함)
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  async updateSlot(key, patch) {
    await update(ref(db, `${PATHS.slots}/${key}`), patch);
    dispatch('ha:slots:updated');

    // ha/kimproSlots 동기화(편도) — 접수관리 승인 시 김프로 어드민 쪽에서도 리스트로 보이게 함.
    try {
      const kpSnap = await get(ref(db, `${KP_PATHS.slots}/${key}`));
      if (kpSnap.exists()) {
        if (patch.status === 'deleted') {
          await remove(ref(db, `${KP_PATHS.slots}/${key}`));
        } else if (!('status' in patch) || HA_KP_SHARED_STATUSES.has(patch.status)) {
          // 상태값이 없거나 공유 상태값일 때만 필드 반영 — ha 전용 상태 전환은 patch 통째로 무시
          // (kp 전용 상태값으로의 전환은 endDate 등 동반 필드까지 새어나가면 반대편이 오판할 수 있음)
          await update(ref(db, `${KP_PATHS.slots}/${key}`), patch);
        }
      } else if (patch.status === 'active' || patch.status === 'split') {
        // addSlot()은 접수 시점에 미러를 안 만듦 — 승인(active)/예약(split) 시점에 여기서 처음
        // 생성됨. 그 전(pending 상태에서의 일반 필드 수정 등)까지는 절대 만들지 않음(요청사항: 접수는
        // 승인 전까지 김프로에 안 보여야 함).
        const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
        if (slotSnap.exists()) {
          const slot = slotSnap.val();
          await set(ref(db, `${KP_PATHS.slots}/${key}`), {
            ...slot,
            searchKeyword: slot.searchKeyword || '',
          });
        }
      }
    } catch (e) { console.error('ha/kimproSlots 동기화 오류:', e); }
  },

  async deleteSlot(key) {
    const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
    if (!slotSnap.exists()) return;
    const slot = slotSnap.val();
    await this.updateSlot(key, {
      status:         'deleted',
      deletedAt:      new Date().toISOString(),
      originalStatus: slot.status || 'pending',
    });
  },

  async restoreSlot(key) {
    const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
    if (!slotSnap.exists()) return;
    const slot = slotSnap.val();
    await this.updateSlot(key, {
      status:         slot.originalStatus || 'pending',
      deletedAt:      null,
      originalStatus: null,
    });
  },

  // 임의 경로 조회(raw snapshot 반환) — 충전하기(ha/bizfit_charge 목록) 등 슬롯 CRUD에 안 걸리는 단순 조회용
  async getDoc(path) {
    return get(ref(db, path));
  },

  async permanentDeleteSlot(key) {
    await Promise.all([
      remove(ref(db, `${PATHS.paid}/${key}`)),
      remove(ref(db, `${PATHS.refunds}/${key}`)),
      remove(ref(db, `${PATHS.slots}/${key}`)),
    ]);
    dispatch('ha:slots:updated');
  },

  async approveSlot(key, extra = {}) {
    await this.updateSlot(key, { status: 'active', ...extra });
  },

  // 종료일 지난 active 캠페인 일괄 expired 전환 전용 — status-only patch는 updateSlot의 kimpro 분기에서 어차피 아무 것도 안 쓰므로(kimpro는 승인 이후 status 미추적), 그 확인을 생략하고 메인 db만 multi-path update 한 번으로 처리(N개 기준 호출 수 3N → 1)
  async expireSlots(keys) {
    if (!keys.length) return;
    const patch = {};
    keys.forEach(k => { patch[`${k}/status`] = 'expired'; });
    await update(ref(db, PATHS.slots), patch);
    dispatch('ha:slots:updated');
  },

  // ════════════════════════════════════════════════════════
  // 회원 CRUD
  // ════════════════════════════════════════════════════════

  async getUsers() {
    const snapshot = await get(ref(db, PATHS.users));
    if (!snapshot.exists()) return getDefaultUsers();
    return snapToArray(snapshot);
  },

  async addUser(data) {
    const agencyName = data.agency || '';
    const username   = data.username || '';
    const password   = data.password || '';

    // Firebase Auth 계정 생성 (서버 경유)
    try {
      const idToken = await auth.currentUser.getIdToken();
      await fetch(`${CLOUD_RUN}/create-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      console.warn('Firebase Auth 계정 생성 실패:', e);
    }

    // RTDB 프로필 저장 (관리자 확인용 password 포함)
    const newUser = {
      username,
      password,
      agency:     agencyName,
      agencyId:   agencyName,
      role:       'member',
      unitPrice:  Number(data.unitPrice) || 0,
      memo:       data.memo       || '',
      createdAt:  new Date().toISOString().slice(0, 10),
      approved:   data.approved !== undefined ? data.approved : false,
    };
    const newRef = await push(ref(db, PATHS.users), newUser);
    dispatch('ha:users:updated');
    return { ...newUser, _key: newRef.key };
  },

  async updateUser(key, patch) {
    // 비밀번호 변경 시 Firebase Auth도 업데이트
    if (patch.password) {
      try {
        const snap     = await get(ref(db, `${PATHS.users}/${key}`));
        const username = snap.exists() ? snap.val().username : null;
        if (username) {
          const idToken = await auth.currentUser.getIdToken();
          await fetch(`${CLOUD_RUN}/create-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ username, password: patch.password }),
          });
        }
      } catch (e) {
        console.warn('Firebase Auth 비밀번호 업데이트 실패:', e);
      }
      await update(ref(db, `${PATHS.users}/${key}`), patch);
    } else {
      await update(ref(db, `${PATHS.users}/${key}`), patch);
    }
    dispatch('ha:users:updated');
  },

  async deleteUser(key) {
    const snap = await get(ref(db, `${PATHS.users}/${key}`));
    const username = snap.exists() ? snap.val().username : null;

    await remove(ref(db, `${PATHS.users}/${key}`));

    // Firebase Auth 계정도 함께 삭제 (재가입 시 "이미 사용 중인 아이디" 방지)
    if (username) {
      try {
        const idToken = await auth.currentUser.getIdToken();
        await fetch(`${CLOUD_RUN}/delete-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ username }),
        });
      } catch (e) {
        console.warn('Firebase Auth 계정 삭제 실패:', e);
      }
    }

    dispatch('ha:users:updated');
  },

  // ════════════════════════════════════════════════════════
  // 공지사항 CRUD
  // ════════════════════════════════════════════════════════

  async getNotices() {
    const snapshot = await get(ref(db, PATHS.notices));
    if (!snapshot.exists()) return getDefaultNotices();
    return snapToArray(snapshot).sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );
  },

  async addNotice(data) {
    const n = {
      title:   data.title   || '',
      content: data.content || '',
      author:  'admin',
      date:    new Date().toISOString().replace('T', ' ').slice(0, 19),
      views:   0,
      pinned:  !!data.pinned,
    };
    const newRef = await push(ref(db, PATHS.notices), n);
    dispatch('ha:notices:updated');
    return { ...n, _key: newRef.key };
  },

  async updateNotice(key, patch) {
    await update(ref(db, `${PATHS.notices}/${key}`), patch);
    dispatch('ha:notices:updated');
  },

  async deleteNotice(key) {
    await remove(ref(db, `${PATHS.notices}/${key}`));
    dispatch('ha:notices:updated');
  },

  // ════════════════════════════════════════════════════════
  // 정산 상태
  // ════════════════════════════════════════════════════════

  async getPaidSet() {
    const snapshot = await get(ref(db, PATHS.paid));
    if (!snapshot.exists()) return new Set();
    return new Set(Object.keys(snapshot.val()));
  },

  async setPaid(key, val) {
    if (val) {
      await set(ref(db, `${PATHS.paid}/${key}`), true);
    } else {
      await remove(ref(db, `${PATHS.paid}/${key}`));
    }
  },

  // ════════════════════════════════════════════════════════
  // 환불 관리
  // ════════════════════════════════════════════════════════

  async getRefunds() {
    const snapshot = await get(ref(db, PATHS.refunds));
    if (!snapshot.exists()) return {};
    return snapshot.val();
  },

  async setRefundAmount(key, amount) {
    if (!amount || amount <= 0) {
      await remove(ref(db, `${PATHS.refunds}/${key}`));
    } else {
      await set(ref(db, `${PATHS.refunds}/${key}`), amount);
    }
  },

  // ════════════════════════════════════════════════════════
  // 정산 스냅샷 (과거 날짜 데이터 고정 저장)
  // 경로: ha/settle_snapshots/{date}/{safeAgencyId}__{safeUserId}
  // ════════════════════════════════════════════════════════

  // 단일 행 스냅샷 저장
  // snapKey: "safeTimeKey__safeAgencyId__safeUserId" 형태의 플랫 키
  async saveSettleSnapshot(snapKey, data, force = false) {
    const path = `${PATHS.settleSnapshots}/${snapKey}`;
    if (!force) {
      const existing = await get(ref(db, path));
      if (existing.exists()) return;
    }
    await set(ref(db, path), { ...data, savedAt: new Date().toISOString() });
  },

  // 정산완료 취소 시 스냅샷 삭제
  // snapKey: "safeTimeKey__safeAgencyId__safeUserId"
  async deleteSettleSnapshot(snapKey) {
    const path = `${PATHS.settleSnapshots}/${snapKey}`;
    await remove(ref(db, path));
  },

  // 전체 settle_snapshots 로드 → { "safeTimeKey__safeAgencyId__safeUserId": snap } 형태
  async getAllSettleSnapshots() {
    const snap = await get(ref(db, PATHS.settleSnapshots));
    if (!snap.exists()) return {};
    const result = {};
    snap.forEach(node => {
      const key  = node.key;
      const data = node.val();
      if (!result[key] || (data.confirmedAt && data.confirmedAt > (result[key].confirmedAt||''))) {
        result[key] = data;
      }
    });
    return result;
  },

  // ════════════════════════════════════════════════════════
  // 대시보드 집계
  // ════════════════════════════════════════════════════════

  // slots: 호출부가 이미 갖고 있는 getSlots() 결과 — 여기서 다시 받으면 ha/slots(5.8MB+)가
  // 이중으로 다운로드됨(index.html의 renderDashboard가 대시보드 진입마다 같이 getSlots()도 부름).
  getDashboardStats(slots) {
    const today  = new Date(); today.setHours(0,0,0,0);
    const in3    = new Date(today); in3.setDate(today.getDate() + 3);

    const active   = slots.filter(s => s.status === 'active');
    const pending  = slots.filter(s => s.status === 'pending');
    const rejected = slots.filter(s => s.status === 'rejected');
    const expiring = active.filter(s => {
      const d = new Date(s.endDate);
      return d <= in3 && d >= today;
    });
    const agencySet = new Set(active.map(s => s.agencyId));

    return {
      activeAgencies: agencySet.size,
      activeSlots:    active.length,
      expiringSoon:   expiring.length,
      pending:        pending.length,
      rejected:       rejected.length,
    };
  },

  // 공유 캐시(ensureLiveSlots) 경유 — getSlots()와 인터페이스는 같지만 세션 내 최초 호출자만 ha/slots(6MB+)를 받고 이후는 캐시 재사용해 페이지 전환마다 중복 다운로드되지 않음
  async getSlotsLive() {
    await ensureLiveSlots();
    return sortedLiveSlots();
  },

  // ════════════════════════════════════════════════════════
  // 실시간 리스너 (어드민 접수관리 배지 등에 사용)
  // ════════════════════════════════════════════════════════

  // 공유 캐시(위쪽 subscribeLiveSlots) 구독 — 콜백엔 지금까지와 동일하게 "현재 전체 슬롯 배열"을
  // 넘겨줘서 호출부(index.html) 수정 불필요.
  onSlotsChange(callback) {
    return subscribeLiveSlots(callback);
  },

  // 회원 실시간 리스너 (회원관리 배지용)
  onUsersChange(callback) {
    return onValue(ref(db, PATHS.users), snapshot => {
      callback(snapToArray(snapshot));
    });
  },

  // 정산 실시간 리스너 — slots+paid_slots를 (접수일+대행사+유저ID) 단위로 묶어 미정산 행 개수를 콜백.
  // slots는 onSlotsChange와 같은 공유 캐시(subscribeLiveSlots) 재사용. paid_slots는 121KB로 작고 키가 push 순서가 아니라 startAfter 필터 이득이 없어 value 리스너 유지
  onSettlementsChange(callback) {
    let latestSlots = [];
    let latestPaid  = new Set();

    function getMinuteKey(isoStr) {
      if (!isoStr) return 'unknown';
      const d = new Date(isoStr);
      const yyyy = d.getFullYear();
      const mo   = String(d.getMonth()+1).padStart(2,'0');
      const dd   = String(d.getDate()).padStart(2,'0');
      const hh   = String(d.getHours()).padStart(2,'0');
      const mn   = String(d.getMinutes()).padStart(2,'0');
      return `${yyyy}-${mo}-${dd} ${hh}:${mn}`;
    }

    function notify() {
      // 정산관리.html의 getFiltered()와 동일한 상태만 집계 대상으로 삼는다.
      // (그 외 상태(rejected 등)를 포함하면 같은 분+대행사+유저 그룹에 섞여 들어가
      //  테이블엔 전부 정산완료로 보여도 배지가 미정산으로 계속 남는 버그가 있었음)
      const base = latestSlots.filter(s => ['active','accepted','expired','pending'].includes(s.status));
      const map = {};
      base.forEach(s => {
        const t = getMinuteKey(s.createdAt);
        const k = `${t}||${s.agencyId || '-'}||${s.userId || '-'}`;
        if (!map[k]) map[k] = { slots: [] };
        map[k].slots.push(s);
      });
      // 그룹 중 캠페인이 하나라도 미정산이면 미정산 행으로 카운트
      const unpaidRows = Object.values(map).filter(g =>
        !g.slots.every(s => latestPaid.has(s._key))
      );
      callback(unpaidRows.length);
    }

    const unsubSlots = subscribeLiveSlots(slots => { latestSlots = slots; notify(); });
    const unsubPaid = onValue(ref(db, PATHS.paid), snap => {
      latestPaid = snap.exists() ? new Set(Object.keys(snap.val())) : new Set();
      notify();
    });

    return () => { unsubSlots(); unsubPaid(); };
  },

  // 정산관리.html 전용 실시간 리스너 — 슬롯(수 MB)은 재다운로드하지 않고 정산 부가 데이터
  // (입금/충전 여부·환불액·스냅샷, 전부 수백KB 이하)만 구독해 다른 세션에서 입금/충전/환불을 처리하면
  // 새로고침 없이 반영되게 함(2026-09-11, "다른 곳에서 충전 눌렀는데 새로고침 전까지 안 보임" 수정).
  // 리스너 자체는 makeValueLiveCache로 경로당 1개만 공유(정산관리.html은 SPA 재방문마다 스크립트가
  // 새로 실행돼 매번 새로 구독하므로, 여기서 공유 안 하면 방문 횟수만큼 onValue가 누적됨)
  onPaidSetChange(callback)           { return onPaidSetChangeShared(callback); },
  onKpPaidSetChange(callback)         { return onKpPaidSetChangeShared(callback); },
  onRefundsChange(callback)           { return onRefundsChangeShared(callback); },
  onKpRefundsChange(callback)         { return onKpRefundsChangeShared(callback); },
  onSettleSnapshotsChange(callback)   { return onSettleSnapshotsChangeShared(callback); },
  onKpSettleSnapshotsChange(callback) { return onKpSettleSnapshotsChangeShared(callback); },

  // ════════════════════════════════════════════════════════
  // 초기 데이터 시드 (Firebase가 비어있을 때 한 번만 실행)
  // ════════════════════════════════════════════════════════

  async seedIfEmpty() {
    const noticeSnap = await get(ref(db, PATHS.notices));
    if (!noticeSnap.exists()) {
      const defaults = getDefaultNotices();
      for (const n of defaults) {
        await push(ref(db, PATHS.notices), n);
      }
    }
    const userSnap = await get(ref(db, PATHS.users));
    if (!userSnap.exists()) {
      const defaults = getDefaultUsers();
      for (const u of defaults) {
        await push(ref(db, PATHS.users), u);
      }
    }
  },

  // ════════════════════════════════════════════════════════
  // 광고 분류
  // ════════════════════════════════════════════════════════

  async getAdClassify() {
    const snapshot = await get(ref(db, PATHS.adClassify));
    if (!snapshot.exists()) return { groups: null, result: null };
    return snapshot.val();
  },

  async saveAdClassifyGroups(groups) {
    await set(ref(db, `${PATHS.adClassify}/groups`), groups);
  },

  async getAdClassifyDaily() {
    const snapshot = await get(ref(db, `${PATHS.adClassify}/daily`));
    if (!snapshot.exists()) return {};
    return snapshot.val(); // { "260323": result, "260324": result, ... }
  },

  // 실시간 탭 전용 — 일별 아카이브(daily/*)와 분리된 별도 경로, 조회할 때마다 덮어씀
  async getAdClassifyRealtime() {
    const snapshot = await get(ref(db, `${PATHS.adClassify}/realtime`));
    if (!snapshot.exists()) return null;
    return snapshot.val();
  },

  async saveAdClassifyRealtime(result) {
    await set(ref(db, `${PATHS.adClassify}/realtime`), result);
  },

};

// ── 기본 데이터 ───────────────────────────────────────────────
function getDefaultNotices() {
  return [];
}

function getDefaultUsers() {
  return [];
}

// 페이지 코드가 Firebase SDK를 직접 import해서 쓰는 경우(예: 접수관리.html의 상품 설정)를 위해
// 인증 복원 대기 Promise를 노출 — get/set/onValue 호출 전에 await HA.authReady로 레이스 방지
HA.authReady = authReady;

// 전역 노출
window.HA = HA;

// 앱 시작 시 빈 DB면 기본 데이터 삽입
HA.seedIfEmpty().catch(() => {});

export default HA;
