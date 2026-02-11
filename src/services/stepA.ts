import { 
  getPerformance, 
  getPriceTable, 
  getVendorQuotes, 
  getPriceLookup,
  PerformanceRow 
} from './dataLoader';
import { parseOptionsFromDesc, calcOptionPrice } from '../utils/helpers';

export interface PRItem {
  자재번호: string;
  내역: string;
  밸브타입: string;
  vtype_key: string;
  요청수량: number;
  발주금액: number;
  발주일: string;
  발주업체: string;
}

export interface StepA1Result {
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  vtype_key: string;
  매핑상태: string;
  본체가: number;
  옵션가: number;
  합계: number;
  수량: number;
  추천총액: number;
  실발주액: number;
  수량일치: string;
  옵션상세: string;
  계약업체: string;
}

// PR 대상 건 생성 (밸브타입+내역 조합별 대표 건)
export function generatePRItems(): PRItem[] {
  const performance = getPerformance();
  
  // 유효한 밸브타입만 필터
  const validPerf = performance.filter(r => r['Valve Type'] && r['Valve Type'] !== 'nan');
  
  // 발주일 기준 내림차순 정렬
  validPerf.sort((a, b) => {
    const dateA = new Date(a.발주일 as string).getTime();
    const dateB = new Date(b.발주일 as string).getTime();
    return dateB - dateA;
  });

  // 밸브타입 + 내역 조합별 대표 건 선정
  const seen = new Set<string>();
  const prItems: PRItem[] = [];

  for (const row of validPerf) {
    const key = `${row['Valve Type']}|${row.내역}`;
    if (!seen.has(key)) {
      seen.add(key);
      prItems.push({
        자재번호: row.자재번호,
        내역: row.내역,
        밸브타입: row['Valve Type'],
        vtype_key: row.vtype_key || '',
        요청수량: row.요청수량,
        발주금액: row['발주금액-변환'],
        발주일: String(row.발주일).slice(0, 10),
        발주업체: row.발주업체 || ''
      });
    }
  }

  return prItems;
}

// Step A-1: 계약단가 기준 추천가 산출
export function executeStepA1(): {
  results: StepA1Result[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    matchRate: string;
  };
} {
  const prItems = generatePRItems();
  const priceLookup = getPriceLookup();
  const results: StepA1Result[] = [];

  for (const pr of prItems) {
    const vk = pr.vtype_key;
    const desc = pr.내역;
    const qty = pr.요청수량 > 0 ? pr.요청수량 : 1;
    const descOpts = parseOptionsFromDesc(desc);

    const result: StepA1Result = {
      자재번호: pr.자재번호,
      자재내역: desc,
      밸브타입: pr.밸브타입,
      vtype_key: vk,
      매핑상태: '실패',
      본체가: 0,
      옵션가: 0,
      합계: 0,
      수량: qty,
      추천총액: 0,
      실발주액: pr.발주금액,
      수량일치: '-',
      옵션상세: '-',
      계약업체: ''
    };

    // 단가테이블 매핑
    const priceRows = priceLookup.get(vk);
    if (priceRows && priceRows.length > 0) {
      const pt = priceRows[0];
      const body2 = pt['BODY2-변환'] || 0;
      const ptQty = pt.수량 > 0 ? pt.수량 : 1;
      const unitBody2 = body2 / ptQty;

      // 옵션 계산
      const { total: optTotal, detail: optDetail } = calcOptionPrice(pt, descOpts);
      const unitSum = unitBody2 + optTotal;

      result.매핑상태 = '성공';
      result.계약업체 = pt.업체명 || '';
      result.본체가 = Math.round(unitBody2);
      result.옵션가 = Math.round(optTotal);
      result.합계 = Math.round(unitSum);
      result.추천총액 = Math.round(unitSum * qty);
      result.수량일치 = pt.수량 === qty ? '일치' : `불일치(${pt.수량}→${qty})`;
      result.옵션상세 = Object.keys(optDetail).length > 0 
        ? Object.entries(optDetail).map(([k, v]) => `${k}:${v.toLocaleString()}`).join(', ')
        : '-';
    }

    results.push(result);
  }

  const matched = results.filter(r => r.매핑상태 === '성공').length;
  
  return {
    results,
    summary: {
      total: results.length,
      matched,
      unmatched: results.length - matched,
      matchRate: ((matched / results.length) * 100).toFixed(1) + '%'
    }
  };
}

export interface StepA2Result {
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  매핑유형: string;
  실적업체: string;
  실적발주일: string;
  실적개당가: number;
  수량: number;
  최근발주가: number;
  협상목표가: number;
  실발주액: number;
}

// Step A-2: 발주실적 기준 예상가 산출
export function executeStepA2(): {
  results: StepA2Result[];
  summary: {
    total: number;
    동일내역: number;
    유사타입: number;
    미매핑: number;
  };
} {
  const prItems = generatePRItems();
  const performance = getPerformance();
  const results: StepA2Result[] = [];

  for (const pr of prItems) {
    const vk = pr.vtype_key;
    const desc = pr.내역;
    const qty = pr.요청수량 > 0 ? pr.요청수량 : 1;
    const prMatNo = pr.자재번호;

    const result: StepA2Result = {
      자재번호: pr.자재번호,
      자재내역: desc,
      밸브타입: pr.밸브타입,
      매핑유형: '미매핑',
      실적업체: '',
      실적발주일: '',
      실적개당가: 0,
      수량: qty,
      최근발주가: 0,
      협상목표가: 0,
      실발주액: pr.발주금액
    };

    // 동일 밸브타입 키 & 다른 건 찾기
    const pool = performance.filter(r => 
      r.vtype_key === vk && r.자재번호 !== prMatNo
    );

    if (pool.length > 0) {
      // 1순위: 밸브타입 + 내역 100% 일치
      const exactMatch = pool.filter(r => r.내역.trim() === desc.trim());
      
      if (exactMatch.length > 0) {
        // 최근 발주 건
        exactMatch.sort((a, b) => 
          new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
        );
        const top = exactMatch[0];
        const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
        const unit = top['발주금액-변환'] / perfQty;

        result.매핑유형 = '동일내역';
        result.실적업체 = top.발주업체 || '';
        result.실적발주일 = String(top.발주일).slice(0, 10);
        result.실적개당가 = Math.round(unit);
        result.최근발주가 = Math.round(unit * qty);
        result.협상목표가 = Math.round(unit * qty * 0.9);
      } else {
        // 2순위: 밸브타입만 일치
        pool.sort((a, b) => 
          new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
        );
        const top = pool[0];
        const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
        const unit = top['발주금액-변환'] / perfQty;

        result.매핑유형 = '유사타입';
        result.실적업체 = top.발주업체 || '';
        result.실적발주일 = String(top.발주일).slice(0, 10);
        result.실적개당가 = Math.round(unit);
        result.최근발주가 = Math.round(unit * qty);
        result.협상목표가 = Math.round(unit * qty * 0.9);
      }
    }

    results.push(result);
  }

  return {
    results,
    summary: {
      total: results.length,
      동일내역: results.filter(r => r.매핑유형 === '동일내역').length,
      유사타입: results.filter(r => r.매핑유형 === '유사타입').length,
      미매핑: results.filter(r => r.매핑유형 === '미매핑').length
    }
  };
}
