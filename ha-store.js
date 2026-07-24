/**
 * HA-STORE.JS — Firebase Realtime Database 버전
 * localStorage → Firebase로 교체
 * 기존 코드와 인터페이스 동일 (async/await 방식으로 변경)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref,
  set as _set, get as _get, push as _push, update as _update, remove as _remove, onValue as _onValue }
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
// RTDB 규칙(auth != null)으로 인해 새로고침 직후 세션 복원 전에
// get/onValue가 먼저 실행되면 permission denied가 발생할 수 있음.
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
      new Date(b.createdAt) - new Date(a.createdAt)
    );
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
    // kimpro/slots 동기화 — 편도(kimpro 쪽 변경은 여기로 안 들어옴), 실패해도 무시
    // (fire-and-forget으로 두면 호출부가 await 후 곧바로 페이지 이동/탭 종료 시 씹힐 수 있어 반드시 await)
    try {
      const kpSnap = await get(ref(db, `${PATHS.kimproSlots}/${key}`));
      if (kpSnap.exists()) {
        if (patch.status === 'deleted') {
          // 접수관리에서 삭제(취소) — kimpro 쪽도 즉시 제거 (kimpro 자체 삭제와 동일하게 완전삭제)
          await remove(ref(db, `${PATHS.kimproSlots}/${key}`));
        } else {
          // 이미 kimpro에 있는 슬롯 — status는 최초 승인(active) 상태로 고정, 그 외 필드만 반영
          // (접수관리에서 이후 종료/일시중단 등으로 상태가 바뀌어도 kimpro 쪽 상태는 안 건드림)
          const { status, ...rest } = patch;
          if (Object.keys(rest).length) {
            await update(ref(db, `${PATHS.kimproSlots}/${key}`), rest);
          }
        }
      } else if (patch.status === 'active') {
        // 접수관리에서 승인(active) 처리된 시점에 최초로 kimpro에 전체 데이터 복사 — 접수관리에 있는 그대로 전달
        const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
        if (slotSnap.exists()) {
          const slot = slotSnap.val();
          await set(ref(db, `${PATHS.kimproSlots}/${key}`), {
            ...slot,
            searchKeyword: slot.searchKeyword || '',
          });
        }
      }
    } catch (e) {}
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

  async approveSlot(key) {
    await this.updateSlot(key, { status: 'active' });
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

  async getDashboardStats() {
    const slots = await this.getSlots();
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

  // ════════════════════════════════════════════════════════
  // 실시간 리스너 (어드민 접수관리 배지 등에 사용)
  // ════════════════════════════════════════════════════════

  onSlotsChange(callback) {
    return onValue(ref(db, PATHS.slots), snapshot => {
      const slots = snapToArray(snapshot).sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      callback(slots);
    });
  },

  // 회원 실시간 리스너 (회원관리 배지용)
  onUsersChange(callback) {
    return onValue(ref(db, PATHS.users), snapshot => {
      callback(snapToArray(snapshot));
    });
  },

  // 정산 실시간 리스너 — slots + paid_slots 를 함께 구독해
  // 정산관리 페이지와 동일하게 (접수일+대행사+유저ID) 단위로 묶은 뒤
  // 그룹 전체가 미정산인 행의 개수를 콜백으로 전달
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

    const unsubSlots = onValue(ref(db, PATHS.slots), snap => {
      latestSlots = snapToArray(snap).sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      notify();
    });

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
