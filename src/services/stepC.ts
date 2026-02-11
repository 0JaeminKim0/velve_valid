import { getPerformance, getLME } from './dataLoader';
import { getTrend, getMarketJudgment } from '../utils/helpers';

export interface LMEData {
  월: string;
  연월: string;
  구리: number;
  주석: number;
  Bronze환산: number;
}

export interface MonthlyVendorPrice {
  발주연월: string;
  발주업체: string;
  평균단가: number;
  건수: number;
  총금액: number;
  총수량: number;
}

export interface MarketTrendResult {
  업체: string;
  기간: string;
  이전단가: number;
  현재단가: number;
  '단가변동(%)': number;
  발주트렌드: string;
  시황트렌드: string;
  '시황변동(%)': number;
  '추정이익/손해액': number;
  적정성: string;
}

// LME 데이터 파싱
export function getLMEData(): LMEData[] {
  const lme = getLME();
  const monthMap: Record<string, string> = {};
  for (let i = 1; i <= 12; i++) {
    monthMap[`${i}월`] = String(i).padStart(2, '0');
  }

  return lme
    .filter(row => row.월 && monthMap[row.월])
    .map(row => {
      const cu = row['구리 (USD/톤)'] || 0;
      const sn = row['주석 (USD/톤)'] || 0;
      return {
        월: row.월,
        연월: `2025-${monthMap[row.월]}`,
        구리: cu,
        주석: sn,
        Bronze환산: Math.round(cu * 0.88 + sn * 0.12)
      };
    });
}

