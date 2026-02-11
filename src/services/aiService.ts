import { StepB3Result } from './stepB';
import { LMEData, MonthlyVendorPrice, MarketTrendResult } from './stepC';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

interface LLMResponse {
  content: { text: string }[];
}

async function callLLM(prompt: string, systemMsg: string = "You are a procurement analyst expert for shipbuilding valve materials. Always respond in Korean.", maxTokens: number = 500): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    return "[API키 미설정 - 데모 모드] 실제 LLM 연동을 위해 ANTHROPIC_API_KEY 환경변수를 설정해주세요.";
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: 'POST',
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system: systemMsg,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json() as LLMResponse;
    return data.content?.[0]?.text || '[응답 파싱 실패]';
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return `[API 호출 실패: ${errMsg.slice(0, 80)}]`;
  }
}

// 건별 AI 분석 코멘트 생성
export async function generateItemComment(row: StepB3Result): Promise<string> {
  const prompt = `아래 밸브 견적 건에 대해 구매 담당자용 분석 코멘트를 2~3문장으로 작성해줘.
반드시 [판정 사유] + [구체적 수치 비교] + [액션 권고]를 포함해.

- 자재번호: ${row.자재번호}
- 자재내역: ${row.자재내역}
- 견적가: ${row.견적가.toLocaleString()}원
- 계약단가(단가테이블 기반): ${row.계약단가.toLocaleString()}원
- 최근발주가(실적 기반): ${row.최근발주가.toLocaleString()}원
- 협상목표가(90%): ${row.협상목표가.toLocaleString()}원
- 실적 업체: ${row.실적업체 || '없음'}
- 적정성 판정: ${row.적정성}

조건:
- "부적절"이면: 견적가가 얼마나 높은지 배수/% 포함, 재견적 또는 대안 업체 탐색 권고
- "보통"이면: 기존 수준 대비 어떤 위치인지, 수량 협상 여지 언급
- "우수"이면: 긍정 평가와 계약 진행 권고
- 절대 마크다운 사용하지 마. 순수 텍스트만.`;

  return await callLLM(prompt, "You are a procurement analyst expert for shipbuilding valve materials. Always respond in Korean.", 300);
}

// 다건 AI 코멘트 생성 (배치)
export async function generateBatchComments(
  rows: StepB3Result[], 
  onProgress?: (current: number, total: number, result: { No: number; comment: string }) => void
): Promise<Map<number, string>> {
  const comments = new Map<number, string>();
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const comment = await generateItemComment(row);
    comments.set(row.No, comment);
    
    if (onProgress) {
      onProgress(i + 1, rows.length, { No: row.No, comment });
    }
    
    // Rate limiting - 300ms 간격
    if (i < rows.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  return comments;
}

// 시황 종합 분석 리포트 생성
export async function generateMarketReport(
  lmeData: LMEData[],
  monthlyPrices: MonthlyVendorPrice[],
  trendResults: MarketTrendResult[]
): Promise<string> {
  // LME 데이터 요약
  const lmeSummary = lmeData.map(d => 
    `  ${d.연월}: 구리=${d.구리.toLocaleString()} 주석=${d.주석.toLocaleString()} Bronze=${d.Bronze환산.toLocaleString()}`
  ).join('\n');

  // 업체별 단가 요약
  const vendorSummary = monthlyPrices.length > 0 
    ? monthlyPrices.map(p => 
        `  ${p.발주연월} ${p.발주업체}: 평균 ${p.평균단가.toLocaleString()}원 (${p.건수}건)`
      ).join('\n')
    : '데이터 없음';

  // 적정성 분포
  const 양호 = trendResults.filter(r => r.적정성 === '양호').length;
  const 적정 = trendResults.filter(r => r.적정성 === '적정').length;
  const 주의 = trendResults.filter(r => r.적정성 === '주의').length;

  const prompt = `아래 데이터를 종합 분석하여 구매 담당자에게 Bronze Casting 밸브(VGBARR240AT) 시황 분석 리포트를 작성해줘.

[LME Bronze 월별 시세 (USD/톤)]
${lmeSummary}

[업체별 월별 평균 발주단가 (KRW)]
${vendorSummary}

[시황 대비 발주가격 적정성 분포]
양호: ${양호}건, 적정: ${적정}건, 주의: ${주의}건

아래 4가지를 반드시 포함:
1) 원자재 트렌드 요약 (구리/주석/Bronze 방향, 변동폭)
2) 업체별 발주단가 트렌드 vs 시황 비교 핵심 포인트
3) 향후 1~3개월 발주 타이밍 추천 (선발주/대기/분할 등)
4) 업체별 협상 전략 제안

5문장 이내로 간결하게. 마크다운 쓰지 마. 순수 텍스트만.`;

  return await callLLM(prompt, "You are a procurement analyst expert for shipbuilding valve materials. Always respond in Korean.", 500);
}

// API 키 상태 확인
export function checkAPIKey(): { configured: boolean; masked: string } {
  const configured = !!ANTHROPIC_API_KEY;
  const masked = configured 
    ? `${ANTHROPIC_API_KEY.slice(0, 10)}...${ANTHROPIC_API_KEY.slice(-4)}`
    : '미설정';
  return { configured, masked };
}
