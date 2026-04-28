/**
 * HA-STORE.JS — Firebase Realtime Database 버전
 * localStorage → Firebase로 교체
 * 기존 코드와 인터페이스 동일 (async/await 방식으로 변경)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, get, push, update, remove, onValue }
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

// ── Cloud Run 엔드포인트 ─────────────────────────────────────
const CLOUD_RUN = 'https://higher-auto-g4lrwwqw4q-du.a.run.app';

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:           'ha/slots',
  users:           'ha/users',
  notices:         'ha/notices',
  paid:            'ha/paid_slots',
  refunds:         'ha/refunds',
  adClassify:      'ha/ad_classify',
  settleSnapshots: 'ha/settle_snapshots',
  statusLog:       'ha/status_log',   // 담당자 상태 변경 이력
};

async function sendTelegram(message) {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const idToken = await user.getIdToken();
    await fetch(`${CLOUD_RUN}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({ message }),
    });
  } catch (e) {
    console.warn('텔레그램 알림 실패:', e);
  }
}

// (배치 큐 제거 — 개별/엑셀 알림을 호출부에서 각각 처리)

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

  async logout() {
    sessionStorage.removeItem('ha_current_user');
    try { await signOut(auth); } catch (_) {}
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
      slotType:      data.slotType      || '',
      startDate:     data.startDate     || '',
      endDate:       data.endDate       || '',
      storeName:     data.storeName     || '',
      rankKeyword:   data.rankKeyword   || '',
      url:           data.url           || '',
      mid:           data.mid           || '',
      workKeyword:   data.workKeyword   || '',
      memo:          data.memo          || '',
      days:          Number(data.days)        || 0,
      dailyTarget:   Number(data.dailyTarget) || 0,
      unitPrice:     unitPriceSnapshot,
      rank:          null,
      inflow:        0,
    };
    const newRef = await push(ref(db, PATHS.slots), newSlot);
    const result = { ...newSlot, _key: newRef.key };
    dispatch('ha:slots:updated');
    return result;
  },

  // ── 개별접수 텔레그램 알림 ───────────────────────────────
  async notifySingle(slot) {
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    // 슬롯 저장 단가 우선, 없으면 유저 DB 조회
    let unitPrice = (slot.unitPrice != null && slot.unitPrice > 0) ? slot.unitPrice : 0;
    if (!unitPrice) {
      try {
        const uSnap = await get(ref(db, PATHS.users));
        const users = snapToArray(uSnap);
        const u = users.find(u => u.username === slot.userId);
        unitPrice = u ? (u.unitPrice || 0) : 0;
      } catch(e) {}
    }
    const totalTarget = (slot.dailyTarget || 0) * (slot.days || 0);
    const amount      = totalTarget * unitPrice;
    const amountVat   = Math.round(amount * 1.1);
    await sendTelegram(
`📥 <b>새 캠페인 접수 (개별)</b>
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

  // ── 엑셀 일괄접수 텔레그램 알림 ─────────────────────────
  async notifyExcelBatch(slots) {
    if (!slots.length) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    // 슬롯별 저장 단가 우선 사용
    const agencyId    = slots[0].agencyId || '-';
    const totalTarget = slots.reduce((sum, s) => sum + (s.dailyTarget || 0) * (s.days || 0), 0);
    const amount      = slots.reduce((sum, s) => {
      const p = (s.unitPrice != null && s.unitPrice > 0) ? s.unitPrice : 0;
      return sum + (s.dailyTarget || 0) * (s.days || 0) * p;
    }, 0);
    const unitPrice   = slots[0].unitPrice || 0; // 표시용
    const amountVat   = Math.round(amount * 1.1);

    await sendTelegram(
`📊 <b>새 캠페인 접수 (엑셀)</b>
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
    // 상태(status) 변경이 포함된 경우 담당자 이력 누적 저장
    if (patch.status !== undefined) {
      const currentUser = this.getCurrentUser();
      if (currentUser) {
        const logEntry = {
          slotKey:   key,
          status:    patch.status,
          staffId:   currentUser.username,
          staffName: currentUser.name || currentUser.username,
          role:      currentUser.role || 'unknown',
          changedAt: new Date().toISOString(),
          ...(patch.rejectReason ? { rejectReason: patch.rejectReason } : {}),
        };
        await push(ref(db, `${PATHS.statusLog}/${key}`), logEntry);
      }
    }
    dispatch('ha:slots:updated');
  },

  async deleteSlot(key) {
    const todayStr = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();
    const slotSnap = await get(ref(db, `${PATHS.slots}/${key}`));
    if (slotSnap.exists()) {
      const slot = slotSnap.val();
      if (slot.createdAt) {
        const d = new Date(slot.createdAt);
        const slotDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (slotDate >= todayStr) {
          // 오늘 이후 접수 캠페인 삭제 시 정산 데이터 함께 정리
          await Promise.all([
            remove(ref(db, `${PATHS.paid}/${key}`)),
            remove(ref(db, `${PATHS.refunds}/${key}`)),
          ]);
        }
      }
    }
    await update(ref(db, `${PATHS.slots}/${key}`), { status: 'deleted' });
    dispatch('ha:slots:updated');
  },

  async approveSlot(key) {
    await this.updateSlot(key, { status: 'active' });
  },

  async rejectSlot(key, reason = '') {
    await this.updateSlot(key, { status: 'rejected', rejectReason: reason });
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

    // RTDB 프로필 저장 (password 제외)
    const newUser = {
      username,
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
    await update(ref(db, `${PATHS.users}/${key}`), patch);
    dispatch('ha:users:updated');
  },

  async deleteUser(key) {
    await remove(ref(db, `${PATHS.users}/${key}`));
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
      const base = latestSlots.filter(s =>
        s.status === 'active' || s.status === 'expired' || s.status === 'pending'
      );
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

  async saveAdClassifyResult(result) {
    // 최신 결과 저장
    await set(ref(db, `${PATHS.adClassify}/result`), result);
    // 일별 이력 저장 (yyMMdd 키)
    const now = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Seoul'}));
    const yy  = String(now.getFullYear()).slice(2);
    const mm  = String(now.getMonth()+1).padStart(2,'0');
    const dd  = String(now.getDate()).padStart(2,'0');
    const dateKey = yy+mm+dd;
    await set(ref(db, `${PATHS.adClassify}/daily/${dateKey}`), result);
  },

  async getAdClassifyDaily() {
    const snapshot = await get(ref(db, `${PATHS.adClassify}/daily`));
    if (!snapshot.exists()) return {};
    return snapshot.val(); // { "260323": result, "260324": result, ... }
  },

};

// ── 기본 데이터 ───────────────────────────────────────────────
function getDefaultNotices() {
  return [];
}

function getDefaultUsers() {
  return [];
}

// 전역 노출
window.HA = HA;

// 앱 시작 시 빈 DB면 기본 데이터 삽입
HA.seedIfEmpty();

export default HA;
