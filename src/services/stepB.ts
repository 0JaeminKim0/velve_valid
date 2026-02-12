import { 
  getPerformance, 
  getVendorQuotes, 
  getPriceLookup,
  getPriceTable 
} from './dataLoader';
import { parseOptionsFromDesc, calcOptionPrice } from '../utils/helpers';

// Set2: 견적 수신 데이터 조회
export function getQuoteData(): {
  data: any[];
  summary: {
    total: number;
    columns: number;
    uniqueTypes: number;
  };
  dataType: string;
} {
  const vendorQuotes = getVendorQuotes();
  
  const data = vendorQuotes.map(vr => ({
    No: vr.No,
    자재번호: vr.자재번호,
    자재내역: vr.자재내역,
    밸브타입: vr['Valve Type'] || '',
    수량: vr.수량,
    견적가: vr['견적가-변환'],
    견적번호: vr.견적번호 || ''
  }));

  const uniqueTypes = new Set(vendorQuotes.map(v => v['Valve Type']).filter(Boolean)).size;

  return {
    data,
    summary: {
      total: vendorQuotes.length,
      columns: 7,
      uniqueTypes
    },
    dataType: 'quote'
  };
}

export interface StepB1Result {
  No: number;
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  매핑상태: string;
  매핑유형: string;  // 업무용어: 타입+사이즈일치, 타입일치
  수량: number;
  견적가: number;
  본체가: number;
  옵션가: number;
  계약총액: number;
  차이: string;
}

// Step B-1: 견적 vs 계약단가 비교
// 컬럼순서: 견적가 | 본체가 | 옵션가 | 계약 총액 | 차이
export function executeStepB1(): {
  results: StepB1Result[];
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
  const vendorQuotes = getVendorQuotes();
  const priceLookup = getPriceLookup();
  const priceTable = getPriceTable();
  const results: StepB1Result[] = [];

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

  for (const vr of vendorQuotes) {
    const vk = vr.vtype_key || '';
    const vtype = vr['Valve Type'] || '';
    const desc = vr.자재내역;
    const qty = vr.수량 > 0 ? vr.수량 : 1;
    const descOpts = parseOptionsFromDesc(desc);

    const result: StepB1Result = {
      No: vr.No,
      자재번호: vr.자재번호,
      자재내역: desc,
      밸브타입: vtype,
      매핑상태: '실패',
      매핑유형: '-',
      수량: qty,
      견적가: vr['견적가-변환'],
      본체가: 0,
      옵션가: 0,
      계약총액: 0,
      차이: '-'
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
      // 본체가 = BODY2-변환 (총액)
      const body2 = pt['BODY2-변환'] || 0;
      const ptQty = pt.수량 > 0 ? pt.수량 : 1;
      const unitBody2 = body2 / ptQty;

      const { total: optTotal, detail: optDetail } = calcOptionPrice(
        pt, 
        descOpts, 
        vr.내부도장, 
        vr.외부도장, 
        vr.상세사양
      );
      
      // 본체가 = BODY2-변환 기준 (수량 적용)
      const bodyTotal = unitBody2 * qty;
      const optionTotal = optTotal * qty;
      const contractTotal = bodyTotal + optionTotal;

      result.매핑상태 = '성공';
      result.매핑유형 = mappingType;
      result.본체가 = Math.round(bodyTotal);
      result.옵션가 = Math.round(optionTotal);
      result.계약총액 = Math.round(contractTotal);
      
      // 차이 = (견적가 - 계약총액) / 계약총액 * 100 퍼센티지로 표기
      if (contractTotal > 0) {
        const diffPercent = ((vr['견적가-변환'] - contractTotal) / contractTotal * 100);
        result.차이 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
      }
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
      '본체가 = 단가TBL BODY2-변환',
      '차이 = (견적가-계약총액)/계약총액 × 100%'
    ]
  };
}

export interface StepB2Result {
  No: number;
  자재번호: string;
  자재내역: string;
  매핑유형: string;  // 동일내역, 유사타입, 미매핑
  실적업체: string;
  수량: number;
  견적가: number;
  최근발주가: number;
  목표가: number;
  차이: string;
}