// 업체별 월별 평균단가 (VGBARR240AT 대상)
export function getMonthlyVendorPrices(): MonthlyVendorPrice[] {
  const performance = getPerformance();

  // VGBARR240AT, LOCK 제외, TR로 끝나는 건만
  const target = performance.filter(row => {
    const vtype = row['Valve Type'];
    const desc = row.내역 || '';
    return (
      vtype === 'VGBARR240AT' &&
      !desc.toUpperCase().includes('LOCK') &&
      desc.trim().endsWith('TR')
    );
  });

  // 발주연월 추출
  const withMonth = target.map(row => {
    const date = new Date(row.발주일 as string);
    const ym = isNaN(date.getTime()) ? '' : 
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const qty = row.요청수량 > 0 ? row.요청수량 : 1;
    return {
      ...row,
      발주연월: ym,
      개당단가: row['발주금액-변환'] / qty
    };
  }).filter(row => row.발주연월);

  // 그룹핑
  const grouped = new Map<string, typeof withMonth>();
  for (const row of withMonth) {
    const key = `${row.발주연월}|${row.발주업체}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(row);
  }

  // 집계
  const results: MonthlyVendorPrice[] = [];
  for (const [key, rows] of grouped) {
    const [ym, vendor] = key.split('|');
    const totalAmount = rows.reduce((sum, r) => sum + r['발주금액-변환'], 0);
    const totalQty = rows.reduce((sum, r) => sum + r.요청수량, 0);
    const avgPrice = rows.reduce((sum, r) => sum + r.개당단가, 0) / rows.length;

    results.push({
      발주연월: ym,
      발주업체: vendor,
      평균단가: Math.round(avgPrice),
      건수: rows.length,
      총금액: Math.round(totalAmount),
      총수량: totalQty
    });
  }

  return results.sort((a, b) => {
    if (a.발주업체 !== b.발주업체) return a.발주업체.localeCompare(b.발주업체);
    return a.발주연월.localeCompare(b.발주연월);
  });
}

// 시황 대비 가격 트렌드 분석
export function executeStepC(): {
  lmeData: LMEData[];
  monthlyPrices: MonthlyVendorPrice[];
  trendResults: MarketTrendResult[];
  summary: {
    targetCount: number;
    양호: number;
    적정: number;
    주의: number;
  };
} {
  const lmeData = getLMEData();
  const monthlyPrices = getMonthlyVendorPrices();
  
  // LME lookup
  const lmeLookup = new Map(lmeData.map(d => [d.연월, d]));

  // 트렌드 분석
  const trendResults: MarketTrendResult[] = [];
  const vendors = [...new Set(monthlyPrices.map(p => p.발주업체))];

  for (const vendor of vendors) {
    const vendorData = monthlyPrices
      .filter(p => p.발주업체 === vendor)
      .sort((a, b) => a.발주연월.localeCompare(b.발주연월));

    for (let i = 1; i < vendorData.length; i++) {
      const prev = vendorData[i - 1];
      const curr = vendorData[i];
      
      const priceTrend = getTrend(curr.평균단가, prev.평균단가);
      
      const prevLme = lmeLookup.get(prev.발주연월);
      const currLme = lmeLookup.get(curr.발주연월);
      
      let marketTrend = '데이터없음';
      let marketChange = 0;
      
      if (prevLme && currLme) {
        marketTrend = getTrend(currLme.Bronze환산, prevLme.Bronze환산);
        marketChange = prevLme.Bronze환산 > 0 
          ? (currLme.Bronze환산 - prevLme.Bronze환산) / prevLme.Bronze환산 * 100 
          : 0;
      }

      const priceChange = prev.평균단가 > 0 
        ? (curr.평균단가 - prev.평균단가) / prev.평균단가 * 100 
        : 0;

      // 추정이익/손해액 계산
      // Case 1: 둘 다 변동 있음 → 기존 식
      // Case 2: 단가변동=0, 시황변동≠0 → 시황 움직임 대비 단가 유지 = 이익(+)/손해(-)
      // Case 3: 시황변동=0, 단가변동≠0 → 시황 무변동 대비 단가 움직임 = 손해
      // Case 4: 둘 다 0 → 0원
      const pc = priceChange;  // 단가변동(%)
      const mc = marketChange; // 시황변동(%)
      const halfMc = mc !== 0 ? mc / 2 : 0;
      
      let estPL = 0;
      if (pc !== 0 && halfMc !== 0) {
        // Case 1: 둘 다 변동
        estPL = Math.round(curr.평균단가 * (pc / halfMc));
      } else if (pc === 0 && mc !== 0) {
        // Case 2: 시황이 움직였는데 단가 유지 → 시황 상승분 = 이익, 하락분 = 손해
        estPL = Math.round(curr.평균단가 * (mc / 100));
      } else if (mc === 0 && pc !== 0) {
        // Case 3: 시황 안 움직였는데 단가 변동 → 단가 상승 = 손해, 하락 = 이익
        estPL = Math.round(curr.평균단가 * (-pc / 100));
      } else {
        // Case 4: 둘 다 0
        estPL = 0;
      }

      trendResults.push({
        업체: vendor,
        기간: `${prev.발주연월} → ${curr.발주연월}`,
        이전단가: prev.평균단가,
        현재단가: curr.평균단가,
        '단가변동(%)': Math.round(priceChange * 10) / 10,
        발주트렌드: priceTrend,
        시황트렌드: marketTrend,
        '시황변동(%)': Math.round(marketChange * 10) / 10,
        '추정이익/손해액': estPL,
        적정성: getMarketJudgment(priceTrend, marketTrend)
      });
    }
  }

  // 대상 건수 (VGBARR240AT 필터링된 건수)
  const performance = getPerformance();
  const targetCount = performance.filter(row => {
    const vtype = row['Valve Type'];
    const desc = row.내역 || '';
    return (
      vtype === 'VGBARR240AT' &&
      !desc.toUpperCase().includes('LOCK') &&
      desc.trim().endsWith('TR')
    );
  }).length;

  return {
    lmeData,
    monthlyPrices,
    trendResults,
    summary: {
      targetCount,
      양호: trendResults.filter(r => r.적정성 === '양호').length,
      적정: trendResults.filter(r => r.적정성 === '적정').length,
      주의: trendResults.filter(r => r.적정성 === '주의').length
    }
  };
}
