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

// ── kimpro/slots 미러링 전용 계정 ────────────────────────────
// kimpro RTDB 규칙이 kimpro-access 계정만 허용(higher 로그인 세션은 permission denied) — 별도 App으로 로그인, 필요 시점까지 지연
const kimproMirrorApp = initializeApp(firebaseConfig, 'kimproMirror');
const kimproDb        = getDatabase(kimproMirrorApp);
const kimproMirrorAuth = getAuth(kimproMirrorApp);
let _kimproAuthReady = null;
function ensureKimproAuth() {
  if (!_kimproAuthReady) {
    _kimproAuthReady = signInWithEmailAndPassword(kimproMirrorAuth, 'kimpro-access@higherad.app', 'm0N7anwQIcPTIarfhWvkpBN0');
  }
  return _kimproAuthReady;
}

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

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:           'ha/slots',
  users:           'ha/users',
  notices:         'ha/notices',
  paid:            'ha/paid_slots',
  refunds:         'ha/refunds',
  adClassify:      'ha/ad_classify',
  settleSnapshots: 'ha/settle_snapshots',
  kimproSlots:     'kimpro/slots',
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

  // kimpro/slots에서 같은 MID 슬롯 조회(fullKeywordHistory용) — kimpro RTDB는 kimpro-access 계정만 허용해 kimproDb로 읽어야 함
  async getKimproSlotsByMid(mid) {
    try {
      await ensureKimproAuth();
      const snap = await _get(query(ref(kimproDb, PATHS.kimproSlots), orderByChild('mid'), equalTo(mid)));
      return snapToArray(snap);
    } catch (e) {
      console.error('kimpro/slots 조회 오류:', e);
      return [];
    }
  },

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
      createdAt:     new Date().toISOString(),
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

  async updateSlot(key, patch) {
    await update(ref(db, `${PATHS.slots}/${key}`), patch);
    dispatch('ha:slots:updated');
    // kimpro/slots 동기화(편도) — kimpro RTDB는 kimpro-access 계정만 허용해 kimproDb로 써야 함.
    // 실패를 조용히 삼키면 누락을 못 알아채므로 콘솔 로그 필수. fire-and-forget 금지, 반드시 await
    try {
      await ensureKimproAuth();
      const kpSnap = await get(ref(kimproDb, `${PATHS.kimproSlots}/${key}`));
      if (kpSnap.exists()) {
        if (patch.status === 'deleted') {
          // 접수관리에서 삭제(취소) — kimpro 쪽도 즉시 제거 (kimpro 자체 삭제와 동일하게 완전삭제)
          await remove(ref(kimproDb, `${PATHS.kimproSlots}/${key}`));
        } else {
          // 이미 kimpro에 있는 슬롯 — status는 최초 승인(active) 상태로 고정, 그 외 필드만 반영
          // (접수관리에서 이후 종료/일시중단 등으로 상태가 바뀌어도 kimpro 쪽 상태는 안 건드림)
          const { status, ...rest } = patch;
          if (Object.keys(rest).length) {
            await update(ref(kimproDb, `${PATHS.kimproSlots}/${key}`), rest);
          }
        }
      } else if (patch.status === 'active') {
        // 접수관리에서 승인(active) 처리된 시점에 최초로 kimpro에 전체 데이터 복사 — 접수관리에 있는 그대로 전달
        const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
        if (slotSnap.exists()) {
          const slot = slotSnap.val();
          await set(ref(kimproDb, `${PATHS.kimproSlots}/${key}`), {
            ...slot,
            searchKeyword: slot.searchKeyword || '',
          });
        }
      }
    } catch (e) { console.error('kimpro/slots 동기화 오류:', e); }
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
      // 정산관리.html의 groupByTimeAgency와 동일하게 분 단위 그룹핑
      const base = latestSlots.filter(s => s.status !== 'deleted');
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
