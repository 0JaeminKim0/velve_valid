import * as fs from 'fs';
import * as path from 'path';

// 타입 정의
export interface PriceTableRow {
  밸브타입: string;
  NO: number;
  PKG: string;
  제품: string;
  BODY: string;
  STEM: string;
  커넥션: string;
  압력: string;
  사이즈: string;
  자재내역: string;
  상세사양: string;
  수량: number;
  'BODY2-변환': number;
  '중량(한화오션)': number;
  업체명: string;
  'N/P-변환': number;
  'O-P-변환': number;
  'I-P-변환': number;
  'LOCK-변환': number;
  'IND-변환': number;
  'L/SW-변환': number;
  'EXT-변환': number;
  'DISC-SCS13-변환': number;
  'DISC-SCS14-변환': number;
  'DISC-SCS16-변환': number;
  [key: string]: any;
}

export interface VendorQuoteRow {
  No: number;
  자재번호: string;
  자재내역: string;
  프로젝트: string;
  계약납기: string;
  수량: number;
  내부도장: string;
  외부도장: string;
  상세사양: string;
  중량: number;
  '견적가-변환': number;
  '검토 내용': string;
  'Valve Type'?: string;
  vtype_key?: string;
  [key: string]: any;
}

export interface PerformanceRow {
  'PMG 이름': string;
  자재번호: string;
  내역: string;
  발주업체: string;
  발주일: string | number;
  '발주금액-변환': number;
  요청수량: number;
  '단중(kg)': number;
  'Valve Type': string;
  vtype_key?: string;
  [key: string]: any;
}

export interface LMERow {
  월: string;
  '구리 (USD/톤)': number;
  '주석 (USD/톤)': number;
  [key: string]: any;
}

// 캐시된 데이터
let cachedData: {
  priceTable: PriceTableRow[];
  vendorQuotes: VendorQuoteRow[];
  performance: PerformanceRow[];
  lme: LMERow[];
  priceLookup: Map<string, PriceTableRow[]>;
} | null = null;

// 숫자 변환 헬퍼
function toNumber(val: any): number {
  if (val === null || val === undefined || val === '' || val === 'NaN') return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
}

