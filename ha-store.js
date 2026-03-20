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
  apiKey: "AIzaSyCRnAMy3PyD0zracrwyo17hEZ-R40pAvt4",
  authDomain: "higherad-530c4.firebaseapp.com",
  databaseURL: "https://higherad-530c4-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "higherad-530c4",
  storageBucket: "higherad-530c4.firebasestorage.app",
  messagingSenderId: "1028078651420",
  appId: "1:1028078651420:web:71c8b8c5e69f0772d637d9"
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:   'ha/slots',
  users:   'ha/users',
  notices: 'ha/notices',
  paid:    'ha/paid_slots',
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

// ── 텔레그램 배치 큐 ─────────────────────────────────────────
const _telegramBatch = {
  queue: [],
  timer: null,
  DELAY: 5000,  // 5초 묶음 대기 (ms)
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
      status:       'pending',
      createdAt:    new Date().toISOString(),
      agencyId:     data.agencyId     || '',
      userId:       data.userId       || '',
      slotType:     data.slotType     || '',
      startDate:    data.startDate    || '',
      endDate:      data.endDate      || '',
      storeName:    data.storeName    || '',
      rankKeyword:  data.rankKeyword  || '',
      url:          data.url          || '',
      mid:          data.mid          || '',
      compareUrl:   data.compareUrl   || '',
      compareMid:   data.compareMid   || '',
      workKeyword:  data.workKeyword  || '',
      sellerControl:data.sellerControl|| '',
      memo:         data.memo         || '',
      days:         Number(data.days)        || 0,
      dailyTarget:  Number(data.dailyTarget) || 0,
      rank:         null,
      inflow:       0,
    };
    const newRef = await push(ref(db, PATHS.slots), newSlot);
    const result = { ...newSlot, _key: newRef.key };
    dispatch('ha:slots:updated');

    // ── 텔레그램 배치 알림 ──────────────────────────────────
    _telegramBatch.queue.push(newSlot);

    if (_telegramBatch.timer) clearTimeout(_telegramBatch.timer);

    _telegramBatch.timer = setTimeout(async () => {
      const batch = [..._telegramBatch.queue];
      _telegramBatch.queue = [];
      _telegramBatch.timer = null;

      const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

      // 대행사 + 슬롯타입 조합별 집계
      const grouped = {};
      for (const s of batch) {
        const key = `${s.agencyId}||${s.slotType}`;
        grouped[key] = (grouped[key] || 0) + 1;
      }

      const lines = Object.entries(grouped)
        .map(([key, cnt]) => {
          const [agency, type] = key.split('||');
          return `  • ${agency} / ${type} / ${cnt}개`;
        })
        .join('\n');

      await sendTelegram(
`📥 <b>새 슬롯 접수 (총 ${batch.length}개)</b>
━━━━━━━━━━━━━━━━
${lines}
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/index.html">어드민에서 확인하세요</a>`
      );
    }, _telegramBatch.DELAY);

    return result;
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
    const newUser = {
      username:   data.username   || '',
      password:   data.password   || '',
      agency:     data.agency     || '',
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
};

// ── 기본 데이터 ───────────────────────────────────────────────
function getDefaultNotices() {
  return [
    { title:'3월 결산 정산 일정 확인 바랍니다.', author:'관리자', date:'2026-03-18 11:27:28', views:13, pinned:true,  content:'3월 결산 정산은 3/31까지 완료 예정입니다.' },
    { title:'신규 서버 증설 작업 안내 (03/20)',  author:'관리자', date:'2026-03-17 13:36:34', views:73, pinned:false, content:'03/20 새벽 2~4시 서버 점검이 있습니다.' },
    { title:'회원사 등급 산정 기준 변경 공지',    author:'관리자', date:'2026-03-15 11:42:51', views:32, pinned:false, content:'2026년 2분기부터 등급 기준이 변경됩니다.' },
    { title:'슬롯 대량 신청 시 가이드 준수 요청', author:'관리자', date:'2026-03-12 18:38:13', views:44, pinned:false, content:'슬롯 10개 이상 신청 시 가이드를 준수해주세요.' },
    { title:'☆ 필독 공지사항 ☆',               author:'관리자', date:'2026-01-08 17:42:55', views:50, pinned:true,  content:'반드시 읽어주세요.' },
  ];
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
