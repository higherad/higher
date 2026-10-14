/**
 * HI-STORE.JS — 관리자 사이트 데이터 저장소 (hi/ 구조)
 * 구조 정본: 루트 저장소 work/hi_migration/STRUCTURE.md
 *
 * 원칙
 * - 캠페인은 hi/campaigns/live(진행 중) · closed(종료·휴지통) 두 노드. 상태가 경계를 넘으면 이 파일이 원자적으로 옮김
 * - 키워드(검색·유입플·분할·이력)는 hi/campaign_keywords — 목록에는 없고 필요한 화면만 withKeywords로 붙임
 * - 페이지는 DB 경로를 직접 쓰지 않음. 새 기능이 경로가 필요하면 여기에 함수를 추가
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, query, orderByChild, orderByKey, equalTo, startAt, limitToLast,
  set as _set, get as _get, push as _push, update as _update, remove as _remove, onValue as _onValue,
  onChildAdded, onChildChanged, onChildRemoved, onDisconnect, goOffline, goOnline, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";

const app = initializeApp({
  apiKey: "AIzaSyAF-Rn7tzIjQeyUDJKnvKTRNccsXUVsIjo",
  authDomain: "higherad-b9d62.firebaseapp.com",
  databaseURL: "https://higherad-b9d62-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "higherad-b9d62",
  storageBucket: "higherad-b9d62.firebasestorage.app",
  messagingSenderId: "938928195180",
  appId: "1:938928195180:web:8209b1e02a8caabe643a49",
  measurementId: "G-01T4L4ZGVV",
});
const db   = getDatabase(app);
const auth = getAuth(app);

// bfcache 진입 시 브라우저가 소켓을 강제 종료하며 나는 WebSocket 에러 방지
window.addEventListener('pagehide', e => { if (e.persisted) goOffline(db); });
window.addEventListener('pageshow', e => { if (e.persisted) goOnline(db); });

// 새로고침 직후 세션 복원 전에 읽으면 규칙(auth != null)에 걸림 — 모든 접근은 authReady 이후
const authReady = auth.authStateReady();
async function get(r)       { await authReady; return _get(r); }
async function set(r, v)    { await authReady; return _set(r, v); }
async function update(r, v) { await authReady; return _update(r, v); }
async function remove(r)    { await authReady; return _remove(r); }
function onValue(r, cb) {
  let unsub = () => {}, cancelled = false;
  authReady.then(() => { if (!cancelled) unsub = _onValue(r, cb); });
  return () => { cancelled = true; unsub(); };
}

const CLOUD_RUN = 'https://higherad-auto-938928195180.asia-northeast3.run.app';

// 개발 중엔 localStorage hi_root='hi_test'로 테스트 데이터에 붙음 — 운영 기본값은 hi
const ROOT = (() => { try { return localStorage.getItem('hi_root') || 'hi'; } catch { return 'hi'; } })();
// 테스트 모드(hi 이외 루트)에선 실제로 돈·외부 시스템을 건드리는 서버 호출(비즈핏 접수·캐시 차감·충전·텔레그램·
// 애드로그 등 *.run.app)을 막음 — 데이터는 테스트 노드여도 이 호출들은 운영 비즈핏/텔레그램으로 나가기 때문.
// 읽기 전용 조회(등급 정보·순위표)만 허용
if (ROOT !== 'hi') {
  const READ_ONLY = ['/grade-info', '/rank-table'];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input?.url || input);
    if (/\.run\.app\//.test(url) && !READ_ONLY.some(p => url.includes(p))) {
      console.warn('[테스트 모드] 외부 호출 차단:', url);
      return Promise.reject(new Error(`테스트 모드(${ROOT})라 실제 서버 호출을 막았습니다: ${new URL(url).pathname}`));
    }
    return realFetch(input, init);
  };
  console.warn(`[테스트 모드] 데이터 루트 ${ROOT} — 외부 서버 호출 차단 중`);
}

const P = {
  live:           `${ROOT}/campaigns/live`,
  closed:         `${ROOT}/campaigns/closed`,
  keywords:       `${ROOT}/campaign_keywords`,
  paid:           `${ROOT}/billing/paid`,
  refunds:        `${ROOT}/billing/refunds`,
  pendingRefunds: `${ROOT}/pending_refunds`,
  snapshots:      `${ROOT}/settle_snapshots`,
  dispatch:       `${ROOT}/schedule/dispatch`,
  batches:        `${ROOT}/schedule/batches`,
  products:       `${ROOT}/products`,
  users:          `${ROOT}/users`,
  staff:          `${ROOT}/staff`,
  notices:        `${ROOT}/notices`,
  grades:         `${ROOT}/grades`,
  ranks:          `${ROOT}/ranks`,
  adClassify:     `${ROOT}/ad_classify`,
  pipeline:       `${ROOT}/pipeline`,
  claims:         `${ROOT}/claims`,
  chargeClaims:   `${ROOT}/charge_claims`,
  detailLocks:    `${ROOT}/detail_locks`,
  bizfitCharge:   `${ROOT}/bizfit_charge`,
  versionCheck:   `${ROOT}/version_check_account`,
};

const CLOSED_STATUSES   = new Set(['expired', 'deleted']);
// force_stopped: 강제종료돼도 원 캠페인 금액은 그대로 정산(남은 기간은 정산 제외인 재접수 캠페인으로 이어감)
const BILLABLE_STATUSES = new Set(['active', 'accepted', 'expired', 'pending', 'split', 'force_stopped']);
// 캠페인 필드명 → campaign_keywords 필드명 (페이지는 왼쪽 필드명으로 읽고 씀)
const KW_FIELDS = { searchKeyword: 'search', yupflKeyword: 'yupfl', splitKeywords: 'split' };
const KW_HISTORY_MAX = 10;
const CLAIM_TTL_MS = 10 * 60 * 1000;      // 등록·충전 선점 만료 — 실패 후 다른 직원이 너무 오래 막히지 않게
const DETAIL_LOCK_TTL_MS = 10 * 60 * 1000;
const RECENT_CLOSED_DAYS = 30;            // 정산 배지가 보는 최근 종료 범위
const TAB_ID = Math.random().toString(36).slice(2);

const bucketOf  = status => CLOSED_STATUSES.has(status) ? 'closed' : 'live';
const safeKey   = v => String(v || '').replace(/[.#$[\]/]/g, '_');   // RTDB 키 금지문자
const nowIso    = () => new Date().toISOString();
const byCreated = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function minuteKey(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// 정산 묶음 = 접수 분 단위 시각(브라우저 KST) + 대행사 + 유저
function groupKeyParts(slot) {
  return [minuteKey(slot.createdAt), slot.agencyId || '-', slot.userId || '-'];
}
function snapToArray(snap) {
  if (!snap.exists()) return [];
  return Object.entries(snap.val()).map(([key, v]) => ({ ...v, _key: key }));
}
// 쉼표 구분 키워드 개수 — 목록(진행현황 등)은 키워드 본문 없이 이 개수 필드만 표시
const kwCount = s => String(s || '').split(',').map(k => k.trim()).filter(Boolean).length;
// 키워드 필드는 campaign_keywords로 빼고, 개수(searchKwCount·yupflKwCount)는 캠페인 레코드에 같이 씀
function splitKw(patch) {
  const kw = {}, rest = {};
  for (const [f, v] of Object.entries(patch)) (f in KW_FIELDS ? kw : rest)[f] = v;
  if ('searchKeyword' in kw) rest.searchKwCount = kwCount(kw.searchKeyword);
  if ('yupflKeyword' in kw) rest.yupflKwCount = kwCount(kw.yupflKeyword);
  // 키워드가 바뀐 시각 — subscribeLiveWithKeywords가 이 값이 바뀐 캠페인만 키워드를 다시 받음
  if (Object.keys(kw).length) rest.kwUpdatedAt = nowIso();
  return { kw, rest };
}
function withoutNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

// ── 텔레그램 (/notify — 회원 사이트와 같은 엔드포인트) ────────
async function callServer(path, body) {
  await authReady;
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${CLOUD_RUN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${path} 실패 (${res.status})`);
  return res.json().catch(() => ({}));
}
async function sendTelegram(message) {
  try { await callServer('/notify', { message }); } catch (e) { console.warn('텔레그램 알림 실패:', e); }
}
function receiptMessage(title, slots) {
  const totalTarget = slots.reduce((s, x) => s + (x.dailyTarget || 0) * (x.days || 0), 0);
  const amount      = slots.reduce((s, x) => s + (x.dailyTarget || 0) * (x.days || 0) * (x.unitPrice || 0), 0);
  return `${title}
━━━━━━━━━━━━━━━━
• 대행사: ${slots[0].agencyId || '-'}
• 캠페인 수: ${slots.length}건
• 전체 목표: ${totalTarget.toLocaleString()}개
• 단가: ${(slots[0].unitPrice || 0).toLocaleString()}원
• 금액: ${amount.toLocaleString()}원(VAT 별도)
• 입금액: ${Math.round(amount * 1.1).toLocaleString()}원 (VAT 포함)
⏰ 접수시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`;
}

// ── 공유 실시간 캐시 ─────────────────────────────────────────
// 같은 경로를 여러 화면이 구독해도 리스너는 1개 — SPA 재방문마다 페이지 스크립트가 다시 돌아도 누적 안 됨
function makeValueCache(path, transform = v => v) {
  let started = false, has = false, value;
  const subs = new Set();
  return function subscribe(cb) {
    subs.add(cb);
    if (has) cb(value);
    if (!started) {
      started = true;
      onValue(ref(db, path), snap => { value = transform(snap.exists() ? snap.val() : null); has = true; subs.forEach(f => f(value)); });
    }
    return () => subs.delete(cb);
  };
}
const once = subscribe => new Promise(resolve => { const un = subscribe(v => { resolve(v); setTimeout(() => un(), 0); }); });

// 컬렉션(쿼리) 실시간 캐시 — child 이벤트로 변경분만 받음. 초기 로드는 child_added를 모으다 onValue(onlyOnce)로 완료
// (같은 listen 공유라 추가 다운로드 없음). 구독자 통지는 300ms 디바운스.
function makeCollectionCache(makeQuery) {
  let promise = null;
  const items = new Map();
  const subs = new Set();
  let pending = false;
  const sorted = () => [...items.values()].sort(byCreated);
  function notify() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; const list = sorted(); subs.forEach(cb => cb(list)); }, 300);
  }
  function ensure() {
    if (!promise) promise = (async () => {
      await authReady;
      const q = makeQuery();
      const put = s => { items.set(s.key, { ...s.val(), _key: s.key }); notify(); };
      onChildAdded(q, put);
      onChildChanged(q, put);
      onChildRemoved(q, s => { items.delete(s.key); notify(); });
      await new Promise((res, rej) => _onValue(q, res, rej, { onlyOnce: true }));
    })().catch(e => { promise = null; throw e; });
    return promise;
  }
  return {
    async list() { await ensure(); return sorted(); },
    peek: key => items.get(key),
    subscribe(cb) {
      let cancelled = false;
      ensure().then(() => { if (!cancelled) cb(sorted()); });
      const w = list => { if (!cancelled) cb(list); };
      subs.add(w);
      return () => { cancelled = true; subs.delete(w); };
    },
  };
}

const liveCache = makeCollectionCache(() => ref(db, P.live));
const liveKwCache = new Map(); // 진행 중 캠페인 키워드 — key → { rev: kwUpdatedAt, kw }
const recentClosedCache = makeCollectionCache(() => {
  const d = new Date(); d.setDate(d.getDate() - RECENT_CLOSED_DAYS);
  return query(ref(db, P.closed), orderByChild('endDate'), startAt(ymd(d)));
});
const paidCache           = makeValueCache(P.paid, v => new Set(v ? Object.keys(v) : []));
const refundsCache        = makeValueCache(P.refunds, v => v || {});
const pendingRefundsCache = makeValueCache(P.pendingRefunds, v => v || {});
const snapshotsCache      = makeValueCache(P.snapshots, v => v || {});
const dispatchCache       = makeValueCache(P.dispatch, v => v || {});
const prodsCache          = makeValueCache(`${P.products}/prods`, v => v || null);
const prodGroupsCache     = makeValueCache(`${P.products}/groups`, v => v || null);
const gradesCache         = makeValueCache(P.grades, v => v || {});
const usersCache          = makeValueCache(P.users, v => Object.entries(v || {}).map(([k, u]) => ({ ...u, _key: k })));

// 종료·휴지통 전체 — 정산·진행현황·검색처럼 과거 기록이 필요한 화면만 세션당 1회 받음(실시간 아님)
let closedAll = null, closedPromise = null;
function loadClosed() {
  if (!closedPromise) {
    closedPromise = get(ref(db, P.closed))
      .then(snap => { closedAll = snapToArray(snap); })
      .catch(e => { closedPromise = null; throw e; });
  }
  return closedPromise;
}

// ── 캠페인 조회 ──────────────────────────────────────────────
// 검증 조회: get()이 쿼리 리스너 로컬 캐시에서 일부 필드만 돌려줄 수 있어 mid 없으면 재조회.
// 없으면 null, 끝내 필드 누락이면 throw — 그 값으로 쓰기·금액 판단 금지
async function readCampaign(key) {
  for (let i = 0; i < 3; i++) {
    const [l, c] = await Promise.all([get(ref(db, `${P.live}/${key}`)), get(ref(db, `${P.closed}/${key}`))]);
    const snap = l.exists() ? l : c.exists() ? c : null;
    if (!snap) return null;
    if (snap.val().mid) return { bucket: l.exists() ? 'live' : 'closed', data: snap.val() };
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`캠페인 정보를 제대로 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요. (${key})`);
}

// ── 캠페인 쓰기 (모든 상태 변경이 이 함수를 거침) ─────────────
// 같은 노드 안 변경은 필드 단위 multi-path update, live↔closed 경계를 넘으면 새 노드에 전체 기록 + 옛 노드 삭제를
// 한 번의 update로(둘 다 되거나 둘 다 안 됨). 키워드 필드는 campaign_keywords로 보냄.
// ponytail: 이동은 읽기→쓰기 사이에 다른 세션이 같은 캠페인 필드를 바꾸면 그 변경이 덮일 수 있음(수백 ms 창).
//           실제로 겹치면 runTransaction(캠페인 단위)로 교체.
async function writeCampaign(key, patch, cur = null) {
  const { kw, rest } = splitKw(patch);
  const updates = {};
  if (Object.keys(rest).length) {
    const found = cur || await readCampaign(key);
    if (!found) throw new Error(`없는 캠페인입니다 (${key})`);
    const target = 'status' in rest ? bucketOf(rest.status) : found.bucket;
    if (target !== found.bucket) {
      updates[`${P[target]}/${key}`] = withoutNulls({ ...found.data, ...rest });
      updates[`${P[found.bucket]}/${key}`] = null;
    } else {
      for (const [f, v] of Object.entries(rest)) updates[`${P[target]}/${key}/${f}`] = v ?? null;
    }
  }
  if (Object.keys(kw).length) Object.assign(updates, await keywordUpdates(key, kw));
  if (Object.keys(updates).length) await update(ref(db), updates);
}

// 검색·유입플 키워드가 바뀌면 이력에 추가(최근 10개)
async function keywordUpdates(key, kw) {
  const out = {};
  const hist = (kw.searchKeyword !== undefined || kw.yupflKeyword !== undefined)
    ? (await get(ref(db, `${P.keywords}/${key}`))).val() || {} : {};
  for (const [field, kf] of Object.entries(KW_FIELDS)) {
    if (!(field in kw)) continue;
    const v = kw[field] ?? null;
    out[`${P.keywords}/${key}/${kf}`] = v;
    if (kf !== 'split' && v && v !== hist[kf]) {
      out[`${P.keywords}/${key}/history/${kf}`] = [...(hist.history?.[kf] || []), { keyword: v, date: nowIso() }].slice(-KW_HISTORY_MAX);
    }
  }
  return out;
}

// 정산 고정 스냅샷 증감 — 예약 대기분 취소(일수 감소)·휴지통 이동/복구로 묶음 금액이 바뀌면 이미 저장된 스냅샷도 같이 맞춤.
// lostDays·lostSlots가 음수면 늘림(복구). 스냅샷이 없으면(아직 고정 전) 정산관리가 실시간 계산하므로 할 일 없음
async function adjustSettleSnapshot(slot, lostDays, lostSlots = 0) {
  if (!lostDays || !slot.createdAt) return;
  const path = `${P.snapshots}/${HI.settleGroupKey(slot)}`;
  const snap = await get(ref(db, path));
  if (!snap.exists()) return;
  const cur = snap.val();
  const lostTarget = (Number(slot.dailyTarget) || 0) * lostDays;
  const price = Number(slot.unitPrice) || Number(cur.unitPrice) || 0;
  await update(ref(db, path), {
    totalTarget: Math.max(0, (cur.totalTarget || 0) - lostTarget),
    amount: (cur.amount || 0) - lostTarget * price,
    slotCount: Math.max(0, (cur.slotCount || 0) - lostSlots),
  });
}

// 예약 대기분 취소 후 남는 일수·종료일 — 남은 항목이 있는 날짜는 유지, 대기분만 있다 전부 취소된 날짜만 뺌.
// 완료 항목은 서버가 2일 뒤 지우므로 화면에 남은 완료분으로 세면 일수가 줄어 정산 금액이 적게 잡힘.
export function remainingAfterCancel(slot, canceledDates, keptDates) {
  const keep = new Set(keptDates.filter(Boolean));
  const cut = new Set(canceledDates.filter(d => d && !keep.has(d)));
  const dates = [];
  if (slot.startDate && slot.endDate) {
    for (const d = new Date(`${slot.startDate}T00:00:00`); ymd(d) <= slot.endDate; d.setDate(d.getDate() + 1)) dates.push(ymd(d));
  }
  const left = dates.filter(d => !cut.has(d));
  return {
    days: Math.max(0, (Number(slot.days) || dates.length) - cut.size),
    endDate: left.length ? left[left.length - 1] : (slot.startDate || ''),
  };
}

// ════════════════════════════════════════════════════════════
const HI = {
  authReady,
  ROOT,

  // ── 로그인 ────────────────────────────────────────────────
  getCurrentUser() {
    return JSON.parse(sessionStorage.getItem('ha_current_user') || 'null');
  },
  async login(username, password) {
    try {
      const cred = await signInWithEmailAndPassword(auth, `${username}@higherad.app`, password);
      const staff = await get(ref(db, `${P.staff}/${username}`));
      if (staff.exists()) {
        const s = staff.val();
        const user = { id: cred.user.uid, username, role: s.role, name: s.name, agency: '-' };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }
      const member = await get(ref(db, `${P.users}/${safeKey(username)}`));
      if (member.exists()) {
        if (member.val().approved === false) return { ok: false, reason: 'pending' };
        const user = { ...member.val(), _key: member.key, id: cred.user.uid };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }
      await signOut(auth);
      return { ok: false };
    } catch {
      return { ok: false };
    }
  },
  logout() {
    sessionStorage.removeItem('ha_current_user');
    signOut(auth).catch(() => {});
  },

  // ════════════════════════════════════════════════════════
  // 캠페인 — 목록
  // ════════════════════════════════════════════════════════
  // 진행 중 전체(실시간 공유 캐시, 키워드 제외)
  getLive() { return liveCache.list(); },
  subscribeLive(cb) { return liveCache.subscribe(cb); },
  // 최근 30일 종료분(실시간) — 정산 배지·최근 종료 표시용
  getRecentClosed() { return recentClosedCache.list(); },
  subscribeRecentClosed(cb) { return recentClosedCache.subscribe(cb); },
  // 종료·휴지통 전체(세션당 1회) — loadClosed() 후 withClosed(live)로 합침. 같은 키면 live 우선
  loadClosed,
  withClosed(list) {
    if (!closedAll) return list;
    const have = new Set(list.map(s => s._key));
    return [...list, ...closedAll.filter(s => !have.has(s._key))].sort(byCreated);
  },
  async getAll() { await loadClosed(); return HI.withClosed(await liveCache.list()); },
  // 진행 중 + 종료 전체를 한 배열로 구독 — 진행 중·최근 30일 종료는 실시간, 그 이전 종료는 세션당 1회 받은 값.
  // live→closed 이동(종료 처리)도 최근 종료 구독으로 바로 반영됨. 같은 키면 live > 최근 종료 > 이전 종료
  subscribeAll(cb) {
    let live = null, recent = null, closedReady = false, cancelled = false;
    const emit = () => {
      if (cancelled || !live || !recent || !closedReady) return;
      const m = new Map();
      for (const list of [closedAll || [], recent, live]) for (const s of list) m.set(s._key, s);
      cb([...m.values()].sort(byCreated));
    };
    // 종료 전체 로딩이 실패해도 진행 중·최근 종료로는 그림(호출부가 실패를 알 수 있게 콘솔·알림은 호출부 몫)
    loadClosed().catch(e => console.error('종료 캠페인 로딩 실패:', e)).finally(() => { closedReady = true; emit(); });
    const u1 = liveCache.subscribe(v => { live = v; emit(); });
    const u2 = recentClosedCache.subscribe(v => { recent = v; emit(); });
    return () => { cancelled = true; u1(); u2(); };
  },
  async getByMid(mid) {
    const q = path => get(query(ref(db, path), orderByChild('mid'), equalTo(mid))).then(snapToArray);
    const [l, c] = await Promise.all([q(P.live), q(P.closed)]);
    return [...l, ...c].sort(byCreated);
  },
  // 단건 검증 조회(쓰기·금액 판단 직전엔 이것으로 최신값 확인). 없으면 null
  async getCampaign(key) { return (await readCampaign(key))?.data ?? null; },

  // ── 키워드 (목록에서 분리된 무거운 필드) ──────────────────
  async getKeywords(key) {
    return (await get(ref(db, `${P.keywords}/${key}`))).val() || {};
  },
  // 캠페인 배열에 searchKeyword·yupflKeyword·splitKeywords를 붙여 반환(접수 팝업·상세·등록 직전)
  async withKeywords(campaigns) {
    const kws = await Promise.all(campaigns.map(c => HI.getKeywords(c._key)));
    return campaigns.map((c, i) => ({
      ...c, searchKeyword: kws[i].search || '', yupflKeyword: kws[i].yupfl || '', splitKeywords: kws[i].split || null,
    }));
  },
  // 진행 중 목록 + 키워드(접수관리 전용 — 접수 팝업·배분이 키워드를 계속 읽음). 키워드는 캠페인당 1회 받고,
  // 이후엔 kwUpdatedAt이 바뀐 캠페인만 다시 받음. 받는 중 실패한 캠페인은 키워드 없이 넘기고 다음 변경 때 재시도
  // 키워드 캐시는 세션 공유(liveKwCache) — 메뉴 재방문마다 페이지 스크립트가 다시 돌아도 다시 받지 않음.
  // 호출부는 화면을 떠나면 반환된 해제 함수를 불러야 함(안 그러면 콜백이 쌓임)
  subscribeLiveWithKeywords(cb) {
    let seq = 0, cancelled = false;
    const unsub = liveCache.subscribe(async list => {
      const my = ++seq;
      const stale = list.filter(c => liveKwCache.get(c._key)?.rev !== (c.kwUpdatedAt || ''));
      await Promise.all(stale.map(async c => {
        try { liveKwCache.set(c._key, { rev: c.kwUpdatedAt || '', kw: await HI.getKeywords(c._key) }); }
        catch (e) { console.error('키워드 로딩 실패:', c._key, e); }
      }));
      if (cancelled || my !== seq) return; // 더 최신 목록이 처리 중이면 이번 결과는 버림
      cb(list.map(c => {
        const kw = liveKwCache.get(c._key)?.kw || {};
        return { ...c, searchKeyword: kw.search || '', yupflKeyword: kw.yupfl || '', splitKeywords: kw.split || null };
      }));
    });
    return () => { cancelled = true; unsub(); };
  },
  // 키워드가 안 붙은 캠페인(종료 목록 등)만 골라 붙임 — 상세·엑셀 다운로드 직전
  async ensureKeywords(campaigns) {
    const need = campaigns.filter(c => !('searchKeyword' in c));
    const got = await HI.withKeywords(need);
    need.forEach((c, i) => Object.assign(c, { searchKeyword: got[i].searchKeyword, yupflKeyword: got[i].yupflKeyword, splitKeywords: got[i].splitKeywords }));
    return campaigns;
  },
  // 같은 MID의 키워드 이력(현재값 + 변경 이력, 날짜 내림차순) — 접수 시 "이전 키워드" 제안용
  async getKeywordHistoryByMid(mid, field = 'search') {
    const camps = await HI.getByMid(mid);
    const kws = await Promise.all(camps.map(c => HI.getKeywords(c._key)));
    const out = [];
    camps.forEach((c, i) => {
      if (kws[i][field]) out.push({ keyword: kws[i][field], date: c.createdAt || null, key: c._key });
      (kws[i].history?.[field] || []).forEach(h => out.push({ keyword: h.keyword, date: h.date, key: c._key, source: h.source }));
    });
    return out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  },

  // ════════════════════════════════════════════════════════
  // 캠페인 — 쓰기
  // ════════════════════════════════════════════════════════
  // 접수(관리자 개별·엑셀). 단가는 접수 시점 회원 단가로 고정(userId=username 우선, 없으면 대행사명 매칭)
  async addCampaign(data) {
    let unitPrice = Number(data.unitPrice) || 0;
    let userId = data.userId || '';
    if (!unitPrice || !userId) {
      const users = await once(usersCache);
      const u = users.find(x => x.username === userId) || users.find(x => x.agencyId === data.agencyId || x.agency === data.agencyId);
      if (!unitPrice) unitPrice = u?.unitPrice || 0;
      if (!userId) userId = u?.username || '';
    }
    const rec = {
      status: data.isRequeue ? 'requeue' : 'pending',
      ...(data.isRequeue ? { isRequeue: true } : {}),
      ...(data.yupflSource ? { yupflSource: data.yupflSource } : {}),
      ...(data.changeTo ? { changeTo: data.changeTo } : {}),
      // 엑셀 일괄접수는 병렬 전송이라 도착순≠행순 — 호출부가 행 인덱스로 어긋낸 createdAt을 그대로 신뢰(위조 이득 없음)
      createdAt: data.createdAt || nowIso(),
      agencyId: data.agencyId || '', userId,
      startDate: data.startDate || '', endDate: data.endDate || '',
      storeName: data.storeName || '', rankKeyword: data.rankKeyword || '', url: data.url || '', mid: data.mid || '',
      memo: data.memo || '',
      days: Number(data.days) || 0, dailyTarget: Number(data.dailyTarget) || 0,
      unitPrice,
      searchKwCount: kwCount(data.searchKeyword), yupflKwCount: kwCount(data.yupflKeyword),
    };
    const key = _push(ref(db, P.live)).key;
    await update(ref(db), {
      [`${P.live}/${key}`]: rec,
      [`${P.keywords}/${key}`]: withoutNulls({ search: data.searchKeyword || '', yupfl: data.yupflKeyword || '', split: data.splitKeywords || null }),
    });
    return { ...rec, searchKeyword: data.searchKeyword || '', _key: key };
  },
  // 필드 수정·상태 변경 공용. 키워드 필드(searchKeyword·yupflKeyword·splitKeywords)도 그대로 넘기면 됨
  updateCampaign(key, patch) { return writeCampaign(key, patch); },
  approve(key, extra = {}) { return writeCampaign(key, { status: 'active', ...extra }); },
  async trash(key) {
    const cur = await readCampaign(key);
    if (!cur || cur.data.status === 'deleted') return;
    await writeCampaign(key, { status: 'deleted', deletedAt: nowIso(), originalStatus: cur.data.status || 'pending' }, cur);
    if (HI.isBillable(cur.data)) await adjustSettleSnapshot(cur.data, Number(cur.data.days) || 0, 1);
  },
  async restore(key) {
    const cur = await readCampaign(key);
    if (!cur || cur.data.status !== 'deleted') return;
    const restored = { ...cur.data, status: cur.data.originalStatus || 'pending' };
    await writeCampaign(key, { status: restored.status, deletedAt: null, originalStatus: null }, cur);
    if (HI.isBillable(restored)) await adjustSettleSnapshot(restored, -(Number(restored.days) || 0), -1);
  },
  // 영구삭제 — 캠페인·키워드·입금표시를 한 번에
  async permanentDelete(key) {
    await update(ref(db), {
      [`${P.live}/${key}`]: null, [`${P.closed}/${key}`]: null,
      [`${P.keywords}/${key}`]: null, [`${P.paid}/${key}`]: null,
    });
  },
  // 종료일 지난 진행 캠페인 일괄 종료(expired) — 한 번의 update로 live→closed 이동
  // 일 목표 칸 아래 일반/유입플(/차감) 분할 표시 — 승인·예약 때 캠페인에 고정한 값(yupflTarget)이 있을 때만(접수관리·진행현황 공용)
  dailySplitHtml(s) {
    const yup = s.yupflTarget || 0;
    if (!yup || !s.dailyTarget) return '';
    const ded = Math.round((s.deductTarget || 0) / (s.days || 1));
    const normal = Math.max(0, s.dailyTarget - yup - ded);
    return `<div style="font-size:11px;color:var(--muted);white-space:nowrap;">일반 ${normal.toLocaleString()} · <span style="color:#d97706;font-weight:600;">유입플 ${yup.toLocaleString()}</span>${ded ? ` · 차감 ${ded.toLocaleString()}` : ''}</div>`;
  },
  // 자동 종료 대상 — 종료일 지난 승인 건, 강제종료일 다음 날부터의 강제종료 건(higherad-auto _expire_live와 같은 규칙)
  shouldExpire(s, today) {
    if (s.status === 'force_stopped') return !!s.forceStoppedAt && s.forceStoppedAt < today;
    return s.status === 'active' && !!s.endDate && s.endDate < today;
  },
  async expire(keys) {
    if (!keys.length) return;
    const curs = await Promise.all(keys.map(k => readCampaign(k)));
    const updates = {};
    curs.forEach((c, i) => {
      if (!c || c.bucket !== 'live') return;
      const forced = c.data.status === 'force_stopped' && c.data.forceStoppedAt;
      updates[`${P.closed}/${keys[i]}`] = { ...c.data, status: 'expired', ...(forced ? { endDate: c.data.forceStoppedAt } : {}) };
      updates[`${P.live}/${keys[i]}`] = null;
    });
    if (Object.keys(updates).length) await update(ref(db), updates);
  },
  // 예약 대기분 일괄취소 후 종료. readScheduled로 먼저 읽어 두면 예약 항목을 지우기 전에 조회 실패 시 아무것도 안 바뀜
  // (일부 필드만 읽힌 값으로 계산하면 일수 0·종료일 빈값으로 종료돼 정산 금액이 0이 됨)
  readScheduled(key) { return readCampaign(key); },
  async endScheduled(key, canceledDates, keptDates, pre = null) {
    const cur = pre || await readCampaign(key);
    if (!cur) return null;
    const fields = remainingAfterCancel(cur.data, canceledDates, keptDates);
    await writeCampaign(key, { ...fields, status: 'expired' }, cur);
    await adjustSettleSnapshot(cur.data, Math.max(0, (Number(cur.data.days) || 0) - fields.days));
    return fields;
  },

  // 비즈핏 강제종료 성공 후 같은 MID의 진행 중(승인) 캠페인 처리 — 상태 force_stopped + 원래 종료일·강제종료일 기록
  // (일수·금액은 안 바꿈, 다음 날 자동 종료). 남은 기간(내일~원래 종료일)이 1일 이상이면 재접수 캠페인을 1회만 만듦 —
  // 정산 제외(isRequeue), 상태 'requeue'로 목록에 올라가 직원이 기존 접수 흐름으로 비즈핏에 다시 등록
  async forceStopMid(mid, today = ymd(new Date())) {
    const tmr = new Date(`${today}T00:00:00`); tmr.setDate(tmr.getDate() + 1);
    const tomorrow = ymd(tmr);
    const camps = (await HI.getByMid(mid)).filter(s => s.mid === mid && s.status === 'active' && !(s.startDate > today));
    const result = { stopped: 0, requeued: 0 };
    for (const s of camps) {
      const origEnd = s.endDate || '';
      const patch = { status: 'force_stopped', origEndDate: origEnd, forceStoppedAt: today };
      const remain = origEnd ? Math.round((new Date(`${origEnd}T00:00:00`) - tmr) / 86400000) + 1 : 0;
      if (remain >= 1 && !s.requeueCreated && await HI.claimFlag(`requeue/${s._key}`)) {
        const kw = await HI.getKeywords(s._key);
        await HI.addCampaign({
          agencyId: s.agencyId, userId: s.userId, storeName: s.storeName, url: s.url, mid: s.mid,
          rankKeyword: s.rankKeyword, searchKeyword: kw.search || '', memo: s.memo,
          dailyTarget: s.dailyTarget, days: remain, startDate: tomorrow, endDate: origEnd,
          unitPrice: s.unitPrice, isRequeue: true, yupflSource: s.yupflSource,
          // 변경 요청 중이던 캠페인이면 요청 상품을 넘김 — 접수 때 등급 매칭이 이 상품으로 배분
          changeTo: s.changeRequest?.to || '',
        });
        patch.requeueCreated = true;
        result.requeued++;
      }
      await writeCampaign(s._key, patch);
      result.stopped++;
    }
    return result;
  },

  // ── 원자적 선점 ───────────────────────────────────────────
  // 비어 있을 때만 true로 세움 — 처음 성공한 호출만 true(여러 창이 같은 후속작업을 동시에 하지 않게)
  async claimFlag(name) {
    await authReady;
    return (await runTransaction(ref(db, `${P.claims}/flags/${name}`), cur => cur ? undefined : true)).committed;
  },
  // 비즈핏 등록 선점 — 같은 캠페인·상품(leg)을 두 창이 동시에 접수하면 비즈핏에 두 번 등록·결제됨.
  // 같은 탭은 재시도 허용, 10분 지나면 만료. 선점 못 한 행은 onBlocked로 넘기고 제외
  async claimRegisterRows(rows, leg, onBlocked = () => {}) {
    await authReady;
    const keys = [...new Set(rows.map(r => r._slotKey).filter(Boolean))];
    const ok = new Set();
    await Promise.all(keys.map(async k => {
      const r = await runTransaction(ref(db, `${P.claims}/register/${k}/${leg}`), cur =>
        (cur && cur.tab !== TAB_ID && Date.now() - cur.at < CLAIM_TTL_MS) ? undefined : { tab: TAB_ID, at: Date.now() });
      if (r.committed) ok.add(k);
    }));
    return rows.filter(r => {
      if (!r._slotKey || ok.has(r._slotKey)) return true;
      onBlocked(r);
      return false;
    });
  },
  // 비즈핏 캐시 차감 선점 — 서버 /bizfit-refund는 받은 요청을 전부 실제 차감. force = 사람이 '재시도'(결과 불명 선점 덮어씀)
  async claimBizfitDeduct(keys, force = false) {
    await authReady;
    const got = [];
    for (const k of keys) {
      const r = await runTransaction(ref(db, `${P.claims}/deduct/${k}`), cur => (cur && !force) ? undefined : nowIso());
      if (!r.committed) { await HI.releaseBizfitDeduct(got); return false; }
      got.push(k);
    }
    return true;
  },
  async releaseBizfitDeduct(keys) {
    await update(ref(db), Object.fromEntries(keys.map(k => [`${P.claims}/deduct/${k}`, null])));
  },
  // 정산 충전 선점 — 서버 충전 API는 멱등성 없음. 하나라도 남이 잡고 있으면 이번에 잡은 것도 풀고 {ok:false, by}
  async claimCharge(keys, by = '') {
    await authReady;
    const got = [];
    let holder = null;
    for (const k of keys) {
      const r = await runTransaction(ref(db, `${P.chargeClaims}/${k}`), cur => {
        if (cur && cur.tab !== TAB_ID && Date.now() - cur.at < CLAIM_TTL_MS) { holder = cur.by; return; }
        return { tab: TAB_ID, at: Date.now(), by };
      });
      if (!r.committed) { await HI.releaseCharge(got); return { ok: false, by: holder }; }
      got.push(k);
    }
    return { ok: true };
  },
  async releaseCharge(keys) {
    await update(ref(db), Object.fromEntries(keys.map(k => [`${P.chargeClaims}/${k}`, null])));
  },
  // 상세 잠금 — 같은 staffId면 통과(같은 계정 두 탭은 못 막음, 등록 단계는 claimRegisterRows가 막음). 창이 닫히면 자동 해제
  async acquireDetailLock(key) {
    await authReady;
    const cu = HI.getCurrentUser() || {};
    const staffId = cu.username || cu.id || 'unknown';
    const lockRef = ref(db, `${P.detailLocks}/${key}`);
    let by = null;
    const r = await runTransaction(lockRef, cur => {
      if (cur && cur.staffId !== staffId && Date.now() - new Date(cur.lockedAt).getTime() < DETAIL_LOCK_TTL_MS) {
        by = cur.staffName || cur.staffId;
        return;
      }
      return { staffId, staffName: cu.name || staffId, lockedAt: nowIso() };
    }, { applyLocally: false });
    if (!r.committed) return { acquired: false, by: by || 'other staff' };
    onDisconnect(lockRef).remove();
    return { acquired: true };
  },
  // 잠금 전체(접수관리 진입 시 1회 — 다른 직원이 잡은 상세를 클릭 전에 미리 알기 위함)
  async getDetailLocks() { return (await get(ref(db, P.detailLocks))).val() || {}; },
  async releaseDetailLock(key) {
    const lockRef = ref(db, `${P.detailLocks}/${key}`);
    await remove(lockRef).catch(() => {});
    onDisconnect(lockRef).cancel().catch(() => {});
  },

  // ── 접수 알림·검증 ────────────────────────────────────────
  notifySingle(slot, { label = '개별' } = {}) {
    return sendTelegram(receiptMessage(`📥 <b>새 캠페인 접수 (${label})</b>`, [slot]));
  },
  notifyExcelBatch(slots, { label = '엑셀' } = {}) {
    if (!slots.length) return;
    return sendTelegram(receiptMessage(`📊 <b>새 캠페인 접수 (${label})</b>`, slots));
  },
  // 엑셀 파일 안 같은 캠페인 행 중복 표시 — 텔레그램 봇 엑셀접수와 같은 기준
  markDuplicateRows(rows) {
    const seen = new Set();
    rows.forEach(r => {
      const k = [r.mid, r.rankKeyword, r.startDate, r.days, r.dailyTarget].join('|');
      if (seen.has(k)) { r.valid = false; r.error = [r.error, '파일 내 중복 행'].filter(Boolean).join(' / '); }
      seen.add(k);
    });
    return rows;
  },

  // ════════════════════════════════════════════════════════
  // 예약 분할
  // ════════════════════════════════════════════════════════
  onScheduleDispatchChange(cb) { return dispatchCache(cb); },
  getScheduleDispatchOnce() { return once(dispatchCache); },
  // 키 = 생성 시각 base36 + 난수(접수관리 genId와 같은 형식) — 디스패처가 $key 범위로 '방금 만든 지난 시각 예약'을
  // 찾으므로 push 키(-O…)를 쓰면 그 예약은 하루 1번 전체 조회 때까지 밀림
  async addScheduleDispatch(entry) {
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await set(ref(db, `${P.dispatch}/${key}`), { ...entry, status: 'pending', createdAt: nowIso() });
    return key;
  },
  updateScheduleDispatch(id, patch) { return update(ref(db, `${P.dispatch}/${id}`), patch); },
  // 예약 항목·조각 수를 한 번에(원자적) — 키는 schedule 기준 상대경로('dispatch/{id}', 'batches/{key}/total' 등)
  updateSchedule(patch) {
    const bad = Object.keys(patch).filter(k => !/^(dispatch|batches)\//.test(k));
    if (bad.length) throw new Error(`schedule 밖 경로: ${bad.join(', ')}`);
    return update(ref(db, `${ROOT}/schedule`), patch);
  },
  removeScheduleDispatch(ids) {
    return update(ref(db), Object.fromEntries(ids.map(id => [`${P.dispatch}/${id}`, null])));
  },
  // 캠페인별 예약 조각 수(서버가 그룹 완료 판정에 씀)
  setScheduleBatch(key, { total, batchGroupId }) {
    return set(ref(db, `${P.batches}/${key}`), { total, done: 0, failed: 0, batchGroupId, createdAt: nowIso() });
  },
  async getScheduleBatch(key) { return (await get(ref(db, `${P.batches}/${key}`))).val(); },

  // ════════════════════════════════════════════════════════
  // 상품 설정 (전 계정 공용 1벌)
  // ════════════════════════════════════════════════════════
  onProdsChange(cb) { return prodsCache(cb); },
  onProdGroupsChange(cb) { return prodGroupsCache(cb); },
  saveProds(prods) { return set(ref(db, `${P.products}/prods`), prods); },
  saveProdGroups(groups) { return set(ref(db, `${P.products}/groups`), groups && groups.length ? groups : null); },
  // ver만 단일 필드로 — 배열 전체 PUT은 다른 세션의 설정 변경을 덮음
  setProdVer(index, ver) { return set(ref(db, `${P.products}/prods/${index}/ver`), ver); },
  // 옛 김프로 상품 설정(읽기 전용) — 전환 때 남아 있던 옛 김프로 예약 항목(schedule/dispatch의 src 'kp')을
  // 재분할·수정할 때만 씀. 그 항목이 다 끝나면 필요 없음
  async getLegacyKpProds() { return (await get(ref(db, `${P.products}_kp_legacy/prods`))).val(); },

  // ════════════════════════════════════════════════════════
  // 등급·순위·파이프라인·광고분류
  // ════════════════════════════════════════════════════════
  getGradesOnce() { return once(gradesCache); },
  onGradesChange(cb) { return gradesCache(cb); },
  async getRanks(mid) { return (await get(ref(db, `${P.ranks}/${safeKey(mid)}`))).val() || {}; },
  // 최신 날짜 1건만(전체 이력 다운로드 방지)
  async getLatestRank(mid) {
    return (await get(query(ref(db, `${P.ranks}/${safeKey(mid)}`), orderByKey(), limitToLast(1)))).val();
  },
  async getPipelineAllDone() { return (await get(ref(db, `${P.pipeline}/allDone`))).val(); },
  async getAdClassify() { return (await get(ref(db, P.adClassify))).val() || { groups: null, result: null }; },
  saveAdClassifyGroups(groups) { return set(ref(db, `${P.adClassify}/groups`), groups); },
  async getAdClassifyDaily() { return (await get(ref(db, `${P.adClassify}/daily`))).val() || {}; },
  async getAdClassifyRealtime() { return (await get(ref(db, `${P.adClassify}/realtime`))).val(); },
  saveAdClassifyRealtime(result) { return set(ref(db, `${P.adClassify}/realtime`), result); },

  // ════════════════════════════════════════════════════════
  // 회원 (키 = username)
  // ════════════════════════════════════════════════════════
  getUsers() { return once(usersCache); },
  onUsersChange(cb) { return usersCache(cb); },
  async getUser(username) { return (await get(ref(db, `${P.users}/${safeKey(username)}`))).val(); },
  async addUser(data) {
    const username = data.username || '';
    if (!username) throw new Error('아이디를 입력하세요.');
    const rec = {
      username,
      password: data.password || '',   // 관리자 확인용 평문 사본
      agency: data.agency || '', agencyId: data.agency || '',
      role: 'member',
      unitPrice: Number(data.unitPrice) || 0,
      memo: data.memo || '',
      createdAt: nowIso().slice(0, 10),
      approved: data.approved ?? false,
    };
    await authReady;
    const r = await runTransaction(ref(db, `${P.users}/${safeKey(username)}`), cur => cur ? undefined : rec);
    if (!r.committed) throw new Error('이미 사용 중인 아이디입니다.');
    await callServer('/create-user', { username, password: rec.password }).catch(e => console.warn('Firebase Auth 계정 생성 실패:', e));
    return { ...rec, _key: safeKey(username) };
  },
  async updateUser(username, patch) {
    if (patch.password) {
      await callServer('/create-user', { username, password: patch.password }).catch(e => console.warn('Firebase Auth 비밀번호 변경 실패:', e));
    }
    await update(ref(db, `${P.users}/${safeKey(username)}`), patch);
  },
  async deleteUser(username) {
    await remove(ref(db, `${P.users}/${safeKey(username)}`));
    // Auth 계정도 삭제(재가입 시 "이미 사용 중인 아이디" 방지)
    await callServer('/delete-user', { username }).catch(e => console.warn('Firebase Auth 계정 삭제 실패:', e));
  },
  // 대행사명 변경 시 정산 스냅샷·환불 키 이전(키 = 시각__대행사__유저).
  // 스냅샷 키는 '/'까지 치환, 환불 키는 '/' 미치환(정산관리 키 생성 규칙과 동일)
  async renameAgencyKeys(username, oldAgency, newAgency) {
    const updates = {};
    for (const [path, isSnap] of [[P.snapshots, true], [P.refunds, false]]) {
      const snap = await get(ref(db, path));
      if (!snap.exists()) continue;
      const k = v => String(v || '').replace(isSnap ? /[.#$[\]/]/g : /[.#$[\]]/g, '_');
      const from = `__${k(oldAgency)}__${k(username)}`, to = `__${k(newAgency)}__${k(username)}`;
      snap.forEach(node => {
        if (!node.key.endsWith(from)) return;
        updates[`${path}/${node.key.slice(0, -from.length)}${to}`] = isSnap ? { ...node.val(), agencyId: newAgency } : node.val();
        updates[`${path}/${node.key}`] = null;
      });
    }
    if (Object.keys(updates).length) await update(ref(db), updates);
  },

  // ── 비즈핏 계정 (대행사별 충전·접수 계정, 엑셀 버전 조회 계정) ──
  async getBizfitCharges() { return (await get(ref(db, P.bizfitCharge))).val() || {}; },
  async getBizfitCharge(agencyId) { return (await get(ref(db, `${P.bizfitCharge}/${safeKey(agencyId)}`))).val(); },
  setBizfitCharge(agencyId, acct) { return set(ref(db, `${P.bizfitCharge}/${safeKey(agencyId)}`), acct); },
  removeBizfitCharge(agencyId) { return remove(ref(db, `${P.bizfitCharge}/${safeKey(agencyId)}`)); },
  async getVersionCheckAccount() { return (await get(ref(db, P.versionCheck))).val(); },

  // ════════════════════════════════════════════════════════
  // 공지사항
  // ════════════════════════════════════════════════════════
  async getNotices() {
    return snapToArray(await get(ref(db, P.notices))).sort((a, b) => new Date(b.date) - new Date(a.date));
  },
  async addNotice(data) {
    const n = {
      title: data.title || '', content: data.content || '', author: 'admin',
      date: nowIso().replace('T', ' ').slice(0, 19), pinned: !!data.pinned,
    };
    const r = _push(ref(db, P.notices));
    await set(r, n);
    return { ...n, _key: r.key };
  },
  updateNotice(key, patch) { return update(ref(db, `${P.notices}/${key}`), patch); },
  deleteNotice(key) { return remove(ref(db, `${P.notices}/${key}`)); },

  // ════════════════════════════════════════════════════════
  // 정산
  // ════════════════════════════════════════════════════════
  // 정산 묶음 키 = 접수 분 단위 시각__대행사__유저 — 고정 스냅샷·환불이 이 키로 저장돼 있어 규칙을 바꾸면 고정 금액이 끊김.
  // 빈 대행사·유저는 '-'(정산관리 groupByTimeAgency와 동일)
  settleGroupKey(slot) {
    return groupKeyParts(slot).map(safeKey).join('__');
  },
  // 환불 키는 '/'를 치환하지 않음(정산관리 refundKey 규칙 — 저장된 환불 키가 이 형태)
  refundGroupKey(slot) {
    return groupKeyParts(slot).map(v => v.replace(/[.#$[\]]/g, '_')).join('__');
  },
  // 정산 대상 — 재접수(isRequeue)·휴지통 제외. 정산관리·사이드바 배지·텔레그램 봇이 같은 기준을 써야 함
  isBillable(slot) {
    if (slot.isRequeue) return false; // 재접수는 기존 배분을 이어받을 뿐 새 결제 건이 아님
    return BILLABLE_STATUSES.has(slot.status);
  },
  getPaidSet() { return once(paidCache); },
  onPaidSetChange(cb) { return paidCache(cb); },
  setPaid(key, val) { return val ? set(ref(db, `${P.paid}/${key}`), true) : remove(ref(db, `${P.paid}/${key}`)); },
  setPaidMany(keys, val) {
    return update(ref(db), Object.fromEntries(keys.map(k => [`${P.paid}/${k}`, val ? true : null])));
  },
  getRefunds() { return once(refundsCache); },
  onRefundsChange(cb) { return refundsCache(cb); },
  setRefundAmount(key, amount) {
    return (!amount || amount <= 0) ? remove(ref(db, `${P.refunds}/${key}`)) : set(ref(db, `${P.refunds}/${key}`), amount);
  },
  // 환불 예정 — 대행사별로 미리 등록하면 이후 정산 묶음에 자동 차감
  // {agencyId, amount, remaining, createdAt, createdBy, applied:{묶음키: 차감액}, completedAt}
  onPendingRefundsChange(cb) { return pendingRefundsCache(cb); },
  async addPendingRefund(agencyId, amount) {
    const u = HI.getCurrentUser() || {};
    await set(_push(ref(db, P.pendingRefunds)), {
      agencyId, amount, remaining: amount, createdAt: nowIso(), createdBy: u.name || u.username || '',
    });
  },
  deletePendingRefund(id) { return remove(ref(db, `${P.pendingRefunds}/${id}`)); },
  // 묶음 하나에서 min(남은 금액, 묶음 금액)만 원자적으로 떼어감 — 여러 세션이 동시에 돌아도 같은 묶음엔 1번만
  async claimPendingRefund(id, groupKey, groupAmount) {
    await authReady;
    let take = 0;
    const r = await runTransaction(ref(db, `${P.pendingRefunds}/${id}`), cur => {
      take = 0;
      if (!cur || !(cur.remaining > 0) || cur.applied?.[groupKey] != null) return cur;
      take = Math.min(cur.remaining, groupAmount);
      const remaining = cur.remaining - take;
      return { ...cur, remaining, applied: { ...(cur.applied || {}), [groupKey]: take },
        ...(remaining <= 0 ? { completedAt: nowIso() } : {}) };
    });
    return r.committed ? take : 0;
  },
  // 정산 고정 스냅샷 — 과거 날짜 금액은 1회 고정(force 없으면 이미 있으면 안 씀)
  getAllSettleSnapshots() { return once(snapshotsCache); },
  onSettleSnapshotsChange(cb) { return snapshotsCache(cb); },
  async saveSettleSnapshot(snapKey, data, force = false) {
    const r = ref(db, `${P.snapshots}/${snapKey}`);
    if (!force) {
      await authReady;
      await runTransaction(r, cur => cur ? undefined : { ...data, savedAt: nowIso() });
      return;
    }
    await set(r, { ...data, savedAt: nowIso() });
  },
  updateSettleSnapshot(snapKey, patch) { return update(ref(db, `${P.snapshots}/${snapKey}`), patch); },
  deleteSettleSnapshot(snapKey) { return remove(ref(db, `${P.snapshots}/${snapKey}`)); },

  // 정산 충전·입금 도장(실제 비즈핏 충전 없음 — 정산관리 '완료' 버튼 + 입금 처리와 같은 기록). 접수관리 승인·삭제 시 자동 처리
  // 대상 대행사([단독]오렌지)에만 씀. 담당자 = 로그인 직원.
  // 스냅샷이 이미 있으면(과거 날짜 고정분 등) 금액은 그대로 두고 비어 있는 도장만 채움. 없으면 정산관리 입금 버튼(bulkRow)과
  // 같은 금액 필드로 새로 씀 — 과거 날짜 행은 스냅샷 금액을 그대로 표시하므로 도장만 있는 스냅샷이면 금액 0으로 보임
  async stampChargeAndPaid(slots) {
    const cu = HI.getCurrentUser() || {};
    const by = cu.username || '-', byName = cu.name || cu.username || '알 수 없음', at = nowIso();
    const [live, users, refunds] = await Promise.all([HI.getLive(), HI.getUsers(), HI.getRefunds()]);
    const price = s => Number(s.unitPrice) > 0 ? Number(s.unitPrice) : (users.find(u => u.username === s.userId)?.unitPrice || 0);
    const byKey = new Map(live.map(s => [s._key, s]));
    slots.filter(Boolean).forEach(s => byKey.set(s._key, { ...byKey.get(s._key), ...s })); // 방금 승인한 값 우선(캐시 지연)
    const updates = {};
    for (const gk of new Set(slots.filter(Boolean).map(HI.settleGroupKey))) {
      const group = [...byKey.values()].filter(s => HI.settleGroupKey(s) === gk && HI.isBillable(s));
      // 묶음이 전부 승인(예약 포함)된 뒤에만 — 중간에 휴지통으로 빠지는 건이 금액에 반영되도록
      if (!group.length || group.some(s => s.status === 'pending' || s.status === 'accepted')) continue;
      const first = group[0];
      const cur = (await get(ref(db, `${P.snapshots}/${gk}`))).val(); // 캐시 말고 DB — 고정 금액을 늦은 캐시로 덮지 않게
      let snap;
      if (cur) {
        snap = { ...cur };
      } else {
        const refund = refunds[HI.refundGroupKey(first)] || 0;
        const amt = group.reduce((a, s) => a + (s.dailyTarget || 0) * (s.days || 0) * price(s), 0);
        snap = {
          timeKey: minuteKey(first.createdAt), agencyId: first.agencyId || '-', userId: first.userId || '-',
          slotCount: group.length, totalTarget: group.reduce((a, s) => a + (s.dailyTarget || 0) * (s.days || 0), 0),
          amount: amt - refund, refund, unitPrice: price(first),
          deductAmt: group.reduce((a, s) => a + (s.deductAmount || 0), 0),
          deductTgt: group.reduce((a, s) => a + (s.deductTarget || 0), 0),
          yupflAmt: group.reduce((a, s) => a + (s.yupflAmount || 0), 0),
        };
      }
      if (!snap.chargeConfirmedByName) {
        Object.assign(snap, { chargeConfirmedAt: at, chargeConfirmedBy: by, chargeConfirmedByName: byName, chargeApiDone: true, chargeApiAmount: snap.amount || 0 });
      }
      if (!snap.confirmedByName) Object.assign(snap, { confirmedAt: at, confirmedBy: by, confirmedByName: byName });
      updates[`${P.snapshots}/${gk}`] = { ...snap, savedAt: at };
      group.forEach(s => { updates[`${P.paid}/${s._key}`] = true; });
    }
    if (Object.keys(updates).length) await update(ref(db), updates);
  },

  // 사이드바 정산 배지 — 미정산 묶음 수. 진행 중 + 최근 30일 종료(+ 이 세션에서 전체 종료를 받았으면 그것까지)
  onUnpaidGroupsChange(cb) {
    let live = null, recent = null, paid = null;
    const calc = () => {
      if (!live || !recent || !paid) return; // 셋 다 오기 전엔 계산 안 함(입금셋보다 먼저 오면 배지가 잠깐 크게 뜸)
      const byKey = new Map([...HI.withClosed(recent), ...live].map(s => [s._key, s]));
      const groups = new Map();
      byKey.forEach(s => {
        if (!HI.isBillable(s)) return;
        const g = HI.settleGroupKey(s);
        groups.set(g, (groups.get(g) ?? true) && paid.has(s._key));
      });
      cb([...groups.values()].filter(allPaid => !allPaid).length);
    };
    const u1 = liveCache.subscribe(v => { live = v; calc(); });
    const u2 = recentClosedCache.subscribe(v => { recent = v; calc(); });
    const u3 = paidCache(v => { paid = v; calc(); });
    return () => { u1(); u2(); u3(); };
  },
};

window.HI = HI;
export default HI;
