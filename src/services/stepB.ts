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
    'Body가': vr['단가-변환'] || 0,
    'N/P': vr['N/P-변환'] || 0,
    '옵션가(OP)': vr['외부도장-변환'] || 0,
    '옵션가(IP)': vr['내부도장-변환'] || 0,
    견적번호: vr.견적번호 || ''
  }));

  const uniqueTypes = new Set(vendorQuotes.map(v => v['Valve Type']).filter(Boolean)).size;

  return {
    data,
    summary: {
      total: vendorQuotes.length,
      columns: 11,
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
  매핑유형: string;  // 업무용어: 타입+자재내역일치, 타입일치
  수량: number;
  견적가: number;
  본체가: number;
  '옵션가(NP)': number;
  '옵션가(OP)': number;
  계약총액: number;
  차이: string;
  원인: string;  // 차이 발생 원인 (간결하게)
}

// Step B-1: 견적 vs 계약단가 비교
// 컬럼순서: 견적가 | 본체가 | 옵션가(NP) | 옵션가(OP) | 계약 총액 | 차이
export function executeStepB1(): {
  results: StepB1Result[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    matchRate: string;
    타입사이즈일치: number;
    타입일치: number;
    검증결과: {
      일치: number;
      견적초과: number;
      견적미달: number;
      본체가차이: number;
      옵션차이: number;
    };
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
      '옵션가(NP)': 0,
      '옵션가(OP)': 0,
      계약총액: 0,
      차이: '-',
      원인: '-'
    };

    // 1순위: vtype_key (타입+사이즈) 매핑
    let priceRows = priceLookup.get(vk);
    let mappingType = '타입+자재내역일치';
    
    // 2순위: 타입만 매핑
    if (!priceRows || priceRows.length === 0) {
      priceRows = typeOnlyLookup.get(vtype);
      mappingType = '타입일치';
    }

    if (priceRows && priceRows.length > 0) {
      const pt = priceRows[0];
      // 본체가 = 바디단가-변환 (kg당 단가) × 견적중량
      const bodyUnitPrice = pt['바디단가-변환'] || 0;  // kg당 계약단가
      const quoteWeight = vr['중량'] || 0;  // 견적 중량 (kg)

      const { total: optTotal, detail: optDetail } = calcOptionPrice(
        pt, 
        descOpts, 
        vr.내부도장, 
        vr.외부도장, 
        vr.상세사양
      );
      
      // NP와 OP 값 추출
      const npValue = (pt['N/P-변환'] || 0) * qty;
      const opValue = (pt['O-P-변환'] || 0) * qty;
      
      // 본체가 = 바디단가-변환 × 견적중량 (수량 적용)
      const bodyTotal = bodyUnitPrice * quoteWeight * qty;
      const optionTotal = optTotal * qty;
      const contractTotal = bodyTotal + optionTotal;

      result.매핑상태 = '성공';
      result.매핑유형 = mappingType;
      result.본체가 = Math.round(bodyTotal);
      result['옵션가(NP)'] = Math.round(npValue);
      result['옵션가(OP)'] = Math.round(opValue);
      result.계약총액 = Math.round(contractTotal);
      
      // 차이 = (견적가 - 계약총액) / 계약총액 * 100 퍼센티지로 표기
      if (contractTotal > 0) {
        const diffPercent = ((vr['견적가-변환'] - contractTotal) / contractTotal * 100);
        result.차이 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
        
        // === 차이 원인 분석 ===
        const diffReasons: string[] = [];
        
        // 견적 데이터에서 구성요소 추출
        const quoteBody = (vr['단가-변환'] || 0) * qty;
        const quoteNP = (vr['N/P-변환'] || 0) * qty;
        const quoteExtCoating = (vr['외부도장-변환'] || 0) * qty;
        const quoteIntCoating = (vr['내부도장-변환'] || 0) * qty;
        const quoteLock = (vr['LOCK-변환'] || 0) * qty;
        
        // 계약 단가표에서 구성요소 추출
        const contractNP = (pt['N/P-변환'] || 0) * qty;
        const contractExtCoating = (pt['O-P-변환'] || 0) * qty;
        const contractIntCoating = (pt['I-P-변환'] || 0) * qty;
        const contractLock = (pt['LOCK-변환'] || 0) * qty;
        
        // 본체가 차이
        const bodyDiff = quoteBody - Math.round(bodyTotal);
        if (Math.abs(bodyDiff) > 100) {
          diffReasons.push(`본체가 ${bodyDiff > 0 ? '+' : ''}${Math.round(bodyDiff).toLocaleString()}`);
        }
        
        // N/P 차이
        const npDiff = quoteNP - contractNP;
        if (Math.abs(npDiff) > 100) {
          diffReasons.push(`N/P ${npDiff > 0 ? '+' : ''}${Math.round(npDiff).toLocaleString()}`);
        }
        
        // 외부도장 차이
        const extDiff = quoteExtCoating - contractExtCoating;
        if (Math.abs(extDiff) > 100) {
          if (contractExtCoating === 0 && quoteExtCoating > 0) {
            diffReasons.push(`외부도장 +${Math.round(extDiff).toLocaleString()}(미계약)`);
          } else {
            diffReasons.push(`외부도장 ${extDiff > 0 ? '+' : ''}${Math.round(extDiff).toLocaleString()}`);
          }
        }
        
        // 내부도장 차이
        const intDiff = quoteIntCoating - contractIntCoating;
        if (Math.abs(intDiff) > 100) {
          if (contractIntCoating === 0 && quoteIntCoating > 0) {
            diffReasons.push(`내부도장 +${Math.round(intDiff).toLocaleString()}(미계약)`);
          } else {
            diffReasons.push(`내부도장 ${intDiff > 0 ? '+' : ''}${Math.round(intDiff).toLocaleString()}`);
          }
        }
        
        // LOCK 차이
        const lockDiff = quoteLock - contractLock;
        if (Math.abs(lockDiff) > 100) {
          if (contractLock === 0 && quoteLock > 0) {
            diffReasons.push(`LOCK +${Math.round(lockDiff).toLocaleString()}(미계약)`);
          } else {
            diffReasons.push(`LOCK ${lockDiff > 0 ? '+' : ''}${Math.round(lockDiff).toLocaleString()}`);
          }
        }
        
        // 원인 문자열 생성
        if (diffReasons.length > 0) {
          result.원인 = diffReasons.join(', ');
        } else if (Math.abs(vr['견적가-변환'] - contractTotal) < 100) {
          result.원인 = '일치';
        } else {
          result.원인 = '기타 옵션 차이';
        }
      }
    }

    results.push(result);
  }

  const matched = results.filter(r => r.매핑상태 === '성공').length;
  const 타입사이즈일치 = results.filter(r => r.매핑유형 === '타입+자재내역일치').length;
  const 타입일치 = results.filter(r => r.매핑유형 === '타입일치').length;
  
  // 차이 검증 통계
  const 일치건수 = results.filter(r => r.원인 === '일치').length;
  const 본체가차이 = results.filter(r => r.원인.includes('본체가')).length;
  const 옵션차이 = results.filter(r => r.원인.includes('외부도장') || r.원인.includes('내부도장') || r.원인.includes('N/P') || r.원인.includes('LOCK')).length;
  const 견적초과 = results.filter(r => {
    const diff = r.차이;
    if (diff === '-') return false;
    const numValue = parseFloat(diff.replace('%', '').replace('+', ''));
    return numValue > 0;
  }).length;
  const 견적미달 = results.filter(r => {
    const diff = r.차이;
    if (diff === '-') return false;
    const numValue = parseFloat(diff.replace('%', '').replace('+', ''));
    return numValue < 0;
  }).length;

  return {
    results,
    summary: {
      total: results.length,
      matched,
      unmatched: results.length - matched,
      matchRate: ((matched / results.length) * 100).toFixed(1) + '%',
      타입사이즈일치,
      타입일치,
      // 차이 검증 요약
      검증결과: {
        일치: 일치건수,
        견적초과: 견적초과,
        견적미달: 견적미달,
        본체가차이: 본체가차이,
        옵션차이: 옵션차이
      }
    },
    rules: [
      '1순위: 밸브타입+자재내역 일치 (타입+자재내역일치)',
      '2순위: 밸브타입만 일치 (타입일치)',
      '본체가 = 바디단가-변환(kg당) × 견적중량',
      '옵션가(NP) = N/P-변환 값',
      '옵션가(OP) = O-P-변환 값',
      '차이 = (견적가-계약총액)/계약총액 × 100%',
      '차이 발생 원인: 본체가, N/P, 외부도장, 내부도장, LOCK 항목별 비교'
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
  'Body가': number;
  '옵션가(IP)': number;
  '옵션가(OP)': number;
  견적가: number;
  발주일: string;
  최근발주가: number;
  목표가: number;
  차이: string;
}

// 자재내역에서 키워드 추출 (유사 매핑용)
function extractDescKeywords(desc: string): { type: string; size: string; pressure: string } {
  const normalized = desc.replace(/\s+/g, ' ').trim();
  
  // 밸브 종류 추출 (GLBE, HOSE, S-CLOSING 등)
  const typeMatch = normalized.match(/^([A-Z-]+)/);
  const type = typeMatch ? typeMatch[1] : '';
  
  // 사이즈 추출 (15A, 25A, 65A 등)
  const sizeMatch = normalized.match(/(\d+A)/);
  const size = sizeMatch ? sizeMatch[1] : '';
  
  // 압력 추출 (5K, 10K, 16K 등)
  const pressMatch = normalized.match(/(\d+K)/);
  const pressure = pressMatch ? pressMatch[1] : '';
  
  return { type, size, pressure };
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
      'Body가': vr['단가-변환'] || 0,
      '옵션가(IP)': vr['내부도장-변환'] || 0,
      '옵션가(OP)': vr['외부도장-변환'] || 0,
      견적가: vr['견적가-변환'],
      발주일: '-',
      최근발주가: 0,
      목표가: 0,
      차이: '-'
    };

    // vtype_key가 없으면 자재내역 기반 유사 매핑 시도
    if (!vk) {
      const qKeywords = extractDescKeywords(desc);
      
      // 타입+사이즈+압력이 일치하는 발주실적 찾기
      if (qKeywords.type && qKeywords.size && qKeywords.pressure) {
        const similarPool = performance.filter(r => {
          if (!r.내역 || !r['Valve Type']) return false;
          const pKeywords = extractDescKeywords(r.내역);
          return pKeywords.type === qKeywords.type && 
                 pKeywords.size === qKeywords.size && 
                 pKeywords.pressure === qKeywords.pressure;
        });
        
        if (similarPool.length > 0) {
          similarPool.sort((a, b) =>
            new Date(b.발주일 as string).getTime() - new Date(a.발주일 as string).getTime()
          );
          const top = similarPool[0];
          const perfQty = top.요청수량 > 0 ? top.요청수량 : 1;
          const unit = top['발주금액-변환'] / perfQty;
          const recentPrice = unit * qty;
          const targetPrice = recentPrice * 0.9;

          result.매핑유형 = '유사타입';
          result.실적업체 = top.발주업체 || '';
          result.발주일 = top.발주일 ? String(top.발주일).substring(0, 10) : '-';
          result.최근발주가 = Math.round(recentPrice);
          result.목표가 = Math.round(targetPrice);
          if (targetPrice > 0) {
            const diffPercent = ((vr['견적가-변환'] - targetPrice) / targetPrice * 100);
            result.차이 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
          }
        }
      }
      
      results.push(result);
      continue;
    }

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
        result.발주일 = top.발주일 ? String(top.발주일).substring(0, 10) : '-';
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
        result.발주일 = top.발주일 ? String(top.발주일).substring(0, 10) : '-';
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
      '유사타입: 밸브타입만 일치 또는 키워드(타입+사이즈+압력) 일치',
      '목표가 = 최근발주가 × 90%',
      '차이 = (견적가-목표가)/목표가 × 100%'
    ]
  };
}

