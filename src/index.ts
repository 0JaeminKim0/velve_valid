import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import * as fs from 'fs';
import * as path from 'path';

import { 
  loadAllData, 
  getDataSummary, 
  getPriceTable, 
  getVendorQuotes, 
  getPerformance, 
  getLME 
} from './services/dataLoader';
import { executeStepA1, executeStepA2, generatePRItems, getPRData } from './services/stepA';
import { executeStepB1, executeStepB2, executeStepB3, getQuoteData, analyzePriceDifference } from './services/stepB';
import { executeStepC, getLMEData, getMonthlyVendorPrices } from './services/stepC';
import { 
  generateItemComment, 
  generateBatchComments, 
  generateMarketReport, 
  checkAPIKey 
} from './services/aiService';

const app = new Hono();

// CORS 설정
app.use('/*', cors());

// 전역 에러 핸들러 - 모든 오류를 JSON으로 반환 (프론트엔드 res.json() 파싱 실패 방지)
app.onError((err, c) => {
  console.error('❌ API Error:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

// 404 핸들러 - JSON으로 반환
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// 정적 파일 서빙
app.use('/static/*', serveStatic({ root: './public' }));

// 메인 페이지
app.get('/', async (c) => {
  const htmlPath = path.resolve(process.cwd(), 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  return c.html(html);
});

// API 키 상태 확인
app.get('/api/status', (c) => {
  const apiStatus = checkAPIKey();
  return c.json({
    status: 'ok',
    apiKey: apiStatus,
    timestamp: new Date().toISOString()
  });
});

// ==================== Set 1: PR 건별 적정 단가 분석 ====================

// Set1-PR: PR 접수 데이터 조회
app.get('/api/set1/pr', async (c) => {
  try {
    await loadAllData();
    const result = getPRData();
    
    return c.json({
      step: 'PR',
      title: 'PR 접수',
      message: `구매요청 ${result.summary.total.toLocaleString()}건을 접수했습니다. (${result.summary.uniqueTypes}개 밸브타입)`,
      ...result
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ==================== Set 2: 협력사 견적서 분석 ====================

// Set2-Quote: 견적 수신 데이터 조회
app.get('/api/set2/quote', async (c) => {
  try {
    await loadAllData();
    const result = getQuoteData();
    
    return c.json({
      step: 'Quote',
      title: '견적 수신',
      message: `협력사 견적 ${result.summary.total}건을 수신했습니다. (${result.summary.uniqueTypes}개 밸브타입)`,
      ...result
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ==================== Legacy API (호환용) ====================

// Step 0: 데이터 로딩
app.get('/api/step/0', async (c) => {
  try {
    await loadAllData();
    const summary = getDataSummary();
    
    return c.json({
      step: 0,
      title: '데이터 로딩',
      message: '분석에 필요한 내부 데이터를 로딩합니다.',
      summary: {
        priceTable: summary.priceTable,
        vendorQuotes: summary.vendorQuotes,
        performance: summary.performance
      },
      data: {
        priceTable: getPriceTable().slice(0, 100),
        vendorQuotes: getVendorQuotes(),
        performance: getPerformance().slice(0, 100)
      }
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// 전체 데이터 조회 (페이지네이션)
app.get('/api/data/:type', async (c) => {
  const type = c.req.param('type');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;

  await loadAllData();

  let data: any[] = [];
  let total = 0;

  switch (type) {
    case 'priceTable':
      data = getPriceTable();
      break;
    case 'vendorQuotes':
      data = getVendorQuotes();
      break;
    case 'performance':
      data = getPerformance();
      break;
    case 'lme':
      data = getLME();
      break;
    default:
      return c.json({ error: 'Invalid data type' }, 400);
  }

  total = data.length;
  const paginatedData = data.slice(offset, offset + limit);

  return c.json({
    data: paginatedData,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Step 1: 전처리 결과
app.get('/api/step/1', async (c) => {
  await loadAllData();
  const summary = getDataSummary();
  const prItems = generatePRItems();

  return c.json({
    step: 1,
    title: '데이터 전처리',
    message: '데이터 정제 및 연결 작업을 수행합니다.',
    rules: [
      '단가테이블: 밸브타입 정규화, 금액 숫자 변환',
      '발주실적: 밸브타입 코드 추출 (매핑용 키 생성)',
      '협력사 견적: 자재번호 기준 밸브타입 연결',
      'PR 대상 생성: 밸브타입+내역 조합별 대표 건 선정'
    ],
    summary: {
      단가테이블_밸브타입: summary.priceTable.uniqueValveTypes,
      발주실적_유효건수: summary.performance.validValveTypes,
      협력사견적_매핑: `${summary.vendorQuotes.mappedCount}/${summary.vendorQuotes.count}`,
      PR대상_건수: prItems.length
    },
    data: {
      prItems: prItems.slice(0, 100)
    }
  });
});

// Step A-1: 계약단가 기준 추천가 (단가TBL 매핑)
app.get('/api/step/a1', async (c) => {
  await loadAllData();
  const result = executeStepA1();

  return c.json({
    step: 'A-1',
    title: '단가TBL 매핑',
    message: '계약 단가테이블 기준으로 추천 단가를 산출합니다.',
    rules: result.rules,
    summary: result.summary,
    data: result.results
  });
});

// Step A-2: 발주실적 기준 예상가
app.get('/api/step/a2', async (c) => {
  await loadAllData();
  const result = executeStepA2();

  return c.json({
    step: 'A-2',
    title: '발주실적 매핑',
    message: '과거 발주 실적 기준으로 예상 단가를 산출합니다.',
    rules: result.rules,
    summary: result.summary,
    data: result.results
  });
});

// Step B-1: 견적 vs 계약단가
app.get('/api/step/b1', async (c) => {
  await loadAllData();
  const result = executeStepB1();

  return c.json({
    step: 'B-1',
    title: '계약단가 비교',
    message: '협력사 견적을 계약단가 기준으로 검증합니다.',
    rules: result.rules,
    summary: result.summary,
    data: result.results
  });
});

// Step B-1 차이 분석: 견적가 vs 계약총액 차이 원인 분석
app.get('/api/step/b1/analysis', async (c) => {
  await loadAllData();
  const itemNo = c.req.query('no') ? parseInt(c.req.query('no')!) : undefined;
  const result = analyzePriceDifference(itemNo);

  return c.json({
    step: 'B-1 분석',
    title: '견적가-계약총액 차이 원인 분석',
    message: itemNo 
      ? `No.${itemNo} 항목의 견적가와 계약총액 차이 원인을 분석합니다.`
      : `전체 ${result.summary.total}건의 견적가와 계약총액 차이 원인을 분석합니다.`,
    rules: [
      '본체가 = 바디단가-변환(kg당) × 견적중량',
      '옵션가 = N/P + 외부도장 + 내부도장 + LOCK + 기타',
      '계약총액 = 본체가 + 옵션가',
      '차이 = 견적가 - 계약총액'
    ],
    summary: result.summary,
    data: result.results
  });
});

// Step B-2: 견적 vs 발주실적
app.get('/api/step/b2', async (c) => {
  await loadAllData();
  const result = executeStepB2();

  return c.json({
    step: 'B-2',
    title: '발주실적 비교',
    message: '협력사 견적을 과거 발주실적 기준으로 검증합니다.',
    rules: result.rules,
    summary: result.summary,
    data: result.results
  });
});

// Step B-3: 적정성 판정 + AI 분석 통합
app.get('/api/step/b3', async (c) => {
  await loadAllData();
  const result = executeStepB3();

  // AI 코멘트 자동 생성 (샘플링)
  const samples: typeof result.results = [];
  const categories = ['우수', '보통', '부적절', '판단불가'];
  
  for (const cat of categories) {
    const catItems = result.results.filter(r => r.적정성 === cat).slice(0, 3);
    samples.push(...catItems);
  }

  const comments = await generateBatchComments(samples);
  
  // 결과에 AI 코멘트 병합
  const resultsWithAI = result.results.map(row => ({
    ...row,
    AI코멘트: comments.get(row.No) || generateFallbackComment(row)
  }));

  return c.json({
    step: 'B-3',
    title: '적정성 판정 + AI 분석',
    message: '견적가의 적정성을 판정하고 AI 분석 코멘트를 생성합니다.',
    rules: [
      '우수: 협상목표가(최근발주가×90%) 이하',
      '보통: 최근발주가 또는 계약단가 이하',
      '부적절: 최근발주가, 계약단가 모두 초과'
    ],
    summary: result.summary,
    data: resultsWithAI,
    aiSampleCount: samples.length,
    fallbackCount: result.results.length - samples.length
  });
});

// 룰 기반 폴백 코멘트
function generateFallbackComment(row: any): string {
  const { 적정성, 견적가, 최근발주가, 계약단가 } = row;
  
  if (적정성 === '부적절') {
    const basePrice = 최근발주가 > 0 ? 최근발주가 : 계약단가;
    const ratio = basePrice > 0 ? (견적가 / basePrice).toFixed(1) : '?';
    return `견적가가 기준단가 대비 ${ratio}배 높음. 재견적 요청 또는 대안 업체 탐색 권고.`;
  } else if (적정성 === '우수') {
    return `견적가가 협상목표가(90%) 이하로 우수한 가격 수준. 계약 진행 권고.`;
  } else if (적정성 === '보통') {
    return `견적가가 기존 발주 수준과 유사. 수량 조건 협상을 통한 추가 할인 여지 검토 권고.`;
  } else {
    return `비교 데이터 부족. 유사 밸브타입 실적 조회 또는 추가 견적 확보 권고.`;
  }
}

// Step B-4: AI 코멘트 생성 (단건) - Deprecated (B-3에 통합)
app.post('/api/step/b4/single', async (c) => {
  await loadAllData();
  const body = await c.req.json();
  const { No } = body;

  const b3Results = executeStepB3().results;
  const row = b3Results.find(r => r.No === No);

  if (!row) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const comment = await generateItemComment(row);
  
  return c.json({
    No,
    적정성: row.적정성,
    comment
  });
});

// Step B-4: AI 코멘트 생성 (전체) - Deprecated (B-3에 통합)
app.post('/api/step/b4/all', async (c) => {
  return c.redirect('/api/step/b3');
})

// Step C: 시황 분석 + AI 리포트 통합
app.get('/api/step/c', async (c) => {
  await loadAllData();
  const result = executeStepC();
  
  // AI 시황 리포트 자동 생성
  const aiReport = await generateMarketReport(result.lmeData, result.monthlyPrices, result.trendResults);

  return c.json({
    step: 'C',
    title: '시황 분석 + AI 리포트',
    message: '🌐 LME 원자재 시황 데이터를 수집하고 발주가격 트렌드를 분석합니다.',
    targetInfo: result.targetInfo,
    yearSummary: result.yearSummary,
    vendorSummaries: result.vendorSummaries,
    rules: [
      '양호: 시황↑ 단가 유지/하락',
      '적정: 시황과 단가 동일방향',
      '주의: 시황↓ 단가 상승'
    ],
    summary: result.summary,
    monthlyPrices: result.monthlyPrices,
    trendResults: result.trendResults,
    aiReport
  });
});

// Step C-1: AI 시황 종합 리포트 - Deprecated (C에 통합)
app.post('/api/step/c1', async (c) => {
  return c.redirect('/api/step/c');
});

// 최종 Summary
app.get('/api/summary', async (c) => {
  await loadAllData();
  
  const a1 = executeStepA1();
  const a2 = executeStepA2();
  const b3 = executeStepB3();
  const stepC = executeStepC();

  return c.json({
    title: '종합 요약',
    sections: [
      {
        name: 'A-1: 계약단가 기준 추천가',
        summary: a1.summary
      },
      {
        name: 'A-2: 발주실적 기준 예상가',
        summary: a2.summary
      },
      {
        name: 'B-1~3: 협력사 견적 적정성 검증',
        summary: b3.summary
      },
      {
        name: 'C: 시황 대비 가격 적정성',
        summary: stepC.summary
      }
    ]
  });
});

// 서버 시작
const port = parseInt(process.env.PORT || '3000');

console.log('🚀 Starting Valve Pricing AI Agent...');

// 데이터 미리 로딩
loadAllData().then(() => {
  serve({
    fetch: app.fetch,
    port
  }, (info) => {
    console.log(`✅ Server running on http://localhost:${info.port}`);
  });
}).catch(err => {
  console.error('❌ Failed to load data:', err);
  process.exit(1);
});