// Step B-2: 견적 vs 발주실적 비교
// 컬럼순서: 견적가 | 최근발주가 | 목표가 | 차이
// 실적개당가 삭제, 차이는 견적가 대비 목표가 퍼센티지
export function executeStepB2(): {
  results: StepB2Result[];
  summary: {
    total: number;
    동일내역: number;
    유사타입: number;
    미매핑: number;
  };
  rules: string[];
} {
  const vendorQuotes = getVendorQuotes();
  const performance = getPerformance();
  const results: StepB2Result[] = [];

  for (const vr of vendorQuotes) {
    const vk = vr.vtype_key || '';
    const desc = vr.자재내역;
    const qty = vr.수량 > 0 ? vr.수량 : 1;

    const result: StepB2Result = {
      No: vr.No,
      자재번호: vr.자재번호,
      자재내역: desc,
      매핑유형: '미매핑',
      실적업체: '',
      수량: qty,
      견적가: vr['견적가-변환'],
      최근발주가: 0,
      목표가: 0,
      차이: '-'
    };

    const pool = performance.filter(r => r.vtype_key === vk);

    if (pool.length > 0) {
      const exactMatch = pool.filter(r => r.내역.trim() === desc.trim());

      if (exactMatch.length > 0) {
        exactMatch.sort((a, b) =>
          new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
        );
        const top = exactMatch[0];
        const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
        const unit = top['발주금액-변환'] / perfQty;
        const recentPrice = unit * qty;
        const targetPrice = recentPrice * 0.9;

        result.매핑유형 = '동일내역';
        result.실적업체 = top.발주업체 || '';
        result.최근발주가 = Math.round(recentPrice);
        result.목표가 = Math.round(targetPrice);
        // 차이 = (견적가 - 목표가) / 목표가 * 100 퍼센티지
        if (targetPrice > 0) {
          const diffPercent = ((vr['견적가-변환'] - targetPrice) / targetPrice * 100);
          result.차이 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
        }
      } else {
        pool.sort((a, b) =>
          new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
        );
        const top = pool[0];
        const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
        const unit = top['발주금액-변환'] / perfQty;
        const recentPrice = unit * qty;
        const targetPrice = recentPrice * 0.9;

        result.매핑유형 = '유사타입';
        result.실적업체 = top.발주업체 || '';
        result.최근발주가 = Math.round(recentPrice);
        result.목표가 = Math.round(targetPrice);
        if (targetPrice > 0) {
          const diffPercent = ((vr['견적가-변환'] - targetPrice) / targetPrice * 100);
          result.차이 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
        }
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
      '목표가 = 최근발주가 × 90%',
      '차이 = (견적가-목표가)/목표가 × 100%'
    ]
  };
}

export interface StepB3Result {
  No: number;
  자재번호: string;
  자재내역: string;
  견적가: number;
  계약단가: number;
  최근발주가: number;
  협상목표가: number;
  적정성: string;
  실적업체: string;
  차이율: string;
  AI코멘트?: string;
}

// Step B-3: 가격 적정성 판정
export function executeStepB3(): {
  results: StepB3Result[];
  summary: {
    total: number;
    우수: number;
    보통: number;
    부적절: number;
    판단불가: number;
  };
  rules: string[];
} {
  const b1Results = executeStepB1().results;
  const b2Results = executeStepB2().results;
  const results: StepB3Result[] = [];

  // B1과 B2 결과 병합
  const b2Map = new Map(b2Results.map(r => [r.No, r]));

  for (const b1 of b1Results) {
    const b2 = b2Map.get(b1.No);

    const result: StepB3Result = {
      No: b1.No,
      자재번호: b1.자재번호,
      자재내역: b1.자재내역,
      견적가: b1.견적가,
      계약단가: b1.계약총액,
      최근발주가: b2?.최근발주가 || 0,
      협상목표가: b2?.목표가 || 0,
      적정성: '판단불가',
      실적업체: b2?.실적업체 || '',
      차이율: '-'
    };

    // 적정성 판정
    const est = result.견적가;
    const r90 = result.협상목표가;
    const r100 = result.최근발주가;
    const cont = result.계약단가;

    if (est <= 0) {
      result.적정성 = '판단불가';
    } else if (r90 > 0 && r90 >= est) {
      result.적정성 = '우수';
      result.차이율 = r100 > 0 ? ((est - r100) / r100 * 100).toFixed(1) : '-';
    } else if ((r100 > 0 && r100 >= est) || (cont > 0 && cont >= est)) {
      result.적정성 = '보통';
      result.차이율 = r100 > 0 ? ((est - r100) / r100 * 100).toFixed(1) : '-';
    } else if (r100 > 0 || cont > 0) {
      result.적정성 = '부적절';
      const basePrice = r100 > 0 ? r100 : cont;
      result.차이율 = basePrice > 0 ? '+' + ((est - basePrice) / basePrice * 100).toFixed(1) : '-';
    } else {
      result.적정성 = '판단불가';
    }

    results.push(result);
  }

  return {
    results,
    summary: {
      total: results.length,
      우수: results.filter(r => r.적정성 === '우수').length,
      보통: results.filter(r => r.적정성 === '보통').length,
      부적절: results.filter(r => r.적정성 === '부적절').length,
      판단불가: results.filter(r => r.적정성 === '판단불가').length
    },
    rules: [
      '우수: 협상목표가(최근발주가×90%) 이하',
      '보통: 최근발주가 또는 계약단가 이하',
      '부적절: 최근발주가, 계약단가 모두 초과'
    ]
  };
}