export interface StepB3Result {
  No: number;
  자재번호: string;
  자재내역: string;
  'Body가': number;
  '옵션가(IP)': number;
  '옵션가(OP)': number;
  견적가: number;
  계약단가: number;
  발주일: string;
  최근발주가: number;
  협상목표가: number;
  적정성: string;
  실적업체: string;
  차이율: string;
  AI코멘트?: string;
}

// 차이 분석 인터페이스
export interface PriceDiffDetail {
  항목: string;
  견적가: number;
  계약단가: number;
  차이: number;
  차이율: string;
  비고: string;
}

export interface PriceDiffAnalysis {
  No: number;
  자재번호: string;
  자재내역: string;
  밸브타입: string;
  매핑상태: string;
  견적가: number;
  계약총액: number;
  차이: number;
  차이율: string;
  상세분석: PriceDiffDetail[];
  차이원인: string[];
}

// Step B-1 확장: 견적가 vs 계약총액 차이 원인 분석
export function analyzePriceDifference(itemNo?: number): {
  results: PriceDiffAnalysis[];
  summary: {
    total: number;
    analyzed: number;
    hasBodyDiff: number;
    hasOptionDiff: number;
    hasMissingOption: number;
  };
} {
  const vendorQuotes = getVendorQuotes();
  const priceLookup = getPriceLookup();
  const priceTable = getPriceTable();
  const results: PriceDiffAnalysis[] = [];

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

  const targetQuotes = itemNo 
    ? vendorQuotes.filter(v => v.No === itemNo)
    : vendorQuotes;

  for (const vr of targetQuotes) {
    const vk = vr.vtype_key || '';
    const vtype = vr['Valve Type'] || '';
    const desc = vr.자재내역;
    const qty = vr.수량 > 0 ? vr.수량 : 1;

    const analysis: PriceDiffAnalysis = {
      No: vr.No,
      자재번호: vr.자재번호,
      자재내역: desc,
      밸브타입: vtype,
      매핑상태: '실패',
      견적가: vr['견적가-변환'],
      계약총액: 0,
      차이: 0,
      차이율: '-',
      상세분석: [],
      차이원인: []
    };

    // 1순위: vtype_key (타입+사이즈) 매핑
    let priceRows = priceLookup.get(vk);
    
    // 2순위: 타입만 매핑
    if (!priceRows || priceRows.length === 0) {
      priceRows = typeOnlyLookup.get(vtype);
    }

    if (!priceRows || priceRows.length === 0) {
      analysis.차이원인.push('단가표 매핑 실패 - 계약단가 비교 불가');
      results.push(analysis);
      continue;
    }

    analysis.매핑상태 = '성공';
    const pt = priceRows[0];

    // === 견적 데이터에서 구성요소 추출 ===
    const quoteBody = vr['단가-변환'] || 0;  // 견적 본체가
    const quoteNP = vr['N/P-변환'] || 0;
    const quoteExtCoating = vr['외부도장-변환'] || 0;
    const quoteIntCoating = vr['내부도장-변환'] || 0;
    const quoteLock = vr['LOCK-변환'] || 0;
    const quoteRubC = vr['RUB-C-변환'] || 0;
    const quoteWeight = vr['중량'] || 0;

    // === 계약 단가표에서 구성요소 추출 ===
    const contractBodyUnit = pt['바디단가-변환'] || 0;  // kg당 단가
    const contractBody = contractBodyUnit * quoteWeight * qty;
    const contractNP = (pt['N/P-변환'] || 0) * qty;
    const contractExtCoating = (pt['O-P-변환'] || 0) * qty;
    const contractIntCoating = (pt['I-P-변환'] || 0) * qty;
    const contractLock = (pt['LOCK-변환'] || 0) * qty;
    const contractDisc = (pt['DISC-SCS16-변환'] || 0) * qty;

    // 계약총액 계산 (실제 옵션 항목 기반)
    let contractTotal = contractBody;
    const optionItems: PriceDiffDetail[] = [];

    // === 상세 비교 분석 ===
    // 1. 본체가 비교
    const bodyDiff = (quoteBody * qty) - contractBody;
    const bodyDiffRate = contractBody > 0 ? (bodyDiff / contractBody * 100) : 0;
    analysis.상세분석.push({
      항목: '본체가',
      견적가: Math.round(quoteBody * qty),
      계약단가: Math.round(contractBody),
      차이: Math.round(bodyDiff),
      차이율: contractBody > 0 ? (bodyDiffRate >= 0 ? '+' : '') + bodyDiffRate.toFixed(1) + '%' : '-',
      비고: `kg당 단가: 견적 ${vr['KG당/단가-변환'] || 0}원, 계약 ${contractBodyUnit}원 (중량 ${quoteWeight}kg)`
    });

    if (Math.abs(bodyDiff) > 100) {
      if (bodyDiff > 0) {
        analysis.차이원인.push(`본체가 상승 (+${Math.round(bodyDiff).toLocaleString()}원): kg당 단가 또는 중량 차이`);
      } else {
        analysis.차이원인.push(`본체가 하락 (${Math.round(bodyDiff).toLocaleString()}원): kg당 단가 또는 중량 차이`);
      }
    }

    // 2. N/P 비교
    if (quoteNP > 0 || contractNP > 0) {
      const npDiff = (quoteNP * qty) - contractNP;
      contractTotal += contractNP;
      analysis.상세분석.push({
        항목: 'N/P(네임플레이트)',
        견적가: Math.round(quoteNP * qty),
        계약단가: Math.round(contractNP),
        차이: Math.round(npDiff),
        차이율: contractNP > 0 ? (npDiff >= 0 ? '+' : '') + (npDiff / contractNP * 100).toFixed(1) + '%' : '-',
        비고: contractNP === 0 ? '계약단가표에 N/P 단가 없음' : ''
      });
      if (Math.abs(npDiff) > 100) {
        if (contractNP === 0) {
          analysis.차이원인.push(`N/P 추가 (+${Math.round(npDiff).toLocaleString()}원): 계약에 미포함된 옵션`);
        } else {
          analysis.차이원인.push(`N/P 단가 차이 (${npDiff > 0 ? '+' : ''}${Math.round(npDiff).toLocaleString()}원)`);
        }
      }
    }

    // 3. 외부도장 비교
    if (quoteExtCoating > 0 || contractExtCoating > 0) {
      const extDiff = (quoteExtCoating * qty) - contractExtCoating;
      contractTotal += contractExtCoating;
      analysis.상세분석.push({
        항목: '외부도장(O-P)',
        견적가: Math.round(quoteExtCoating * qty),
        계약단가: Math.round(contractExtCoating),
        차이: Math.round(extDiff),
        차이율: contractExtCoating > 0 ? (extDiff >= 0 ? '+' : '') + (extDiff / contractExtCoating * 100).toFixed(1) + '%' : '-',
        비고: contractExtCoating === 0 ? '계약단가표에 외부도장 단가 없음' : `도장코드: ${vr.외부도장 || 'N/A'}`
      });
      if (Math.abs(extDiff) > 100) {
        if (contractExtCoating === 0) {
          analysis.차이원인.push(`외부도장 추가 (+${Math.round(extDiff).toLocaleString()}원): 계약에 미포함된 옵션`);
        } else {
          analysis.차이원인.push(`외부도장 단가 차이 (${extDiff > 0 ? '+' : ''}${Math.round(extDiff).toLocaleString()}원)`);
        }
      }
    }

    // 4. 내부도장 비교
    if (quoteIntCoating > 0 || contractIntCoating > 0) {
      const intDiff = (quoteIntCoating * qty) - contractIntCoating;
      contractTotal += contractIntCoating;
      analysis.상세분석.push({
        항목: '내부도장(I-P)',
        견적가: Math.round(quoteIntCoating * qty),
        계약단가: Math.round(contractIntCoating),
        차이: Math.round(intDiff),
        차이율: contractIntCoating > 0 ? (intDiff >= 0 ? '+' : '') + (intDiff / contractIntCoating * 100).toFixed(1) + '%' : '-',
        비고: contractIntCoating === 0 ? '계약단가표에 내부도장 단가 없음' : `도장코드: ${vr.내부도장 || 'N/A'}`
      });
      if (Math.abs(intDiff) > 100) {
        if (contractIntCoating === 0) {
          analysis.차이원인.push(`내부도장 추가 (+${Math.round(intDiff).toLocaleString()}원): 계약에 미포함된 옵션`);
        } else {
          analysis.차이원인.push(`내부도장 단가 차이 (${intDiff > 0 ? '+' : ''}${Math.round(intDiff).toLocaleString()}원)`);
        }
      }
    }

    // 5. LOCK 비교
    if (quoteLock > 0 || contractLock > 0) {
      const lockDiff = (quoteLock * qty) - contractLock;
      contractTotal += contractLock;
      analysis.상세분석.push({
        항목: 'LOCK',
        견적가: Math.round(quoteLock * qty),
        계약단가: Math.round(contractLock),
        차이: Math.round(lockDiff),
        차이율: contractLock > 0 ? (lockDiff >= 0 ? '+' : '') + (lockDiff / contractLock * 100).toFixed(1) + '%' : '-',
        비고: contractLock === 0 ? '계약단가표에 LOCK 단가 없음' : ''
      });
      if (Math.abs(lockDiff) > 100) {
        if (contractLock === 0) {
          analysis.차이원인.push(`LOCK 추가 (+${Math.round(lockDiff).toLocaleString()}원): 계약에 미포함된 옵션`);
        } else {
          analysis.차이원인.push(`LOCK 단가 차이 (${lockDiff > 0 ? '+' : ''}${Math.round(lockDiff).toLocaleString()}원)`);
        }
      }
    }

    // 6. RUB-C/DISC 비교
    if (quoteRubC > 0 || contractDisc > 0) {
      const discDiff = (quoteRubC * qty) - contractDisc;
      contractTotal += contractDisc;
      analysis.상세분석.push({
        항목: 'RUB-C/DISC',
        견적가: Math.round(quoteRubC * qty),
        계약단가: Math.round(contractDisc),
        차이: Math.round(discDiff),
        차이율: contractDisc > 0 ? (discDiff >= 0 ? '+' : '') + (discDiff / contractDisc * 100).toFixed(1) + '%' : '-',
        비고: contractDisc === 0 ? '계약단가표에 DISC 단가 없음' : ''
      });
      if (Math.abs(discDiff) > 100) {
        analysis.차이원인.push(`RUB-C/DISC 단가 차이 (${discDiff > 0 ? '+' : ''}${Math.round(discDiff).toLocaleString()}원)`);
      }
    }

    // === 총합 계산 ===
    analysis.계약총액 = Math.round(contractTotal);
    analysis.차이 = Math.round(analysis.견적가 - contractTotal);
    
    if (contractTotal > 0) {
      const diffPercent = (analysis.견적가 - contractTotal) / contractTotal * 100;
      analysis.차이율 = (diffPercent >= 0 ? '+' : '') + diffPercent.toFixed(1) + '%';
    }

    // 총합 정보 추가
    analysis.상세분석.push({
      항목: '합계',
      견적가: analysis.견적가,
      계약단가: analysis.계약총액,
      차이: analysis.차이,
      차이율: analysis.차이율,
      비고: `수량: ${qty}개`
    });

    // 차이 원인 없으면 기본 메시지
    if (analysis.차이원인.length === 0) {
      if (Math.abs(analysis.차이) < 100) {
        analysis.차이원인.push('견적가와 계약총액이 거의 일치');
      } else {
        analysis.차이원인.push('원인 불명 - 상세 항목 확인 필요');
      }
    }

    results.push(analysis);
  }

  // 요약 통계
  const analyzed = results.filter(r => r.매핑상태 === '성공').length;
  const hasBodyDiff = results.filter(r => 
    r.상세분석.some(d => d.항목 === '본체가' && Math.abs(d.차이) > 100)
  ).length;
  const hasOptionDiff = results.filter(r => 
    r.상세분석.some(d => d.항목 !== '본체가' && d.항목 !== '합계' && Math.abs(d.차이) > 100)
  ).length;
  const hasMissingOption = results.filter(r => 
    r.차이원인.some(reason => reason.includes('계약에 미포함'))
  ).length;

  return {
    results,
    summary: {
      total: results.length,
      analyzed,
      hasBodyDiff,
      hasOptionDiff,
      hasMissingOption
    }
  };
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
      'Body가': b1.본체가 || 0,
      '옵션가(IP)': b2?.['옵션가(IP)'] || 0,
      '옵션가(OP)': b2?.['옵션가(OP)'] || 0,
      견적가: b1.견적가,
      계약단가: b1.계약총액,
      발주일: b2?.발주일 || '-',
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
