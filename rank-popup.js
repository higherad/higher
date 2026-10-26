/**
 * RANK-POPUP.JS — 순위 조회 팝업 공통 모듈
 * 팝업은 진행현황, 순위 색상 기준(getRankTrend)은 순위조회에서도 사용
 *
 * 순위 색상 규칙: 전일 데이터 대비 비교
 *  - 순위 상승(숫자 감소) → 빨간색
 *  - 순위 하락(숫자 증가) → 파란색
 *  - 변동 없음 / 비교 불가 → 기본 텍스트 색상
 */

/**
 * 전일 대비 순위 변동 추세를 계산
 * - 전일 데이터 자체가 없으면(null/undefined) 비교하지 않음 → 'same'
 * - 전일 순위가 '-'(미확인)이면 300위로 간주하여 비교
 * @returns {'up'|'down'|'same'|null} up=순위 상승(숫자 감소), down=순위 하락(숫자 증가),
 *          same=변동 없음/비교 불가, null=현재 순위 데이터 없음
 */
export function getRankTrend(rank, prevRank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (prevRank == null) return 'same';
  let p = Number(prevRank);
  if (!Number.isFinite(p) || p <= 0) p = 300;
  if (r < p) return 'up';
  if (r > p) return 'down';
  return 'same';
}

function injectRankPopupStyle() {
  if (document.getElementById('rank-popup-style')) return;
  const st = document.createElement('style');
  st.id = 'rank-popup-style';
  st.textContent = `
    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:9000; display:flex; align-items:center; justify-content:center; }
    .rank-modal-box { background:#fff; border-radius:16px; width:480px; max-height:80vh; overflow-y:auto; padding:24px; box-shadow:0 20px 60px rgba(0,0,0,.25); }
    .rank-modal-title { font-size:16px; font-weight:700; margin-bottom:6px; }
    .rank-modal-sub { font-size:12px; color:var(--text2); margin-bottom:16px; }
    .rank-tbl { width:100%; border-collapse:collapse; font-size:12px; }
    .rank-tbl thead th { background:#1e293b; color:#fff; padding:9px 10px; text-align:center; font-weight:500; }
    .rank-tbl tbody td { padding:9px 10px; border-bottom:1px solid var(--border); text-align:center; vertical-align:middle; }
    .rank-tbl tbody tr:last-child td { border-bottom:none; }
    .rank-tbl tbody tr:hover { background:#f8fafc; }
    .rank-num { display:inline-block; font-weight:700; font-size:13px; padding:2px 10px; border-radius:5px; background:#f1f5f9; }
    .rank-up   { color:#dc2626; }
    .rank-down { color:#2563eb; }
    .rank-same { color:var(--text); }
    .rank-empty { text-align:center; padding:40px 0; color:var(--muted); font-size:13px; }
    .rank-modal-box .btn-cancel { padding:8px 20px; border:1px solid var(--border); border-radius:7px; background:#fff; cursor:pointer; font-size:13px; font-family:inherit; }
  `;
  document.head.appendChild(st);
}

async function renderRankTable(mid, area) {
  if (!area) return;
  try {
    const data = await window.HI.getRanks(mid); // { "2026-03-26": { keyword, rank }, ... }

    if (!Object.keys(data).length) {
      area.innerHTML = `<div class="rank-empty">저장된 순위 데이터가 없습니다.<br><small style="color:var(--muted)">매일 오후 자동으로 업데이트됩니다.</small></div>`;
      return;
    }

    const seen = new Set();
    const rows = Object.entries(data)
      .map(([date, v]) => ({ date, keyword: v.keyword || '-', rank: v.rank }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .filter(r => {
        const k = `${r.date}_${r.keyword}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });

    area.innerHTML = `
      <table class="rank-tbl">
        <thead><tr><th>날짜</th><th>순위 키워드</th><th>순위</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => {
            const rn = Number(r.rank);
            let display = '<span style="color:var(--muted)">-</span>';
            if (r.rank && r.rank !== '-' && Number.isFinite(rn)) {
              const prev = rows[i + 1];
              const trend = getRankTrend(rn, prev ? prev.rank : null);
              const cls = trend === 'up' ? 'rank-up' : trend === 'down' ? 'rank-down' : 'rank-same';
              display = `<span class="rank-num ${cls}">${rn}위</span>`;
            }
            return `<tr>
              <td style="color:var(--text2)">${r.date}</td>
              <td style="font-weight:500">${r.keyword}</td>
              <td>${display}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    area.innerHTML = `<div class="rank-empty" style="color:var(--danger)">데이터 로드 실패: ${e.message}</div>`;
  }
}

export async function openRankPopup(slot) {
  if (!slot || !slot.mid) { alert('MID 정보가 없습니다.'); return; }

  injectRankPopupStyle();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = function(e) {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML = `
    <div class="rank-modal-box">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:4px;">
        <div>
          <div class="rank-modal-title">일자별 순위</div>
          <div class="rank-modal-sub">${slot.storeName} &nbsp;·&nbsp; MID: ${slot.mid} &nbsp;·&nbsp; 순위키워드: <strong>${slot.rankKeyword || '-'}</strong></div>
        </div>
        <button class="btn-cancel" style="flex-shrink:0" onclick="this.closest('.modal-overlay').remove()">닫기</button>
      </div>
      <div id="rank-table-area">
        <div class="loading-wrap"><div class="spinner"></div> 순위 데이터 불러오는 중...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  await renderRankTable(slot.mid, overlay.querySelector('#rank-table-area'));
}
