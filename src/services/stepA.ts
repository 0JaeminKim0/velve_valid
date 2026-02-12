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
  매핑상태: string;
  매핑유형: string;  // 업무용어: 타입+사이즈일치, 타입일치
  본체가: number;
  옵션가: number;
  합계: number;
  수량: number;
  추천총액: number;
  옵션상세: string;
  계약업체: string;
}

// PR 대상 건 생성 - 약 1760건만 선별
export function generatePRItems(): PRItem[] {
  const performance = getPerformance();
  const priceTable = getPriceTable();
  
  // 단가테이블에 있는 밸브타입만 필터 (단가매핑 가능한 건만)
  // Performance의 Valve Type에서 끝 1글자(T)를 제거하면 Price Table의 밸브타입과 매칭됨
  const validValveTypes = new Set(priceTable.map(pt => pt.밸브타입));
  
  // 유효한 밸브타입만 필터 - vtype_key (끝 1글자 제거)로 매칭
  const validPerf = performance.filter(r => {
    const vtype = r['Valve Type'];
    if (!vtype || vtype === 'nan') return false;
    // 밸브타입 끝 1글자 제거하여 단가테이블과 매칭 (VGBASW3A0AT -> VGBASW3A0A)
    const vtypeKey = vtype.slice(0, -1);
    return validValveTypes.has(vtypeKey);
  });
  
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

// Set1: PR 접수 데이터 조회
export function getPRData(): {
  data: any[];
  summary: {
    total: number;
    columns: number;
    uniqueTypes: number;
  };
  dataType: string;
} {
  const prItems = generatePRItems();
  
  // PR 접수용 데이터 형식
  const data = prItems.map((pr, idx) => ({
    No: idx + 1,
    자재번호: pr.자재번호,
    자재내역: pr.내역,
    밸브타입: pr.밸브타입,
    요청수량: pr.요청수량,
    최근발주일: pr.발주일,
    발주업체: pr.발주업체
  }));

  const uniqueTypes = new Set(prItems.map(p => p.밸브타입)).size;

  return {
    data,
    summary: {
      total: prItems.length,
      columns: 7,
      uniqueTypes
    },
    dataType: 'pr'
  };
}

// Step A-1: 계약단가 기준 추천가 산출 (단가TBL 매핑)
export function executeStepA1(): {
  results: StepA1Result[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    matchRate: string;
    타입사이즈일치: number;
    타입일치: number;
  };
  rules: string[];
} {
  const prItems = generatePRItems();
  const priceLookup = getPriceLookup();
  const priceTable = getPriceTable();
  const results: StepA1Result[] = [];

  // 타입만으로 매핑하기 위한 보조 lookup
  const typeOnlyLookup = new Map<string, any[]>();
  for (const pt of priceTable) {
    const vtype = pt.밸브타입;
    if (vtype) {
      if (!typeOnlyLookup.has(vtype)) {
        typeOnlyLookup.set(vtype, []);
      }
      typeOnlyLookup.get(vtype)!.push(pt);
    }
  }

  for (const pr of prItems) {
    const vk = pr.vtype_key;
    const vtype = pr.밸브타입;
    const desc = pr.내역;
    const qty = pr.요청수량 > 0 ? pr.요청수량 : 1;
    const descOpts = parseOptionsFromDesc(desc);

    const result: StepA1Result = {
      자재번호: pr.자재번호,
      자재내역: desc,
      밸브타입: pr.밸브타입,
      매핑상태: '실패',
      매핑유형: '-',
      본체가: 0,
      옵션가: 0,
      합계: 0,
      수량: qty,
      추천총액: 0,
      옵션상세: '-',
      계약업체: ''
    };

    // 1순위: vtype_key (타입+사이즈) 매핑
    let priceRows = priceLookup.get(vk);
    let mappingType = '타입+사이즈일치';
    
    // 2순위: 타입만 매핑
    if (!priceRows || priceRows.length === 0) {
      priceRows = typeOnlyLookup.get(vtype);
      mappingType = '타입일치';
    }

    if (priceRows && priceRows.length > 0) {
      const pt = priceRows[0];
      const body2 = pt['BODY2-변환'] || 0;
      const ptQty = pt.수량 > 0 ? pt.수량 : 1;
      const unitBody2 = body2 / ptQty;

      // 옵션 계산
      const { total: optTotal, detail: optDetail } = calcOptionPrice(pt, descOpts);
      const unitSum = unitBody2 + optTotal;

      result.매핑상태 = '성공';
      result.매핑유형 = mappingType;
      result.계약업체 = pt.업체명 || '';
      result.본체가 = Math.round(unitBody2);
      result.옵션가 = Math.round(optTotal);
      result.합계 = Math.round(unitSum);
      result.추천총액 = Math.round(unitSum * qty);
      result.옵션상세 = Object.keys(optDetail).length > 0 
        ? Object.entries(optDetail).map(([k, v]) => `${k}:${v.toLocaleString()}`).join(', ')
        : '-';
    }

    results.push(result);
  }

  const matched = results.filter(r => r.매핑상태 === '성공').length;
  const 타입사이즈일치 = results.filter(r => r.매핑유형 === '타입+사이즈일치').length;
  const 타입일치 = results.filter(r => r.매핑유형 === '타입일치').length;
  
  return {
    results,
    summary: {
      total: results.length,
      matched,
      unmatched: results.length - matched,
      matchRate: ((matched / results.length) * 100).toFixed(1) + '%',
      타입사이즈일치,
      타입일치
    },
    rules: [
      '1순위: 밸브타입+사이즈 일치 (타입+사이즈일치)',
      '2순위: 밸브타입만 일치 (타입일치)',
      '본체가 = 단가TBL BODY2-변환 / 수량',
      '옵션가 = 내역에서 추출한 옵션 합산'
    ]
  };
}

export interface StepA2Result {
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  매핑유형: string;  // 동일내역, 유사타입, 미매핑
  실적업체: string;
  실적발주일: string;
  수량: number;
  최근발주가: number;
  협상목표가: number;
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
  rules: string[];
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
      수량: qty,
      최근발주가: 0,
      협상목표가: 0
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
    },
    rules: [
      '동일내역: 밸브타입+내역 100% 일치',
      '유사타입: 밸브타입만 일치',
      '최근발주가 = 최근 발주건 개당단가 × 요청수량',
      '협상목표가 = 최근발주가 × 90%'
    ]
  };
}
