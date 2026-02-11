import { 
  getPerformance, 
  getVendorQuotes, 
  getPriceLookup 
} from './dataLoader';
import { parseOptionsFromDesc, calcOptionPrice } from '../utils/helpers';

export interface StepB1Result {
  No: number;
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  vtype_key: string;
  매핑상태: string;
  본체가: number;
  옵션가: number;
  합계: number;
  수량: number;
  계약총액: number;
  견적가: number;
  차이: number;
  차이율: string;
  옵션상세: string;
}

// Step B-1: 견적 vs 계약단가 비교
export function executeStepB1(): {
  results: StepB1Result[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    matchRate: string;
  };
} {
  const vendorQuotes = getVendorQuotes();
  const priceLookup = getPriceLookup();
  const results: StepB1Result[] = [];

  for (const vr of vendorQuotes) {
    const vk = vr.vtype_key || '';
    const desc = vr.자재내역;
    const qty = vr.수량 > 0 ? vr.수량 : 1;
    const descOpts = parseOptionsFromDesc(desc);

    const result: StepB1Result = {
      No: vr.No,
      자재번호: vr.자재번호,
      자재내역: desc,
      밸브타입: vr['Valve Type'] || '',
      vtype_key: vk,
      매핑상태: '실패',
      본체가: 0,
      옵션가: 0,
      합계: 0,
      수량: qty,
      계약총액: 0,
      견적가: vr['견적가-변환'],
      차이: 0,
      차이율: '-',
      옵션상세: '-'
    };

    const priceRows = priceLookup.get(vk);
    if (priceRows && priceRows.length > 0) {
      const pt = priceRows[0];
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
      const unitSum = unitBody2 + optTotal;
      const contractTotal = unitSum * qty;

      result.매핑상태 = '성공';
      result.본체가 = Math.round(unitBody2);
      result.옵션가 = Math.round(optTotal);
      result.합계 = Math.round(unitSum);
      result.계약총액 = Math.round(contractTotal);
      result.차이 = Math.round(vr['견적가-변환'] - contractTotal);
      result.차이율 = contractTotal > 0 
        ? ((vr['견적가-변환'] - contractTotal) / contractTotal * 100).toFixed(1) + '%'
        : '-';
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

export interface StepB2Result {
  No: number;
  자재번호: string;
  자재내역: string;
  매핑유형: string;
  실적업체: string;
  실적발주일: string;
  실적개당가: number;
  수량: number;
  최근발주가: number;
  협상목표가: number;
  견적가: number;
  차이: number;
  차이율: string;
}

// Step B-2: 견적 vs 발주실적 비교
export function executeStepB2(): {
  results: StepB2Result[];
  summary: {
    total: number;
    동일내역: number;
    유사타입: number;
    미매핑: number;
  };
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
      실적발주일: '',
      실적개당가: 0,
      수량: qty,
      최근발주가: 0,
      협상목표가: 0,
      견적가: vr['견적가-변환'],
      차이: 0,
      차이율: '-'
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

        result.매핑유형 = '동일내역';
        result.실적업체 = top.발주업체 || '';
        result.실적발주일 = String(top.발주일).slice(0, 10);
        result.실적개당가 = Math.round(unit);
        result.최근발주가 = Math.round(recentPrice);
        result.협상목표가 = Math.round(recentPrice * 0.9);
        result.차이 = Math.round(vr['견적가-변환'] - recentPrice);
        result.차이율 = recentPrice > 0
          ? ((vr['견적가-변환'] - recentPrice) / recentPrice * 100).toFixed(1) + '%'
          : '-';
      } else {
        pool.sort((a, b) =>
          new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
        );
        const top = pool[0];
        const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
        const unit = top['발주금액-변환'] / perfQty;
        const recentPrice = unit * qty;

        result.매핑유형 = '유사타입';
        result.실적업체 = top.발주업체 || '';
        result.실적발주일 = String(top.발주일).slice(0, 10);
        result.실적개당가 = Math.round(unit);
        result.최근발주가 = Math.round(recentPrice);
        result.협상목표가 = Math.round(recentPrice * 0.9);
        result.차이 = Math.round(vr['견적가-변환'] - recentPrice);
        result.차이율 = recentPrice > 0
          ? ((vr['견적가-변환'] - recentPrice) / recentPrice * 100).toFixed(1) + '%'
          : '-';
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
      협상목표가: b2?.협상목표가 || 0,
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
      result.차이율 = r100 > 0 ? ((est - r100) / r100 * 100).toFixed(1) + '%' : '-';
    } else if ((r100 > 0 && r100 >= est) || (cont > 0 && cont >= est)) {
      result.적정성 = '보통';
      result.차이율 = r100 > 0 ? ((est - r100) / r100 * 100).toFixed(1) + '%' : '-';
    } else if (r100 > 0 || cont > 0) {
      result.적정성 = '부적절';
      const basePrice = r100 > 0 ? r100 : cont;
      result.차이율 = basePrice > 0 ? '+' + ((est - basePrice) / basePrice * 100).toFixed(1) + '%' : '-';
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
    }
  };
}
