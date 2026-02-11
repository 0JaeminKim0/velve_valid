import { PriceTableRow } from '../services/dataLoader';

// 자재내역에서 옵션 키워드 추출
export function parseOptionsFromDesc(descStr: string): string[] {
  const parts = descStr.trim().split(/\s+/);
  const markers = ['TR', 'T', 'LR'];
  
  for (const marker of markers) {
    const idx = parts.indexOf(marker);
    if (idx !== -1 && idx < parts.length - 1) {
      return parts.slice(idx + 1);
    }
  }
  return [];
}

// 옵션 단가 계산
export function calcOptionPrice(
  priceRow: PriceTableRow,
  descOptions: string[],
  intPaint: string = '',
  extPaint: string = '',
  detailSpec: string = ''
): { total: number; detail: Record<string, number> } {
  let total = 0;
  const detail: Record<string, number> = {};

  // N/P (네임플레이트) - 거의 항상 적용
  const npVal = priceRow['N/P-변환'] || 0;
  if (npVal > 0) {
    total += npVal;
    detail['N/P'] = npVal;
  }

  // 외부도장 O-P (도장코드)
  const ep = (extPaint || '').toUpperCase().trim();
  if (ep && !['N0', 'NO', '', 'NAN', 'NONE'].includes(ep)) {
    const v = priceRow['O-P-변환'] || 0;
    if (v > 0) {
      total += v;
      detail['O-P(외부도장)'] = v;
    }
  }

  // 내부도장 I-P (도장코드)
  const ip = (intPaint || '').toUpperCase().trim();
  if (ip && !['N0', 'NO', '', 'NAN', 'NONE'].includes(ip)) {
    const v = priceRow['I-P-변환'] || 0;
    if (v > 0) {
      total += v;
      detail['I-P(내부도장)'] = v;
    }
  }

  // 자재내역 키워드 매핑
  const kwMap: Record<string, string> = {
    'LOCK': 'LOCK-변환',
    'IND': 'IND-변환',
    'L/SW': 'L/SW-변환',
    'EXT': 'EXT-변환',
    'S-EXT': 'EXT-변환',
    'H/R-B': 'EXT-변환',
    'ST-W': 'EXT-변환',
    'RED-P': 'EXT-변환',
    '1-L/S': 'L/SW-변환',
    'W/SFT': 'EXT-변환',
  };

  for (const opt of descOptions) {
    const ou = opt.toUpperCase().trim();
    
    if (ou === 'I-T' || ou === 'I/O-T') {
      const v = priceRow['I-P-변환'] || 0;
      if (v > 0 && !detail['I-P(내부도장)'] && !detail['I-P(자재내역)']) {
        total += v;
        detail['I-P(자재내역)'] = v;
      }
    } else if (ou === 'I/O-P') {
      const ipVal = priceRow['I-P-변환'] || 0;
      const opVal = priceRow['O-P-변환'] || 0;
      if (ipVal > 0 && !detail['I-P(내부도장)']) {
        total += ipVal;
        detail['I-P(I/O-P)'] = ipVal;
      }
      if (opVal > 0 && !detail['O-P(외부도장)']) {
        total += opVal;
        detail['O-P(I/O-P)'] = opVal;
      }
    } else if (ou === 'O-P') {
      const v = priceRow['O-P-변환'] || 0;
      if (v > 0 && !detail['O-P(외부도장)']) {
        total += v;
        detail['O-P(자재내역)'] = v;
      }
    } else if (kwMap[ou]) {
      const v = (priceRow as any)[kwMap[ou]] || 0;
      if (v > 0) {
        total += v;
        detail[ou] = v;
      }
    } else if (ou === 'RUB-C') {
      const v = priceRow['DISC-SCS16-변환'] || 0;
      if (v > 0) {
        total += v;
        detail['RUB-C'] = v;
      }
    }
  }

  // 상세사양 처리
  if (detailSpec) {
    const su = detailSpec.toUpperCase();
    const specMap: Record<string, string> = {
      'SUS316': 'DISC-SCS16-변환',
      'SCS16': 'DISC-SCS16-변환',
      'SUS304': 'DISC-SCS13-변환',
      'SCS13': 'DISC-SCS13-변환',
      'SCS14': 'DISC-SCS14-변환',
    };
    
    for (const [kw, col] of Object.entries(specMap)) {
      if (su.includes(kw)) {
        const v = (priceRow as any)[col] || 0;
        const label = col.replace('-변환', '');
        if (v > 0 && !detail[label]) {
          total += v;
          detail[label] = v;
        }
        break;
      }
    }
  }

  return { total, detail };
}

// 트렌드 판단
export function getTrend(cur: number, prev: number, threshold: number = 0.02): string {
  if (prev === 0) return '데이터없음';
  const change = (cur - prev) / prev;
  if (change > threshold) return '상승';
  if (change < -threshold) return '하락';
  return '유지';
}

// 시황 적정성 판단
export function getMarketJudgment(priceTrend: string, marketTrend: string): string {
  const matrix: Record<string, string> = {
    '유지-유지': '적정',
    '유지-하락': '주의',
    '유지-상승': '양호',
    '상승-유지': '주의',
    '상승-하락': '주의',
    '상승-상승': '적정',
    '하락-유지': '양호',
    '하락-하락': '주의',
    '하락-상승': '양호',
  };
  return matrix[`${priceTrend}-${marketTrend}`] || '판단불가';
}

// 금액 포맷
export function formatCurrency(val: number): string {
  if (!val || isNaN(val)) return '-';
  return val.toLocaleString('ko-KR');
}

// 퍼센트 포맷
export function formatPercent(val: number): string {
  if (!val || isNaN(val)) return '-';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}
