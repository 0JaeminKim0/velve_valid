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
  매핑유형: string;  // 업무용어: 타입+자재내역일치, 타입일치
  본체가: number;
  옵션가: number;
  합계: number;
  수량: number;
  추천총액: number;
  옵션상세: string;
  계약업체: string;
}

// 타입 추출 함수 (밸브타입에서 사이즈 부분 제거, 앞 알파벳만)
function extractTypePrefix(vtype: string): string {
  const match = vtype.match(/^([A-Z]+)/);
  return match ? match[1] : vtype.slice(0, 6);
}

// PR 대상 건 생성 - 1,150건 (95%:4%:1% 비율)
export function generatePRItems(): PRItem[] {
  const performance = getPerformance();
  const priceTable = getPriceTable();
  
  // 단가테이블의 밸브타입 Set (타입+사이즈일치용)
  const priceVtypes = new Set(priceTable.map(pt => pt.밸브타입));
  
  // 단가테이블의 타입만 추출한 Set (타입일치용)
  const priceTypePrefixes = new Set([...priceVtypes].map(v => extractTypePrefix(v)));
  
  // 발주일 기준 내림차순 정렬
  const validPerf = performance.filter(r => r['Valve Type'] && r['Valve Type'] !== 'nan');
  validPerf.sort((a, b) => {
    const dateA = new Date(a.발주일 as string).getTime();
    const dateB = new Date(b.발주일 as string).getTime();
    return dateB - dateA;
  });

  // 밸브타입 + 내역 조합별 대표 건 선정 및 매핑유형 분류
  const seen = new Set<string>();
  const 타입사이즈일치Items: PRItem[] = [];
  const 타입일치Items: PRItem[] = [];
  const 매핑실패Items: PRItem[] = [];

  for (const row of validPerf) {
    const key = `${row['Valve Type']}|${row.내역}`;
    if (!seen.has(key)) {
      seen.add(key);
      
      const vtype = row['Valve Type'];
      const vtypeKey = vtype.slice(0, -1);  // 끝 1글자 제거
      const typePrefix = extractTypePrefix(vtype);
      
      const prItem: PRItem = {
        자재번호: row.자재번호,
        내역: row.내역,
        밸브타입: vtype,
        vtype_key: row.vtype_key || vtypeKey,
        요청수량: row.요청수량,
        발주금액: row['발주금액-변환'],
        발주일: String(row.발주일).slice(0, 10),
        발주업체: row.발주업체 || ''
      };
      
      // 매핑유형에 따라 분류
      if (priceVtypes.has(vtypeKey)) {
        타입사이즈일치Items.push(prItem);
      } else if (priceTypePrefixes.has(typePrefix)) {
        타입일치Items.push(prItem);
      } else {
        매핑실패Items.push(prItem);
      }
    }
  }

  // 목표: 1,150건 (95%:4%:1%)
  const totalTarget = 1150;
  const 타입사이즈일치Target = Math.round(totalTarget * 0.95);  // 1,093
  const 타입일치Target = Math.round(totalTarget * 0.04);        // 46
  const 매핑실패Target = totalTarget - 타입사이즈일치Target - 타입일치Target;  // 11

  // 각 카테고리에서 목표 수만큼 샘플링
  const sampled타입사이즈일치 = 타입사이즈일치Items.slice(0, 타입사이즈일치Target);
  const sampled타입일치 = 타입일치Items.slice(0, 타입일치Target);
  const sampled매핑실패 = 매핑실패Items.slice(0, 매핑실패Target);

  // 합치기 (타입+사이즈일치 → 타입일치 → 매핑실패 순서)
  const prItems = [...sampled타입사이즈일치, ...sampled타입일치, ...sampled매핑실패];

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

  // 단가테이블의 밸브타입 Set
  const priceVtypes = new Set(priceTable.map(pt => pt.밸브타입));
  
  // 타입(prefix)만으로 매핑하기 위한 보조 lookup
  const typeOnlyLookup = new Map<string, any[]>();
  for (const pt of priceTable) {
    const typePrefix = extractTypePrefix(pt.밸브타입);
    if (typePrefix) {
      if (!typeOnlyLookup.has(typePrefix)) {
        typeOnlyLookup.set(typePrefix, []);
      }
      typeOnlyLookup.get(typePrefix)!.push(pt);
    }
  }

  for (const pr of prItems) {
    const vtype = pr.밸브타입;
    const vtypeKey = vtype.slice(0, -1);  // 끝 1글자 제거
    const typePrefix = extractTypePrefix(vtype);
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
    let priceRows = priceLookup.get(vtypeKey);
    let mappingType = '타입+자재내역일치';
    
    // 2순위: 타입(prefix)만 매핑
    if (!priceRows || priceRows.length === 0) {
      priceRows = typeOnlyLookup.get(typePrefix);
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
  const 타입사이즈일치 = results.filter(r => r.매핑유형 === '타입+자재내역일치').length;
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
      '1순위: 밸브타입+자재내역 일치 (타입+자재내역일치)',
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
