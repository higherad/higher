/**
 * HA-STORE.JS — Firebase Realtime Database 버전
 * localStorage → Firebase로 교체
 * 기존 코드와 인터페이스 동일 (async/await 방식으로 변경)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, get, push, update, remove, onValue, child }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged }
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

// ── 텔레그램 알림 설정 ────────────────────────────────────────
const TELEGRAM = {
  token:   '8696324609:AAFo10CLRJiWdDahGtCqHfLKY16HsHZOnE8',
  chatIds: [
    '-5092397591',   // 관리자1
    // '여기에추가',   // 관리자2
    // '여기에추가',   // 관리자3
  ],
};

async function sendTelegram(message) {
  try {
    await Promise.all(
      TELEGRAM.chatIds.map(chatId =>
        fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        })
      )
    );
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

  SLOT_TYPES: ['리워드'],

  // ── 현재 로그인 유저 ───────────────────────────────────────
  getCurrentUser() {
    return JSON.parse(sessionStorage.getItem('ha_current_user') || 'null');
  },

  // ── 로그인 ────────────────────────────────────────────────
  async login(username, password) {
    // 어드민 계정
    if (username === 'admin' && password === 'admin1234') {
      const user = { id: 'admin', username: 'admin', role: 'admin', agency: '-' };
      sessionStorage.setItem('ha_current_user', JSON.stringify(user));
      return { ok: true, user };
    }
    // 일반 회원 — Firebase에서 조회
    try {
      const snapshot = await get(ref(db, PATHS.users));
      const users = snapToArray(snapshot);
      const found = users.find(u => u.username === username && u.password === password);
      if (found) {
        // 승인 대기 중인 계정 로그인 차단
        if (found.approved === false) {
          return { ok: false, reason: 'pending' };
        }
        const user = { ...found };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }
      return { ok: false };
    } catch (e) {
      console.error('login error', e);
      return { ok: false };
    }
  },

  logout() {
    sessionStorage.removeItem('ha_current_user');
  },

  // ════════════════════════════════════════════════════════
  // 슬롯 CRUD
  // ════════════════════════════════════════════════════════

  async getSlots() {
    const snapshot = await get(ref(db, PATHS.slots));
    return snapToArray(snapshot).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  },

  async addSlot(data) {
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
      compareUrl:    data.compareUrl    || '',
      compareMid:    data.compareMid    || '',
      workKeyword:   data.workKeyword   || '',
      sellerControl: data.sellerControl || '',
      memo:          data.memo          || '',
      days:          Number(data.days)        || 0,
      dailyTarget:   Number(data.dailyTarget) || 0,
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
    await sendTelegram(
`📥 <b>새 슬롯 접수 (개별)</b>
━━━━━━━━━━━━━━━━
• ${slot.agencyId} / ${slot.slotType}
• 업체명: ${slot.storeName}
• MID: ${slot.mid || '-'}
• 순위키워드: ${slot.rankKeyword || '-'}
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  // ── 엑셀 일괄접수 텔레그램 알림 ─────────────────────────
  async notifyExcelBatch(slots) {
    if (!slots.length) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    // 대행사 + 슬롯타입 조합별 집계
    const grouped = {};
    for (const s of slots) {
      const key = `${s.agencyId}||${s.slotType}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    const lines = Object.entries(grouped)
      .map(([key, cnt]) => {
        const [agency, type] = key.split('||');
        return `• ${agency} / ${type} / ${cnt}개`;
      })
      .join('\n');

    await sendTelegram(
`📊 <b>엑셀 일괄 접수 (총 ${slots.length}건)</b>
━━━━━━━━━━━━━━━━
${lines}
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  async updateSlot(key, patch) {
    await update(ref(db, `${PATHS.slots}/${key}`), patch);
    dispatch('ha:slots:updated');
  },

  async deleteSlot(key) {
    await remove(ref(db, `${PATHS.slots}/${key}`));
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
    const newUser = {
      username:   data.username   || '',
      password:   data.password   || '',
      agency:     agencyName,       // 회원 테이블의 업체명
      agencyId:   agencyName,       // 슬롯에서 참조하는 대행사 ID와 동일한 값
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
      author:  '관리자',
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

  // 특정 날짜의 스냅샷 전체 가져오기
  async getSettleSnapshots(date) {
    const snap = await get(ref(db, `${PATHS.settleSnapshots}/${date}`));
    if (!snap.exists()) return {};
    return snap.val(); // { "agencyId__userId": { slotCount, totalTarget, amount, paidAmount, refund, savedAt }, ... }
  },

  // 단일 행 스냅샷 저장 (이미 저장돼 있으면 덮어쓰지 않음 — force=true일 때만 덮어씀)
  async saveSettleSnapshot(date, agencyId, userId, data, force = false) {
    const safe = s => s.replace(/[.#$[\]/]/g, '_');
    const key  = `${safe(agencyId)}__${safe(userId)}`;
    const path = `${PATHS.settleSnapshots}/${date}/${key}`;
    if (!force) {
      const existing = await get(ref(db, path));
      if (existing.exists()) return; // 이미 저장된 과거 데이터는 건드리지 않음
    }
    await set(ref(db, path), { ...data, savedAt: new Date().toISOString() });
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

    function notify() {
      // 정산 대상 슬롯만 추려서 그룹핑 (정산관리.html의 getFiltered/groupByDateAgency 동일 로직)
      const base = latestSlots.filter(s =>
        s.status === 'active' || s.status === 'expired' || s.status === 'pending'
      );
      const map = {};
      base.forEach(s => {
        const d = (s.createdAt || '').slice(0, 10);
        const k = `${d}||${s.agencyId || '-'}||${s.userId || '-'}`;
        if (!map[k]) map[k] = { slots: [] };
        map[k].slots.push(s);
      });
      // 그룹 중 슬롯이 하나라도 미정산이면 미정산 행으로 카운트
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
  return [
    { username:'higher', password:'test1234', agency:'had1104', role:'member', unitPrice:50000, memo:'테스트 계정', createdAt:'2026-01-08' },
  ];
}

// 전역 노출
window.HA = HA;

// 앱 시작 시 빈 DB면 기본 데이터 삽입
HA.seedIfEmpty();

export default HA;