// 문자열 정리 헬퍼
function cleanString(val: any): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// 데이터 로딩
export async function loadAllData(): Promise<typeof cachedData> {
  if (cachedData) return cachedData;

  const dataDir = path.resolve(process.cwd(), 'data');
  
  console.log('📁 Loading data files from JSON...');

  // JSON 파일들 로드
  const priceFile = path.join(dataDir, 'price_table.json');
  const vendorFile = path.join(dataDir, 'vendor_quotes.json');
  const perfFile = path.join(dataDir, 'performance.json');
  const lmeFile = path.join(dataDir, 'lme.json');

  // 단가테이블
  console.log('  - Loading 단가테이블...');
  const priceTable: PriceTableRow[] = JSON.parse(fs.readFileSync(priceFile, 'utf-8'));
  
  // 데이터 정제
  priceTable.forEach(row => {
    row.밸브타입 = cleanString(row.밸브타입);
    row['BODY2-변환'] = toNumber(row['BODY2-변환']);
    row.수량 = toNumber(row.수량) || 1;
    row['N/P-변환'] = toNumber(row['N/P-변환']);
    row['O-P-변환'] = toNumber(row['O-P-변환']);
    row['I-P-변환'] = toNumber(row['I-P-변환']);
    row['LOCK-변환'] = toNumber(row['LOCK-변환']);
    row['IND-변환'] = toNumber(row['IND-변환']);
    row['EXT-변환'] = toNumber(row['EXT-변환']);
    row['DISC-SCS13-변환'] = toNumber(row['DISC-SCS13-변환']);
    row['DISC-SCS14-변환'] = toNumber(row['DISC-SCS14-변환']);
    row['DISC-SCS16-변환'] = toNumber(row['DISC-SCS16-변환']);
  });

  // 단가테이블 lookup 생성
  const priceLookup = new Map<string, PriceTableRow[]>();
  priceTable.forEach(row => {
    const key = row.밸브타입;
    if (!priceLookup.has(key)) {
      priceLookup.set(key, []);
    }
    priceLookup.get(key)!.push(row);
  });

  // 발주 실적
  console.log('  - Loading 발주 실적...');
  const performance: PerformanceRow[] = JSON.parse(fs.readFileSync(perfFile, 'utf-8'));
  
  performance.forEach(row => {
    row['Valve Type'] = cleanString(row['Valve Type']);
    row.자재번호 = cleanString(row.자재번호);
    row.내역 = cleanString(row.내역);
    row['발주금액-변환'] = toNumber(row['발주금액-변환']);
    row.요청수량 = toNumber(row.요청수량) || 1;
    row['단중(kg)'] = toNumber(row['단중(kg)']);
    // vtype_key 생성 (끝자리 제거)
    if (row['Valve Type'] && row['Valve Type'].length > 1) {
      row.vtype_key = row['Valve Type'].slice(0, -1);
    } else {
      row.vtype_key = '';
    }
  });

  // 자재번호 → 밸브타입 매핑 생성
  const matToVtype = new Map<string, string>();
  performance.forEach(row => {
    if (row['Valve Type'] && row.자재번호) {
      matToVtype.set(row.자재번호, row['Valve Type']);
    }
  });

  // 협력사 견적
  console.log('  - Loading 협력사 견적...');
  const vendorQuotes: VendorQuoteRow[] = JSON.parse(fs.readFileSync(vendorFile, 'utf-8'));
  
  vendorQuotes.forEach(row => {
    row.자재번호 = cleanString(row.자재번호);
    row.자재내역 = cleanString(row.자재내역);
    row.수량 = toNumber(row.수량) || 1;
    row.중량 = toNumber(row.중량);
    row['견적가-변환'] = toNumber(row['견적가-변환']);
    row.내부도장 = cleanString(row.내부도장);
    row.외부도장 = cleanString(row.외부도장);
    row.상세사양 = cleanString(row.상세사양);
    
    // 밸브타입 매핑
    const vtype = matToVtype.get(row.자재번호);
    if (vtype) {
      row['Valve Type'] = vtype;
      row.vtype_key = vtype.length > 1 ? vtype.slice(0, -1) : '';
    }
  });

  // LME 시황
  console.log('  - Loading LME 시황...');
  const lme: LMERow[] = JSON.parse(fs.readFileSync(lmeFile, 'utf-8'));
  
  lme.forEach(row => {
    row['구리 (USD/톤)'] = toNumber(row['구리 (USD/톤)']);
    row['주석 (USD/톤)'] = toNumber(row['주석 (USD/톤)']);
  });

  cachedData = {
    priceTable,
    vendorQuotes,
    performance,
    lme,
    priceLookup
  };

  console.log('✅ Data loaded successfully');
  console.log(`  - 단가테이블: ${priceTable.length}건`);
  console.log(`  - 협력사 견적: ${vendorQuotes.length}건`);
  console.log(`  - 발주 실적: ${performance.length}건`);
  console.log(`  - LME 시황: ${lme.length}건`);

  return cachedData;
}

// 데이터 접근자
export function getPriceTable() {
  return cachedData?.priceTable || [];
}

export function getVendorQuotes() {
  return cachedData?.vendorQuotes || [];
}

export function getPerformance() {
  return cachedData?.performance || [];
}

export function getLME() {
  return cachedData?.lme || [];
}

export function getPriceLookup() {
  return cachedData?.priceLookup || new Map();
}

// 데이터 요약 정보
export function getDataSummary() {
  return {
    priceTable: {
      count: cachedData?.priceTable.length || 0,
      columns: cachedData?.priceTable[0] ? Object.keys(cachedData.priceTable[0]).length : 0,
      uniqueValveTypes: new Set(cachedData?.priceTable.map(r => r.밸브타입)).size
    },
    vendorQuotes: {
      count: cachedData?.vendorQuotes.length || 0,
      columns: cachedData?.vendorQuotes[0] ? Object.keys(cachedData.vendorQuotes[0]).length : 0,
      mappedCount: cachedData?.vendorQuotes.filter(r => r['Valve Type']).length || 0
    },
    performance: {
      count: cachedData?.performance.length || 0,
      columns: cachedData?.performance[0] ? Object.keys(cachedData.performance[0]).length : 0,
      validValveTypes: cachedData?.performance.filter(r => r['Valve Type']).length || 0
    },
    lme: {
      count: cachedData?.lme.length || 0,
      columns: cachedData?.lme[0] ? Object.keys(cachedData.lme[0]).length : 0
    }
  };
}
